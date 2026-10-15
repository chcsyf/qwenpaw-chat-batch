#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""qwenpaw-chat-batch 的界面端到端测试（真浏览器 + 真宿主 + 真 API）。

做法：把插件脚本注入到**正在跑的 QwenPaw 控制台页面**里（不安装进插件目录，
刷新即无痕），然后像用户一样点按钮走完整流程：

    打开面板 → 关键字筛选 → 「保留最近 1 个」规则选中其余 → 归档 → 切到已归档
    → 全选筛选结果 → 还原 → 全选 → 删除（确认框里勾「我已确认」）

每一步的最终结果都用**独立通道**（Python 直接打 HTTP API）核对，不信 UI 的自述。

副作用：会新建 3 个临时会话（名称带 [qwenpaw-chat-batch][selftest]），结束时无论
成功失败都会把它们删掉（finally 里兜底清理成 0）。

依赖：playwright（Python）+ 本机 qwenpaw 在跑。

用法：
    python tests/ui_e2e.py                       # 默认 http://127.0.0.1:8088，agent=default
    python tests/ui_e2e.py --headed --shots /tmp/qcb-shots
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
CREATED: list[str] = []

MARK = "[qwenpaw-chat-batch][selftest]"


def check(name: str, ok: bool, extra: str = "") -> None:
    print(("  ✅ " if ok else "  ❌ ") + name + (("  " + extra) if extra else ""))
    if not ok:
        FAILED.append(name)


def api(base: str, agent: str, method: str, path: str, body=None):
    """独立通道：不经过浏览器，直接调宿主 HTTP API。"""
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


def mine(base: str, agent: str) -> list[dict]:
    st, chats = api(base, agent, "GET", "/api/chats")
    if st != 200:
        raise RuntimeError(f"GET /api/chats -> HTTP {st}: {chats}")
    return [c for c in chats if MARK in (c.get("name") or "")]


def cleanup(base: str, agent: str) -> None:
    ids = [c["id"] for c in mine(base, agent)]
    if ids:
        api(base, agent, "POST", "/api/chats/batch-delete", ids)
    left = len(mine(base, agent))
    print(("  ✅ " if left == 0 else "  ❌ ") + f"收尾清理：临时会话剩余 {left} 个")
    if left:
        FAILED.append("cleanup")


