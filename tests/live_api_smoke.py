#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""qwenpaw-chat-batch 的「对着跑着的宿主」冒烟测试。

只跑插件真正用到的那几个接口，验证面板里的调用形状是对的：
    GET  /api/chats?include_app_owned=false    列表 + 字段（archived/status/source）
    POST /api/chats/actions/batch-archive      {chat_ids:[…]}
    POST /api/chats/actions/batch-unarchive    {chat_ids:[…]}
    POST /api/chats/batch-delete               裸数组 ["id",…]（写成 {chat_ids} 会被 422 拒）

它会新建一个临时会话（名字带 [qwenpaw-chat-batch][selftest] 前缀，source=subagent），
走完 归档 → 还原 → 删除 一圈后删掉自己建的会话；不碰任何既有会话。

用法：
    python tests/live_api_smoke.py                       # 默认 127.0.0.1:8088，agent=default
    python tests/live_api_smoke.py --base-url http://… --agent-id FTmPQv
只依赖标准库。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

FAILED: list[str] = []


def check(name: str, ok: bool, extra: str = "") -> None:
    print(("  ✅ " if ok else "  ❌ ") + name + (("  " + extra) if extra else ""))
    if not ok:
        FAILED.append(name)


def call(base: str, agent: str, method: str, path: str, body=None):
    """返回 (status, parsed_json_or_text)。4xx/5xx 不抛，交给调用方断言。"""
    url = f"{base.rstrip('/')}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("X-Agent-Id", agent)
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--base-url", default="http://127.0.0.1:8088")
    p.add_argument("--agent-id", default="default")
    args = p.parse_args()
    base, agent = args.base_url, args.agent_id
    print(f"目标 {base}  agent={agent}")

    # ---------- 1. 列表与字段 ----------
    st, chats = call(base, agent, "GET", "/api/chats?include_app_owned=false")
    check("GET /api/chats?include_app_owned=false → 200", st == 200, f"HTTP {st}")
    if st != 200 or not isinstance(chats, list):
        print("列表接口不通，后续无法继续：", str(chats)[:200])
        return 1
    print(f"     会话总数 = {len(chats)}")
    fields = {"id", "name", "session_id", "source", "status", "archived", "created_at", "updated_at"}
    missing = sorted(fields - set(chats[0].keys())) if chats else sorted(fields)
    check("记录含面板依赖的字段", not missing, f"缺 {missing}" if missing else "")
    sources = sorted({c.get("source") for c in chats})
    check("source 取值在面板筛选项内", set(sources) <= {"chat", "cron", "subagent"}, f"{sources}")

    # ---------- 2. 建临时会话 ----------
    stamp = time.strftime("%Y%m%d-%H%M%S")
    payload = {
        "name": f"[qwenpaw-chat-batch][selftest] {stamp}",
        "session_id": f"console:chat-batch-selftest-{stamp}",
        "user_id": "default",
        "channel": "console",
        "source": "subagent",
    }
    st, created = call(base, agent, "POST", "/api/chats", payload)
    check("POST /api/chats → 200/201 建出临时会话", st in (200, 201), f"HTTP {st} {str(created)[:160]}")
    if st not in (200, 201):
        return 1
    cid = created["id"]
    print(f"     临时会话 id = {cid}（session_id={created['session_id']}）")
    check("新建会话默认未归档、状态非 running", created.get("archived") is False and created.get("status") != "running")

    # ---------- 3. 归档形状：{chat_ids:[…]} ----------
    st, wrong = call(base, agent, "POST", "/api/chats/actions/batch-archive", [cid])
    check("batch-archive 传裸数组会 422（证明 body 必须是 {chat_ids}）", st == 422, f"HTTP {st}")

    st, res = call(base, agent, "POST", "/api/chats/actions/batch-archive", {"chat_ids": [cid]})
    check("batch-archive {chat_ids:[…]} → 200 且 succeeded 命中", st == 200 and res.get("succeeded") == [cid], f"HTTP {st} {res}")

    st, chats = call(base, agent, "GET", "/api/chats")
    after = {c["id"]: c for c in chats}.get(cid, {})
    check("归档后 archived = true（服务端事实）", after.get("archived") is True, f"archived={after.get('archived')}")

    # ---------- 4. 还原 ----------
    st, res = call(base, agent, "POST", "/api/chats/actions/batch-unarchive", {"chat_ids": [cid]})
    check("batch-unarchive → 200 且 succeeded 命中", st == 200 and res.get("succeeded") == [cid], f"HTTP {st} {res}")
    st, chats = call(base, agent, "GET", "/api/chats")
    after = {c["id"]: c for c in chats}.get(cid, {})
    check("还原后 archived = false", after.get("archived") is False, f"archived={after.get('archived')}")

    # ---------- 5. 删除形状：裸数组 ----------
    st, wrong = call(base, agent, "POST", "/api/chats/batch-delete", {"chat_ids": [cid]})
    check("batch-delete 传 {chat_ids} 会 422（证明必须是裸数组）", st == 422, f"HTTP {st}")

    st, res = call(base, agent, "POST", "/api/chats/batch-delete", [cid])
    check("batch-delete 裸数组 → 200", st == 200, f"HTTP {st} {res}")
    check("batch-delete 只回布尔、不回条数（所以面板改用 diff 报数）", isinstance(res, dict) and isinstance(res.get("deleted"), bool), f"{res}")

    st, chats = call(base, agent, "GET", "/api/chats")
    gone = cid not in {c["id"] for c in chats}
    check("删除后列表里确实没有了", gone)

    # ---------- 6. 收尾 ----------
    st, res = call(base, agent, "POST", "/api/chats/batch-delete", [cid])
    check("重复删除不报错（幂等，返回 deleted=false）", st == 200 and res.get("deleted") is False, f"HTTP {st} {res}")

    print()
    if FAILED:
        print(f"❌ {len(FAILED)} 项未通过：" + "; ".join(FAILED))
        return 1
    print("✅ 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
