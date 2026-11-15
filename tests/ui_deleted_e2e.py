#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""「已删除」视图的界面端到端测试（真浏览器 + 真宿主 + 真后端路由）。

流程：
    打开面板 → 切到「已删除」→ 核对计数与后端一致 → 确认底部只剩「恢复」
    → 不可恢复的条目全部禁用 → 选中一条可恢复的 → 点「恢复」→ 独立通道核对
    注册条目真的回来了、点进去有消息 → 回滚（删掉注册条目）→ 计数复原

副作用：会把一条**本来就已删除**的会话临时注册回来，结束时再删掉，回到原状。
用法：python tests/ui_deleted_e2e.py [--headed] [--shots DIR]
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time
import urllib.error
import urllib.request

FAILED: list[str] = []
TARGET = ""          # 用哪条已删除会话做恢复验证
RESTORED_ID = ""


def check(name: str, ok: bool, extra: str = "") -> None:
    print(("  ✅ " if ok else "  ❌ ") + name + (("  " + extra) if extra else ""))
    if not ok:
        FAILED.append(name)


def api(base: str, agent: str, method: str, path: str, body=None):
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
        return e.code, e.read().decode(errors="replace")


def chromium_path(pw):
    try:
        p = pw.chromium.executable_path
        if p and os.path.exists(p):
            return p
    except Exception:
        pass
    for cand in sorted(glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome")), reverse=True):
        if os.path.exists(cand):
            return cand
    return None


def main() -> int:
    global TARGET, RESTORED_ID
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8088")
    ap.add_argument("--agent-id", default="default")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--shots", default="")
    args = ap.parse_args()
    base, agent = args.base_url.rstrip("/"), args.agent_id

    st, before = api(base, agent, "GET", "/api/qwenpaw-chat-batch/orphans?refresh=1")
    if st != 200:
        print(f"后端不可用 HTTP {st}: {before}")
        return 1
    counts = before["counts"]
    print(f"扫描结果 {counts}")
    rec = [i for i in before["items"] if i["state"] == "recoverable"]
    if not rec:
        print("没有可恢复的条目，无法测试")
        return 2
    TARGET = max(rec, key=lambda i: i["messages"])["session_id"]

    from playwright.sync_api import sync_playwright

    def shot(page, name):
        if args.shots:
            os.makedirs(args.shots, exist_ok=True)
            page.screenshot(path=os.path.join(args.shots, name + ".png"))

    try:
        with sync_playwright() as pw:
            exe = chromium_path(pw)
            if not exe:
                print("找不到 chromium")
                return 2
            browser = pw.chromium.launch(executable_path=exe, headless=not args.headed, args=["--no-sandbox"])
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.goto(base + "/", wait_until="networkidle", timeout=90000)
            page.wait_for_function("!!(window.__qwenpawChatBatch)", timeout=60000)
            page.evaluate("window.__qwenpawChatBatch.open()")
            page.wait_for_selector(".qcb-panel", timeout=15000)

            # 切到「已删除」
            page.click('.qcb-seg button:has-text("已删除")')
            page.wait_for_selector(".qcb-hint", timeout=30000)
            page.wait_for_function("window.__qwenpawChatBatch.deleted().length > 0", timeout=60000)
            shot(page, "01-deleted")

            hint = page.inner_text(".qcb-hint")
            check(
                "提示行计数与后端一致",
                f"可恢复 {counts['recoverable']}" in hint and f"已丢失 {counts['lost']}" in hint,
                hint,
            )

            visible_btns = page.evaluate(
                """() => Array.from(document.querySelectorAll('.qcb-foot button'))
                     .filter(b => b.style.display !== 'none')
                     .map(b => b.textContent.trim())"""
            )
            check("底部只剩一个「恢复」按钮", len(visible_btns) == 1 and visible_btns[0].startswith("恢复"), str(visible_btns))

            stats = page.evaluate(
                """() => {
                  const rows = Array.from(document.querySelectorAll('.qcb-row'));
                  return {
                    rows: rows.length,
                    disabled: rows.filter(r => r.getAttribute('data-disabled') === 'true').length,
                    enabled: rows.filter(r => r.getAttribute('data-disabled') === 'false').length,
                  };
                }"""
            )
            check("不可恢复的条目全部不可勾选", stats["disabled"] == counts["lost"], json.dumps(stats))
            check("可恢复的条目可勾选", stats["enabled"] > 0, json.dumps(stats))

            page.evaluate(f"window.__qwenpawChatBatch.setDeletedSelected('{TARGET}', true)")
            btn = page.evaluate(
                """() => { const b = document.querySelector('.qcb-foot button[data-act=restore]');
                           return {text: b.textContent.trim(), disabled: b.disabled}; }"""
            )
            check("选中 1 条后「恢复 1」可用", btn["text"] == "恢复 1" and not btn["disabled"], json.dumps(btn))

            page.click('.qcb-foot button[data-act="restore"]')
            # 面板已无提示行：以「该条从已删除列表消失」+ 服务端事实为准
            gone_ok = page.wait_for_function(
                f"() => !document.querySelector('.qcb-row[data-id=\"{TARGET}\"]')",
                timeout=60000,
            )
            shot(page, "02-restored")

            st, chats = api(base, agent, "GET", "/api/chats?include_app_owned=false")
            hit = [c for c in chats if c.get("session_id") == TARGET] if st == 200 else []
            check("独立通道：注册条目真的回来了", len(hit) == 1, f"session_id={TARGET}")
            RESTORED_ID = hit[0]["id"] if hit else ""
            if RESTORED_ID:
                st, detail = api(base, agent, "GET", f"/api/chats/{RESTORED_ID}")
                check("点进去不是空白", st == 200 and len(detail.get("messages") or []) > 0, f"messages={len((detail or {}).get('messages') or [])}")

            gone = page.evaluate(f"!!document.querySelector('.qcb-row[data-id=\"{TARGET}\"]')")
            check("恢复后该条从「已删除」列表消失", not gone)

            # 回滚：删掉注册条目，回到「已删除」原状
            if RESTORED_ID:
                api(base, agent, "DELETE", f"/api/chats/{RESTORED_ID}")
                RESTORED_ID = ""
            st, after = api(base, agent, "GET", "/api/qwenpaw-chat-batch/orphans?refresh=1")
            check("回滚后计数复原", st == 200 and after["counts"] == counts, json.dumps(after.get("counts") if st == 200 else after))
    finally:
        if RESTORED_ID:
            api(base, agent, "DELETE", f"/api/chats/{RESTORED_ID}")

    print()
    if FAILED:
        print(f"❌ {len(FAILED)} 项未通过：" + "、".join(FAILED))
        return 1
    print("✅ 已删除视图端到端通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
