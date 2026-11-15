# -*- coding: utf-8 -*-
"""
qwenpaw-chat-batch 后端（v0.1.0）：已删除会话扫描 + 恢复。

宿主删除会话时只摘掉 ``chats.json`` 里的注册条目（并删除 checkpoint），
``sessions/<channel>/<user>_<sid>.json`` 里的对话本体仍然留在磁盘上。
本模块把这种「文件在 / 注册没了」的会话列出来，并支持把注册条目补回去。

接口（挂载于 /api/qwenpaw-chat-batch/）：
  GET  /orphans?refresh=0   扫描并分类：recoverable / empty / lost
  POST /restore             {"items":[{session_id,user_id,channel,name}]} 逐条恢复

判据：
  - 注册集     chat_manager.list_chats(archived=None)
  - 文件集     workspace_dir/sessions/**/*.json（含 channel 子目录与顶层文件）
  - session_id 优先取 sessions/.synced.json 的 path -> session_id 映射，
               其次按文件名正则（chat 型 ``\\d{13}-[a-z0-9]+``），最后按首个下划线切
  - 空壳       状态文件里 agent.state.context 为空

恢复：
  - 校验文件仍存在、context 非空、同一 (session_id,user_id,channel) 未注册
  - 走 chat_manager.get_or_create_chat()：复用宿主的锁、分组派生与原子写，
    不手写 chats.json、不自造 uuid。
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

PLUGIN_ID = "qwenpaw-chat-batch"
PLUGIN_VERSION = "0.1.0"
ROUTE_PREFIX = "/qwenpaw-chat-batch"

router = APIRouter()

# 与 app/chats/session.py::sanitize_filename 一致（Windows 非法字符 -> "--"）
_UNSAFE_FILENAME_RE = re.compile(r'[\\/:*?"<>|]')
_CHAT_SID_RE = re.compile(r"(\d{13}-[a-z0-9]{6,})$")
def _sanitize_filename(name: str) -> str:
    return _UNSAFE_FILENAME_RE.sub("--", name)


def _session_relpath(session_id: str, user_id: str, channel: str) -> str:
    """与 SafeJSONSession._get_save_path 相同的相对路径（POSIX 分隔）。"""
    safe_sid = _sanitize_filename(session_id)
    safe_uid = _sanitize_filename(user_id) if user_id else ""
    if safe_uid and safe_uid == safe_sid:
        safe_uid = ""
    filename = f"{safe_uid}_{safe_sid}.json" if safe_uid else f"{safe_sid}.json"
    safe_channel = _sanitize_filename(channel) if channel else ""
    return f"{safe_channel}/{filename}" if safe_channel else filename


async def _workspace(request: Request) -> Any:
    """按 X-Agent-Id 取工作区（与宿主的 agent 级路由同一入口）。"""
    manager = getattr(request.app.state, "multi_agent_manager", None)
    if manager is None:
        raise HTTPException(status_code=503, detail="MultiAgentManager 未初始化")
    agent_id = request.headers.get("X-Agent-Id") or "default"
    try:
        workspace = await manager.get_agent(agent_id)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=404, detail=f"Agent 不存在: {agent_id}") from exc
    if workspace is None:
        raise HTTPException(status_code=404, detail=f"Agent 不存在: {agent_id}")
    return workspace


# --------------------------------------------------------------------------
# 扫描
# --------------------------------------------------------------------------

# path -> (mtime, size, messages, first_text)；文件没变就不重复解析
_FILE_CACHE: Dict[str, Tuple[float, int, int, str]] = {}
_CACHE_LOCK = threading.Lock()


def _first_user_text(context: List[Any]) -> str:
    for msg in context:
        if not isinstance(msg, dict) or msg.get("role") != "user":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and isinstance(block.get("text"), str):
                    if block["text"].strip():
                        return block["text"].strip()
        elif isinstance(content, dict) and isinstance(content.get("text"), str):
            return content["text"].strip()
    return ""


def _read_session_meta(path: Path) -> Tuple[int, str]:
    """返回 (消息条数, 首条用户消息)。解析失败返回 (-1, "")。"""
    try:
        stat = path.stat()
    except OSError:
        return -1, ""
    key = str(path)
    with _CACHE_LOCK:
        hit = _FILE_CACHE.get(key)
    if hit and hit[0] == stat.st_mtime and hit[1] == stat.st_size:
        return hit[2], hit[3]
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        state = ((data.get("agent") or {}).get("state") or {})
        context = state.get("context")
        if not isinstance(context, list):
            context = []
        messages = len(context)
        first = _first_user_text(context)
    except (OSError, ValueError, UnicodeDecodeError):
        messages, first = -1, ""
    with _CACHE_LOCK:
        _FILE_CACHE[key] = (stat.st_mtime, stat.st_size, messages, first)
    return messages, first


def _load_synced(sessions_dir: Path) -> Dict[str, str]:
    """sessions/.synced.json：相对路径 -> session_id（宿主自己记的，最可信）。"""
    path = sessions_dir / ".synced.json"
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    files = raw.get("files") if isinstance(raw, dict) else None
    out: Dict[str, str] = {}
    if isinstance(files, dict):
        for rel, meta in files.items():
            if isinstance(meta, dict) and isinstance(meta.get("session_id"), str):
                out[str(rel)] = meta["session_id"]
    return out


def _split_relpath(rel: str, synced: Optional[str]) -> Optional[Tuple[str, str, str]]:
    """相对路径 -> (channel, user_id, session_id)；无法可靠拆分时返回 None。"""
    parts = rel.split("/")
    channel = parts[0] if len(parts) >= 2 else ""
    filename = parts[-1]
    if not filename.endswith(".json"):
        return None
    stem = filename[: -len(".json")]

    candidates: List[str] = []
    if synced:
        candidates.append(synced)
    match = _CHAT_SID_RE.search(stem)
    if match:
        candidates.append(match.group(1))
    for sid in candidates:
        tail = "_" + _sanitize_filename(sid)
        if stem == _sanitize_filename(sid):
            return channel, "", sid
        if stem.endswith(tail) and len(stem) > len(tail):
            return channel, stem[: -len(tail)], sid
    return None


def _infer_source(session_id: str) -> str:
    if session_id.startswith("sub-"):
        return "subagent"
    if session_id.startswith("cron"):
        return "cron"
    return "chat"


def _scan_workspace(workspace: Any) -> Dict[str, Any]:
    """扫描一个工作区，返回 {counts, items, scanned_at, workspace}。"""
    workspace_dir = Path(workspace.workspace_dir)
    sessions_dir = workspace_dir / "sessions"
    chats_file = workspace_dir / "chats.json"

    registered: List[Any] = []
    chats_file_mtime = 0.0
    if chats_file.is_file():
        chats_file_mtime = chats_file.stat().st_mtime
    try:
        raw = json.loads(chats_file.read_text(encoding="utf-8")) if chats_file.is_file() else {}
        registered = list(raw.get("chats") or [])
    except (OSError, ValueError):
        registered = []

    by_sid: Dict[str, Dict[str, Any]] = {}
    registered_keys = set()
    for chat in registered:
        sid = str(chat.get("session_id") or "")
        if not sid:
            continue
        registered_keys.add((sid, str(chat.get("user_id") or ""), str(chat.get("channel") or "")))
        by_sid.setdefault(sid, chat)

    files: Dict[str, Tuple[str, str, str]] = {}
    if sessions_dir.is_dir():
        synced_map = _load_synced(sessions_dir)
        for dirpath, _dirnames, filenames in os.walk(sessions_dir):
            for name in filenames:
                if not name.endswith(".json") or name == ".synced.json":
                    continue
                full = Path(dirpath) / name
                rel = full.relative_to(sessions_dir).as_posix()
                split = _split_relpath(rel, synced_map.get(rel))
                if split is None:
                    continue
                sid = split[2]
                current = files.get(sid)
                if current is None:
                    files[sid] = (str(full), split[0], split[1])
                    continue
                # 同一 session 有多个文件（例如顶层遗留 + channel 目录）时保留消息更多的那个
                if _read_session_meta(Path(full))[0] > _read_session_meta(Path(current[0]))[0]:
                    files[sid] = (str(full), split[0], split[1])

    synced_by_sid: Dict[str, int] = {}
    try:
        raw_synced = json.loads((sessions_dir / ".synced.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw_synced = {}
    for _rel, meta in (raw_synced.get("files") or {}).items():
        if not isinstance(meta, dict):
            continue
        sid = meta.get("session_id")
        count = meta.get("messages")
        if isinstance(sid, str) and isinstance(count, int):
            synced_by_sid[sid] = max(synced_by_sid.get(sid, 0), count)

    items: List[Dict[str, Any]] = []
    for sid, (full, channel, user_id) in files.items():
        if sid in by_sid:
            continue  # 已注册，不是「已删除」
        messages, first_text = _read_session_meta(Path(full))
        try:
            mtime = datetime.fromtimestamp(Path(full).stat().st_mtime, tz=timezone.utc).isoformat()
        except OSError:
            mtime = ""
        name = (first_text or "").replace("\n", " ").strip()
        if name:
            name = name[:60]
        else:
            name = f"恢复的会话 {sid}"
        if messages > 0:
            state = "recoverable"
            reason = ""
        elif messages == 0:
            state = "empty"
            reason = "empty_session"
        else:
            state = "unreadable"
            reason = "unreadable"
        items.append(
            {
                "session_id": sid,
                "user_id": user_id,
                "channel": channel,
                "name": name,
                "messages": max(messages, 0),
                "mtime": mtime,
                "source": _infer_source(sid),
                "state": state,
                "reason": reason,
                "restorable": state == "recoverable",
            },
        )

    for sid, chat in by_sid.items():
        if sid in files:
            continue
        name = str(chat.get("name") or "") or sid
        items.append(
            {
                "session_id": sid,
                "user_id": str(chat.get("user_id") or ""),
                "channel": str(chat.get("channel") or ""),
                "name": name,
                "messages": int(synced_by_sid.get(sid, 0) or 0),
                "mtime": str(chat.get("updated_at") or chat.get("created_at") or ""),
                "source": str(chat.get("source") or "chat"),
                "state": "lost",
                "reason": "session_file_missing",
                "restorable": False,
            },
        )

    order = {"recoverable": 0, "empty": 1, "unreadable": 2, "lost": 3}
    items.sort(key=lambda it: (order.get(it["state"], 9), -int(it.get("messages") or 0), it.get("mtime") or ""))

    counts = {"recoverable": 0, "empty": 0, "unreadable": 0, "lost": 0}
    for item in items:
        counts[item["state"]] = counts.get(item["state"], 0) + 1

    logger.info(
        "[%s] scanned %s: %s sessions, %s chats",
        PLUGIN_ID,
        workspace_dir,
        len(files),
        len(registered),
    )
    return {
        "counts": counts,
        "items": items,
        "scanned_at": datetime.now(tz=timezone.utc).isoformat(),
        "workspace": str(workspace_dir),
        "chats_file_mtime": chats_file_mtime,
    }


# --------------------------------------------------------------------------
# 接口
# --------------------------------------------------------------------------


@router.get("/orphans")
async def list_orphans(request: Request, refresh: int = 0) -> Dict[str, Any]:
    """列出「已删除」会话（文件在、注册没了）以及「已丢失」（注册在、文件没了）。"""
    workspace = await _workspace(request)
    if refresh:
        with _CACHE_LOCK:
            _FILE_CACHE.clear()
    return _scan_workspace(workspace)


class RestoreItem(BaseModel):
    """一条待恢复的会话。"""

    session_id: str = Field(..., min_length=1)
    user_id: str = ""
    channel: str = ""
    name: str = ""


class RestorePayload(BaseModel):
    """恢复请求体。"""

    items: List[RestoreItem] = Field(default_factory=list)


@router.post("/restore")
async def restore(payload: RestorePayload, request: Request) -> Dict[str, Any]:
    """按 (session_id, user_id, channel) 补回注册条目。"""
    if not payload.items:
        return {"restored": [], "failed": []}
    workspace = await _workspace(request)
    sessions_dir = Path(workspace.workspace_dir) / "sessions"
    manager = workspace.chat_manager

    existing = await manager.list_chats(archived=None)
    registered = {(c.session_id, c.user_id, c.channel) for c in existing}
    group_ids = set()
    try:
        group_ids = {g.id for g in await manager.list_groups()}
    except Exception:  # noqa: BLE001 - 分组接口异常不应阻断恢复
        logger.warning("[%s] list_groups failed", PLUGIN_ID, exc_info=True)

    restored: List[Dict[str, Any]] = []
    failed: List[Dict[str, Any]] = []
    for item in payload.items:
        sid = item.session_id
        uid = item.user_id
        channel = item.channel
        relpath = _session_relpath(sid, uid, channel)
        full = sessions_dir / relpath
        if not full.is_file():
            failed.append({"session_id": sid, "reason": "session_file_missing"})
            continue
        if (sid, uid, channel) in registered:
            failed.append({"session_id": sid, "reason": "already_registered"})
            continue
        messages, first_text = _read_session_meta(full)
        if messages <= 0:
            failed.append({"session_id": sid, "reason": "empty_session"})
            continue

        name = (item.name or "").strip() or (first_text[:60] if first_text else "") or f"恢复的会话 {sid}"
        source = _infer_source(sid)
        default_group = {"chat": "default", "cron": "cron", "subagent": "subagents"}.get(source, "default")
        if group_ids and default_group not in group_ids:
            source, default_group = "chat", "default"
        try:
            chat = await manager.get_or_create_chat(
                session_id=sid,
                user_id=uid,
                channel=channel,
                name=name,
                source=source,
                group_id=default_group if default_group in group_ids else None,
            )
        except Exception as exc:  # noqa: BLE001 - 逐条失败不打断整批
            logger.warning("[%s] restore %s failed: %s", PLUGIN_ID, sid, exc, exc_info=True)
            failed.append({"session_id": sid, "reason": "error", "message": str(exc)})
            continue

        registered.add((sid, uid, channel))
        restored.append(
            {
                "session_id": sid,
                "chat_id": chat.id,
                "name": chat.name,
                "channel": chat.channel,
                "messages": messages,
            },
        )
        logger.info("[%s] restored %s -> chat %s", PLUGIN_ID, sid, chat.id)

    return {"restored": restored, "failed": failed}


# --------------------------------------------------------------------------
# 插件入口（legacy PluginApi：api.register_http_router）
# --------------------------------------------------------------------------


class ChatBatchPlugin:
    """插件定义：只注册一个 HTTP 路由。"""

    name = "会话批量管理"
    version = PLUGIN_VERSION
    id = PLUGIN_ID
    router = router

    def register(self, api: Any) -> None:
        """注册后端路由。"""
        if hasattr(api, "register_http_router"):
            api.register_http_router(router, prefix=ROUTE_PREFIX, tags=[PLUGIN_ID])
            logger.info("[%s] HTTP router registered at /api%s", PLUGIN_ID, ROUTE_PREFIX)


plugin = ChatBatchPlugin()