def chromium_path(pw):
    """用已安装的 chromium（playwright 期望的版本目录可能没下，就找现成的）。"""
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
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8088")
    ap.add_argument("--agent-id", default="default")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--shots", default="")
    ap.add_argument(
        "--installed",
        action="store_true",
        help="不注入脚本，改为验证「已通过 qwenpaw plugin install 安装」的那一份（默认：注入源码）",
    )
    args = ap.parse_args()
    base, agent = args.base_url.rstrip("/"), args.agent_id
    here = os.path.dirname(os.path.abspath(__file__))
    plugin_js = os.path.join(os.path.dirname(here), "index.js")
    print(f"目标 {base}  agent={agent}\n插件脚本 {plugin_js}")

    from playwright.sync_api import sync_playwright

    def shot(page, name):
        if not args.shots:
            return
        os.makedirs(args.shots, exist_ok=True)
        page.screenshot(path=os.path.join(args.shots, name + ".png"), full_page=False)

    ok_all = True
    try:
        with sync_playwright() as pw:
            exe = chromium_path(pw)
            if not exe:
                print("找不到 chromium，跳过界面测试")
                return 2
            browser = pw.chromium.launch(executable_path=exe, headless=not args.headed, args=["--no-sandbox"])
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.goto(base + "/", wait_until="networkidle", timeout=90000)
            page.wait_for_function("!!(window.QwenPaw && window.QwenPaw.slot && window.QwenPaw.host && window.QwenPaw.host.React)", timeout=60000)
            page.wait_for_timeout(1500)

            # ---------- 0. 造 3 个临时会话（独立通道） ----------
            stamp = time.strftime("%Y%m%d-%H%M%S")
            for i in (1, 2, 3):
                st, created = api(base, agent, "POST", "/api/chats", {
                    "name": f"{MARK} {stamp} #{i}",
                    "session_id": f"console:qcb-e2e-{stamp}-{i}",
                    "user_id": "default",
                    "channel": "console",
                    "source": "subagent",
                })
                if st not in (200, 201):
                    print(f"建临时会话失败 HTTP {st}: {created}")
                    return 1
                CREATED.append(created["id"])
            check("准备：建出 3 个临时会话", len(mine(base, agent)) == 3, f"id={[c[:8] for c in CREATED]}")

            # ---------- 1. 插件加载（注入源码 / 或已安装的自动加载） ----------
            if args.installed:
                check("已安装的插件随页面自动加载（未注入任何脚本）", page.evaluate("!!window.__qwenpawChatBatch"))
                check("侧栏历史操作行自动出现入口按钮", page.is_visible(".qcb-inline-btn"))
                served = page.evaluate(
                    """fetch('/api/frontend_plugin').then(r=>r.json()).then(
                        d => JSON.stringify(d).includes('qwenpaw-chat-batch'))"""
                )
                check("宿主接口 /api/frontend_plugin 里登记了本插件", bool(served))
            else:
                # 注入模式：如果这台机器已经装了本插件，页面里会先跑着安装版，
                # 再注入一份源码会两个实例打架（按钮/样式互相盖），所以直接说清楚。
                already = page.evaluate("!!window.__qwenpawChatBatch")
                if already:
                    print("  ℹ️  检测到已安装的副本在跑：本次按「已安装版」验证（要测未安装场景请先 uninstall）")
                    check("已安装副本随页面加载", True)
                else:
                    page.add_script_tag(path=plugin_js)
                page.wait_for_selector(".qcb-inline-btn", timeout=15000)
                check("插件生效后，侧栏出现入口按钮", page.is_visible(".qcb-inline-btn"))

            # ---------- 1a. 入口位置：在侧栏「历史对话」的操作行里，且不新占一行 ----------
            geo = page.evaluate(
                """() => {
                  const row = document.querySelector('[class*="sidebarSessionList-module__historyActions"]');
                  const btn = document.querySelector('.qcb-inline-btn');
                  const host = row ? row.querySelector('button:not(.qcb-inline-btn)') : null;
                  const r = row && row.getBoundingClientRect(), b = btn && btn.getBoundingClientRect();
                  const h = host && host.getBoundingClientRect();
                  return {
                    inRow: !!(row && btn && row.contains(btn)),
                    rowH: r && r.height, btnW: b && b.width, btnH: b && b.height,
                    hostW: h && h.width, hostH: h && h.height,
                    sameLine: !!(b && r && b.top >= r.top - 2 && b.bottom <= r.bottom + 2),
                    headerHasMine: !!document.querySelector('header .qcb-inline-btn, [class*="topBar"] .qcb-inline-btn'),
                  };
                }"""
            )
            check("入口按钮挂在 sidebarSessionList 的历史操作行内", geo["inRow"], f"{geo}")
            check("没有塞进顶栏（原来的位置已让出）", not geo["headerHasMine"])
            check("与宿主图标按钮同尺寸、在同一行内（不新占一行）", geo["sameLine"] and geo["btnH"] == geo["hostH"], f"按钮 {geo['btnW']}×{geo['btnH']} vs 宿主 {geo['hostW']}×{geo['hostH']}，行高 {geo['rowH']}")

            # ---------- 1b. 语言跟随宿主（这台是中文），中英切换都出得来 ----------
            page.click(".qcb-inline-btn")
            page.wait_for_selector(".qcb-panel", timeout=10000)
            page.wait_for_timeout(500)
            anchored = page.evaluate(
                """() => {
                  const b = document.querySelector('.qcb-inline-btn').getBoundingClientRect();
                  const p = document.querySelector('.qcb-panel').getBoundingClientRect();
                  return {below: p.top >= b.bottom, gap: Math.round(p.top - b.bottom),
                          overlapX: Math.min(b.right, p.right) - Math.max(b.left, p.left)};
                }"""
            )
            check("面板贴着入口按钮展开（在按钮下方且横向有交集）", anchored["below"] and anchored["overlapX"] > 0, f"{anchored}")
            zh_keep = page.eval_on_selector(".qcb-quick button", "el => el.textContent.trim()")
            check("文案自动跟随宿主语言（中文界面 → 中文按钮）", zh_keep == "保留最近", f"实际 = {zh_keep!r}")
            page.evaluate("window.__qwenpawChatBatch.setLang(false)")
            page.wait_for_timeout(200)
            en_keep = page.eval_on_selector(".qcb-quick button", "el => el.textContent.trim()")
            check("切到英文后按钮文案变英文", en_keep == "Keep recent", f"实际 = {en_keep!r}")
            page.evaluate("window.__qwenpawChatBatch.setLang(true)")
            page.wait_for_timeout(200)
            check("切回中文", page.eval_on_selector(".qcb-quick button", "el => el.textContent.trim()") == "保留最近")

            # ---------- 2. 打开面板 ----------
            page.wait_for_selector(".qcb-panel", timeout=10000)
            page.wait_for_function("document.querySelectorAll('.qcb-row').length >= 3", timeout=20000)
            total_rows = page.eval_on_selector_all(".qcb-row", "els => els.length")
            check("面板打开并列出会话（活跃视图）", total_rows >= 3, f"本页行数={total_rows}")
            check("面板能读到当前会话路由", page.evaluate("window.__qwenpawChatBatch.state.currentChatId !== undefined"))

            # ---------- 3. 关键字筛选 ----------
            page.fill(".qcb-filters input[type=text]", "qcb-e2e-" + stamp)
            page.wait_for_function("document.querySelectorAll('.qcb-row').length === 3", timeout=10000)
            rows = page.eval_on_selector_all(".qcb-row .qcb-name", "els => els.map(e => e.textContent.trim())")
            check("关键字筛选命中我的 3 个临时会话", len(rows) == 3 and all(MARK in r for r in rows), f"{[r[:28] for r in rows]}")
            shot(page, "1-filtered")

            # ---------- 4. 规则「保留最近 1 个，其余全选」 ----------
            page.fill(".qcb-quick input[type=number]", "1")
            page.click(".qcb-quick button:has-text('保留最近')")
            page.wait_for_timeout(300)
            sel = page.eval_on_selector_all(".qcb-row[data-sel=true]", "els => els.length")
            foot = page.inner_text(".qcb-foot .qcb-count")
            check("「保留最近 1 个」选中其余 2 个", sel == 2, f"选中的行={sel}；脚注={foot}")
            check("脚注只把可归档的算进归档数", "可归档 2" in foot, foot)
            shot(page, "2-selected")

            # ---------- 5. 归档（真实点击 → 服务端核对） ----------
            page.click(".qcb-foot button[data-act=archive]")
            page.wait_for_function("document.querySelector('.qcb-msg').textContent.includes('归档完成')", timeout=30000)
            msg = page.inner_text(".qcb-msg")
            archived = [c for c in mine(base, agent) if c.get("archived")]
            check("归档完成提示如实", "成功 2" in msg and "失败 0" in msg, msg)
            check("服务端事实：恰好 2 个临时会话已归档", len(archived) == 2, f"archived={len(archived)}")

            # ---------- 6. 切到已归档 → 全选 → 还原 ----------
            page.click(".qcb-seg button:has-text('已归档')")
            page.wait_for_function("document.querySelectorAll('.qcb-row').length === 2", timeout=10000)
            page.click(".qcb-quick button:has-text('全选筛选结果')")
            page.wait_for_timeout(200)
            page.click(".qcb-foot button[data-act=unarchive]")
            page.wait_for_function("document.querySelector('.qcb-msg').textContent.includes('还原完成')", timeout=30000)
            msg = page.inner_text(".qcb-msg")
            archived = [c for c in mine(base, agent) if c.get("archived")]
            check("还原完成提示如实", "成功 2" in msg, msg)
            check("服务端事实：临时会话已全部还原", len(archived) == 0, f"archived={len(archived)}")

            # ---------- 7. 删除：确认框 + 必勾确认 ----------
            page.click(".qcb-seg button:has-text('活跃')")
            page.wait_for_function("document.querySelectorAll('.qcb-row').length === 3", timeout=10000)
            page.click(".qcb-quick button:has-text('全选筛选结果')")
            page.wait_for_timeout(200)
            page.click(".qcb-foot button[data-act=delete]")
            page.wait_for_selector(".qcb-confirm", timeout=10000)
            shot(page, "3-confirm")
            ok_btn = page.query_selector(".qcb-confirm .qcb-acts button[data-primary=true]")
            check("未勾「我已确认」时确认按钮是禁用的（防误删）", ok_btn.is_disabled())
            boxes = page.query_selector_all(".qcb-confirm input[type=checkbox]")
            boxes[-1].check()  # 最后一个 = 「我已确认」
            page.wait_for_timeout(200)
            check("勾选确认后按钮可用", not page.query_selector(".qcb-confirm .qcb-acts button[data-primary=true]").is_disabled())
            page.click(".qcb-confirm .qcb-acts button[data-primary=true]")
            page.wait_for_function("document.querySelector('.qcb-msg').textContent.includes('删除完成')", timeout=30000)
            msg = page.inner_text(".qcb-msg")
            check("删除完成提示如实（diff 报数）", "已删除 3 / 3" in msg, msg)
            check("服务端事实：3 个临时会话都没了", len(mine(base, agent)) == 0)
            shot(page, "4-after-delete")

            browser.close()
    except Exception as exc:  # noqa: BLE001 — 测试脚本，报清楚就行
        check(f"界面流程异常：{type(exc).__name__}: {exc}", False)
        ok_all = False
    finally:
        cleanup(base, agent)

    print()
    if FAILED or not ok_all:
        print(f"❌ {len(FAILED)} 项未通过：" + "; ".join(FAILED))
        return 1
    print("✅ 界面端到端全流程通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
