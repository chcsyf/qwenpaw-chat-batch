# Changelog

## 0.0.1 — 2026-10-15

首个版本（`type=frontend`，只用几个 chats 接口 + 一处原生 DOM 挂载点，不改宿主任何文件）。

预览图见 README（`qwenpaw-chat-batch.png`）。

**功能**

- 入口按钮挂在侧栏「历史对话」操作行（`sidebarSessionList-module__historyActions`）末尾，
  26×26 与宿主自带图标按钮同尺寸同色，**不新占一行、不挤压聊天区**；宿主 React 重建 DOM 后
  由 MutationObserver + 兜底轮询自动补挂，侧栏折叠时按钮与面板一起收起
  （初版曾挂在顶栏 `header.right` 槽位，会多占一格并压缩聊天区，已改）
- 面板内按 **视图（活跃/已归档/全部）· 来源（chat/cron/subagent）· 时间（早于 N 天）·
  名称或 session_id 关键字 · 隐藏运行中 · 含 PawApp 会话** 筛出会话。
- 批量动作：**批量删除 / 批量归档 / 批量还原**，单次自动按 500 分块
  （与宿主 `MAX_BATCH_SIZE` 对齐）。
- 规则化选择：`保留最近 N 个`（保留最近 N 个、其余全选，等价 CLI 版
  `archive_subagent_chats.py --keep N` 的逻辑）、`全选筛选结果`、`反选`、`清空`、
  `只看已选`；跨全量结果选择，不受宿主分页每页 10 条限制。
- 危险保护：运行中会话勾选框禁用；删除弹确认框并列出会话名、标出「当前打开的
  会话」、必须再勾「我已确认」；要连运行中一起删需显式开开关。
- 结果如实回报：归档/还原用服务端 `succeeded/failed`（含 `in_progress` /
  `not_found` 原因计数）；删除因接口只回布尔，用操作前后列表 diff 报真实删除数。
- 面板里给未归档的会话提供 `/chat/<id>` 打开入口，并标出当前打开的会话。
- 筛选条件存 `localStorage`（键 `qwenpaw-chat-batch:filters`），打开即恢复。
- 中英双语文案（跟随宿主界面语言）。

**已知边界**

- 删除不可撤销，且宿主接口不会删除会话的 `JSONSession` 状态文件。
- `batch-delete` 无服务端 running 保护，保护只在前端。
- 宿主侧栏会话列表需自行刷新后才同步。

**测试**

- `node --test test_core.js`：12 条纯逻辑用例（分块边界、排序稳定性、
  筛选组合、可选性、保留最近 N、动作拆分、结果合并、删除 diff、字段回归护栏）。
- `tests/live_api_smoke.py`：对运行中的宿主实测 14 项接口事实——列表字段、
  `batch-archive` 传裸数组被 422（证明 body 必须是 `{chat_ids}`）、
  `batch-delete` 传 `{chat_ids}` 被 422（证明必须是裸数组）、
  归档→还原→删除往返、删除幂等、临时会话与 session 文件零残留。
- `tests/ui_e2e.py`：真浏览器（Playwright）把 index.js 注入运行中的控制台，
  走完 注入→按钮出现→面板列会话→关键字筛选→「保留最近 1 个」选中其余 2 个→
  归档→切已归档→全选→还原→全选→删除确认框（未勾确认时按钮禁用）→删除，
  18 项断言全过；每步结果另用独立 HTTP 通道核对服务端事实。
- `qwenpaw plugin validate` 通过。
