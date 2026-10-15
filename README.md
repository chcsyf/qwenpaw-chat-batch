# 🗂 会话批量管理（qwenpaw-chat-batch）v0.0.1

侧栏「历史对话」标题右边一个小按钮，点开一个小面板：**按条件筛出会话 → 勾选 → 批量删除 / 批量归档 / 批量还原**。

![qwenpaw-chat-batch](https://raw.githubusercontent.com/chcsyf/qwenpaw-chat-batch/main/qwenpaw-chat-batch.png)

纯前端插件（`type=frontend`），不写宿主任何文件、不起后端进程、不联网到站外；
筛选条件存浏览器本地，卸载即无残留。

- 插件 ID：`qwenpaw-chat-batch` ｜ 类型：`frontend` ｜ 版本：`0.0.1`
- 入口：`index.js`（原生 DOM 按钮，挂在侧栏「历史对话」操作行 `sidebarSessionList-module__historyActions` 内）
- 兼容：QwenPaw 2.2.1 – 2.99.0（在 2.2.2 上开发验证）

---

## 一、它解决什么

宿主自带「控制 → 会话」（`/sessions`）页，已经有分页表格多选 + 批量删除 / 归档 / 还原。
**本插件不重复那页**，只补它做不到的部分：

| 需求 | 宿主 `/sessions` 页 | 本插件 |
| --- | --- | --- |
| 分页表格勾选、批量删除/归档/还原 | ✅ | ✅（不依赖分页，一次拉全量） |
| 一次选跨全部结果 | ❌ 每页 10 条，得一页页勾 | ✅ 全选筛选结果 / 反选 / 只看已选 |
| 「保留最近 N 个，其余全清」 | ❌ | ✅ 一条规则选完 |
| 按来源（chat / cron / subagent）批量 | ❌ | ✅ |
| 按「早于 X 天」批量（清旧会话） | ❌ | ✅ 1/3/7/30 天 |
| 按名称 / session_id 关键字批量 | ❌ | ✅ |
| 运行中会话的保护 | ❌ `batch-delete` 无 running 校验，会连正在跑的任务的会话记录一起删 | ✅ 运行中一律不可勾选，要删必须显式开开关 |
| 删除前二次确认 + 列出影响面 | 单次确认 | ✅ 列出会话名、标出「当前打开的会话」、必须再勾一次「我已确认」 |
| 结果如实回报 | 概览 | ✅ 归档/还原回报 `succeeded/failed` 与原因；删除用列表 diff 报真实删除数 |
| 入口位置 | 控制页 | 侧栏历史行内 26×26 图标按钮，与宿主自带图标同尺寸同色，**不新占一行、不挤压聊天区** |

---

## 二、安装

```bash
# 从目录安装（开发时）
qwenpaw plugin install /path/to/projects/QwenPaw/qwenpaw-chat-batch

# 从归档安装
qwenpaw plugin install <Gitee/GitHub 的 archive zip 地址>

# 校验清单与入口
qwenpaw plugin validate /path/to/qwenpaw-chat-batch
```

装完刷新控制台页面，「历史对话」标题右侧会多出一个 ☑ 图标按钮（26×26，和宿主自己的两个图标按钮同款）。

## 三、用法

1. 点侧栏「历史对话」右边的 ☑ 图标展开面板（贴着按钮弹出；`Esc` 关闭、点面板外关闭；再次点击按钮收起）。
2. 在筛选条选 **视图（活跃 / 已归档 / 全部）· 来源 · 时间（早于 N 天）· 关键字**，
   可选「隐藏运行中」「含 PawApp 会话」。
3. 用底部快捷区选择：`保留最近 N 个`（保留最近 N 个、选中其余）· `全选筛选结果` ·
   `反选` · `清空` · `只看已选`；也可以逐行勾。**运行中的会话勾选框是禁用的**。
4. 底部按钮显示各自可执行的条数：`归档 N` / `还原 N` / `删除 N`，点一下执行。
   - 归档、还原可逆，直接执行，结果回报成功/失败与原因（`in_progress` / `not_found`）。
   - 删除弹确认框：列出会话名、提示不可撤销、若含当前打开的会话会单独标出；
     必须勾「我已确认」才能点确认。要连运行中的一起删，需另开一个开关。
5. 操作后自动重新拉取列表并刷新计数；面板里也标出「当前打开的会话」，方便你避开它。

## 四、入口位置与宿主 DOM 的关系

宿主的槽位注册表（`console/assets/slotKeys-*.js`）里没有「侧栏历史操作行」这一项，
`header.right` 才是给插件的槽位——但挂在顶栏会**多占一格、挤压聊天区**，所以本插件改走
原生 DOM：把按钮 append 进 `[class*="sidebarSessionList-module__historyActions"]` 行的末尾，
用 MutationObserver（+ 1.5s 兜底轮询）在宿主 React 重建 DOM 后重新挂上；按钮的尺寸/圆角/颜色
向宿主自己的 `.historyAction` 按钮对齐（26×26、圆角 6、`opacity .72`，图标是同源的 lucide `list-checks`）。

- 侧栏折叠时那一行不存在 → 按钮与面板一起收起（不留孤儿节点），展开后自动回来。
- 宿主若改了类名前缀，按钮会挂不上；控制台会打一条 `console.warn` 指出该改的选择器
  （`index.js` 里的 `SEL_ACTIONS`）。

## 五、依赖的宿主接口

全部在 `app/chats/api.py`，请求都带 `X-Agent-Id` 作用域头（用宿主 SDK
`window.QwenPaw.host.getSelectedAgentId()` / `getApiToken()` 取值，与宿主同一套约定）：

| 方法与路径 | 用途 | 说明 |
| --- | --- | --- |
| `GET /api/chats?include_app_owned=false` | 列会话 | 返回含实时 `status`、`archived`、`source`；不勾「含 PawApp 会话」时按宿主聊天面口径排除 PawApp 会话 |
| `POST /api/chats/actions/batch-archive` | 批量归档 | body `{"chat_ids":[…]}`，单次 ≤500，**服务端会跳过 running** 并放进 `failed[{reason:"in_progress"}]` |
| `POST /api/chats/actions/batch-unarchive` | 批量还原 | 同上，body `{"chat_ids":[…]}` |
| `POST /api/chats/batch-delete` | 批量删除 | body 是**裸数组** `["id",…]`（不是 `{chat_ids}`），单次 ≤500；返回 `{"deleted":bool}`，**不回条数**，所以本插件用操作前后列表 diff 报真实删除数；会连带删掉该会话的 checkpoint |

单次 500 的上限与宿主 `app/chats/manager.py` 的 `MAX_BATCH_SIZE` 对齐；插件内部
`CORE.MAX_BATCH = 500` 并自动分块，`test_core.js` 有一条测试钉住这个值。

## 六、风险与边界（重要）

- **删除不可撤销**：会话记录与检查点会被删；宿主接口**不会**删除该会话的
  `JSONSession` 状态文件（`app/chats/api.py` 的注释写明了），所以磁盘上可能留下
  `sessions/*.json` 残留，需要时自行清理。
- **删除没有服务端 running 保护**：这是宿主 `batch-delete` 的行为，插件在前端挡住
  （运行中不可勾选 + 删除确认框里要显式开开关），但如果有人在开关打开时确认，
  后果一样是「正在跑的任务失去会话记录」。
- **归档不是删除**：`archived_at` 打标，可随时还原；归档时会关闭该会话的浏览器会话。
- 面板操作后，宿主侧栏的会话列表要等它自己重新拉取才会同步（切换会话或刷新页面即可）。
- 唯一依赖宿主 DOM 的地方是入口按钮所在的那一行（`sidebarSessionList-module__historyActions`，
  按**类名前缀**匹配而不是全名，跨小版本升级更耐用）；其余全部走 HTTP 接口，宿主改版不容易碎。

## 七、有意不做

- **重命名 / 置顶 / 分组**：宿主 `/sessions` 页与会话右键菜单已有。
- **会话内容导出**：需要读历史消息接口，属于另一个插件的职责，不塞进这个面板。
- **评论 / 备注**：宿主 `ChatUpdate`（`app/chats/models.py`）是 `extra="forbid"`，
  只允许 `name / pinned / group_id`，`meta` 只读 —— 服务端存不下备注。纯前端插件
  只能存浏览器 localStorage，换浏览器/换人就丢，容易和预期不符，所以不做；
  真要服务端备注，得配一个 `type=app` 的小后端写 `plugin_data/`。
- 不接管快捷键、不动宿主布局、不改宿主存储。

## 八、自检与测试

三档，从纯逻辑到真浏览器：

```bash
# ① 纯逻辑核心（12 条：筛选/规则/分批/结果合并/字段回归护栏，不需要宿主）
node --test test_core.js

# ② 对着跑着的宿主打接口（建 1 个临时会话→归档→还原→删除，跑完自己清理）
python tests/live_api_smoke.py                # 可选 --base-url / --agent-id

# ③ 真浏览器端到端：把 index.js 注入到控制台页面，像用户一样点完整流程
#    （筛选 → 保留最近 N → 归档 → 已归档视图全选 → 还原 → 全选 → 删除确认框），
#    每步结果都用独立 HTTP 通道核对；不装插件、刷新即无痕
python tests/ui_e2e.py --shots /tmp/qcb-shots # 需要 playwright + 本机 qwenpaw 在跑
```

浏览器里还有调试入口（只挂在自己的命名空间，不影响宿主）：

```js
window.__qwenpawChatBatch.open();                        // 打开面板
window.__qwenpawChatBatch.setFilters({view:"archived"}); // 改筛选
window.__qwenpawChatBatch.setLang(false);                // 手动切英文（默认跟随宿主语言）
window.__qwenpawChatBatch.api.list().then(console.log);  // 直接调接口层
window.__qwenpawChatBatch.core.keepRecent(chats, 10);    // 纯逻辑
```

## 九、卸载

插件市场/`qwenpaw plugin uninstall qwenpaw-chat-batch` 卸载即可：页面刷新后，
入口按钮、面板 DOM 与 `<style>` 都不再注入（它们都由插件自己创建）。
浏览器本地只留两个键，需要的话手动清：`qwenpaw-chat-batch:filters`。

## 十、License

Apache-2.0（与同仓其他插件一致）。
