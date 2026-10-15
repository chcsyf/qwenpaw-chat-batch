/**
 * qwenpaw-chat-batch v0.0.1 — 会话批量管理（批量删除 / 批量归档 / 批量还原）
 *
 * 纯前端插件（type=frontend），不写宿主任何文件、不启动后端进程：
 * 在顶栏右侧（slot `header.right`）放一个 🗂 小按钮，点开是一个小面板，
 * 面板里按「视图 / 来源 / 时间 / 关键字」筛出会话，再勾选（或用规则一键选）
 * 批量删除、批量归档、批量还原。
 *
 * 与宿主自带的「控制 → 会话」（/sessions 页）的分工：宿主那页已有分页表格
 * 多选 + 批量删除/归档/还原，本插件**不重复**它，只补宿主没有的那半边——
 *   ① 规则化选择：保留最近 N 个（其余全选）、按来源、按「早于 X 天」、按名称/
 *      session_id 关键字、一键全选筛选结果 / 反选；
 *   ② 跨全部结果选择（宿主分页每页 10 条，只能一页一页勾）；
 *   ③ 危险保护：运行中的会话一律不可勾选（宿主的 batch-delete 没有 running
 *      保护，会直接删掉正在跑的任务的会话记录）；删除要在确认框里再勾一次
 *      「我已确认」，并单独列出「当前打开的会话」；运行中会话要删必须显式开开关；
 *   ④ 结果如实回报：归档/还原用服务端的 succeeded/failed（含 in_progress /
 *      not_found 原因），删除因接口只返回布尔，改用「操作前后列表 diff」报数。
 *
 * 用到的宿主接口（都在 app/chats/api.py，均需 X-Agent-Id 作用域头）：
 *   GET  /api/chats?include_app_owned=…       列出会话（含实时 status、archived）
 *   POST /api/chats/actions/batch-archive     {chat_ids:[…]} ≤500，running 自动跳过
 *   POST /api/chats/actions/batch-unarchive   {chat_ids:[…]} ≤500
 *   POST /api/chats/batch-delete              裸数组 [chat_id,…]，**不可撤销**
 *                                             （连带删掉该会话的 checkpoint）
 *
 * 有意不做：会话内容导出、重命名/置顶/分组（宿主已有）、评论/备注（宿主
 * ChatUpdate 是 extra="forbid"，只允许 name/pinned/group_id，服务端存不下备注，
 * 纯前端插件只能存浏览器本地，容易和用户的预期不符，故不做）。
 *
 * 自检入口：window.__qwenpawChatBatch（open/close/refresh/state/core/api）
 */

(function () {
  "use strict";

  var PLUGIN_ID = "qwenpaw-chat-batch";
  var VERSION = "0.0.1";

  /** 与 app/chats/manager.py 的 MAX_BATCH_SIZE 对齐：单次请求的 id 上限 */
  var MAX_BATCH = 500;
  /** 列表一次渲染多少行，点「显示更多」再加一屏 */
  var RENDER_STEP = 200;
  /** 面板宽度（px），存 localStorage */
  var PANEL_W = 486;

  var LS_FILTERS = PLUGIN_ID + ":filters";

  /** 「只看已选」开关（不持久化） */
  var onlySelected = false;

  var API = {
    list: "/api/chats",
    archive: "/api/chats/actions/batch-archive",
    unarchive: "/api/chats/actions/batch-unarchive",
    del: "/api/chats/batch-delete",
  };

  /* ================================================================== *
   * 一、纯逻辑核心（不碰 DOM / 网络，可被 test_core.js 单测）
   * ================================================================== */

  var CORE = {
    MAX_BATCH: MAX_BATCH,

    /** 会话的「最近活跃」时间：updated_at 优先，退到 created_at */
    lastActive: function (chat) {
      return (chat && (chat.updated_at || chat.created_at)) || "";
    },

    /** 是否正在运行（宿主的 batch-archive 会跳过它；batch-delete 不会保护） */
    isRunning: function (chat) {
      return !!chat && chat.status === "running";
    },

    /** 按 MAX_BATCH 切块，避免超过服务端 max_length 被 422 拒掉 */
    chunk: function (ids, size) {
      var step = size || MAX_BATCH;
      var out = [];
      for (var i = 0; i < ids.length; i += step) out.push(ids.slice(i, i + step));
      return out;
    },

    /** 最近活跃降序（同时间戳时用 id 兜底，保证排序稳定） */
    sortChats: function (chats) {
      return chats.slice().sort(function (a, b) {
        var ta = CORE.lastActive(a);
        var tb = CORE.lastActive(b);
        if (ta === tb) return String(a.id) < String(b.id) ? -1 : 1;
        return ta < tb ? 1 : -1;
      });
    },

    /**
     * 筛选：f = {view:"active"|"archived"|"all", source:"all"|"chat"|"cron"|"subagent",
     *          ageDays:0|1|3|7|30, q:"", hideRunning:false}
     * now 传毫秒时间戳（测试里固定注入，避免时间漂移）
     */
    filterChats: function (chats, f, now) {
      var flt = f || {};
      var q = (flt.q || "").trim().toLowerCase();
      var cutoff = 0;
      if (flt.ageDays > 0) cutoff = (now || Date.now()) - flt.ageDays * 86400000;
      return chats.filter(function (c) {
        if (flt.view === "active" && c.archived) return false;
        if (flt.view === "archived" && !c.archived) return false;
        if (flt.source && flt.source !== "all" && c.source !== flt.source) return false;
        if (flt.hideRunning && CORE.isRunning(c)) return false;
        if (cutoff) {
          var t = Date.parse(CORE.lastActive(c));
          if (!isFinite(t) || t >= cutoff) return false;
        }
        if (q) {
          var hay = ((c.name || "") + " " + (c.session_id || "")).toLowerCase();
          if (hay.indexOf(q) < 0) return false;
        }
        return true;
      });
    },

    /**
     * 某个会话对某个动作是否可选：
     *   archive   → 未归档且不在运行
     *   unarchive → 已归档且不在运行
     *   delete    → 不在运行（allowRunning 显式打开时才允许运行中的）
     */
    selectable: function (chat, action, allowRunning) {
      if (!chat) return false;
      if (CORE.isRunning(chat) && !allowRunning) return false;
      if (action === "archive") return !chat.archived;
      if (action === "unarchive") return !!chat.archived;
      return true;
    },

    /**
     * 规则：「保留最近 keep 个，其余选中」（等价于 CLI 脚本的 --keep N）。
     * 只看传入的列表（调用方已按视图/来源/时间/关键字筛过），按最近活跃降序取前
     * keep 个保留，剩下的里排除运行中的，作为待选。
     * 返回 {kept:[], pick:[], skippedRunning:[]}
     */
    keepRecent: function (chats, keep, allowRunning) {
      var sorted = CORE.sortChats(chats);
      var n = Math.max(0, parseInt(keep, 10) || 0);
      var kept = sorted.slice(0, n);
      var rest = sorted.slice(n);
      var pick = [];
      var skipped = [];
      rest.forEach(function (c) {
        if (CORE.selectable(c, "delete", allowRunning)) pick.push(c);
        else skipped.push(c);
      });
      return { kept: kept, pick: pick, skippedRunning: skipped };
    },

    /** 按动作拆出「已选中且确实可执行」的 id，避免把不可执行的混进请求 */
    splitByAction: function (chats, selectedIds, allowRunning) {
      var sel = {};
      (selectedIds || []).forEach(function (id) {
        sel[id] = true;
      });
      var out = { archive: [], unarchive: [], delete: [], running: [] };
      chats.forEach(function (c) {
        if (!sel[c.id]) return;
        if (CORE.isRunning(c)) out.running.push(c.id);
        if (CORE.selectable(c, "archive", allowRunning)) out.archive.push(c.id);
        if (CORE.selectable(c, "unarchive", allowRunning)) out.unarchive.push(c.id);
        if (CORE.selectable(c, "delete", allowRunning)) out.delete.push(c.id);
      });
      return out;
    },

    /** 合并多个分块的 BatchArchiveResult：{succeeded:[], failed:[{chat_id,reason,message}]} */
    mergeBatchResult: function (results) {
      var ok = [];
      var bad = [];
      (results || []).forEach(function (r) {
        ok = ok.concat((r && r.succeeded) || []);
        bad = bad.concat((r && r.failed) || []);
      });
      return { succeeded: ok, failed: bad };
    },

    /** 失败原因计数，用于一行话回报（in_progress / not_found / 其它） */
    countReasons: function (failures) {
      var out = {};
      (failures || []).forEach(function (f) {
        var k = (f && f.reason) || "error";
        out[k] = (out[k] || 0) + 1;
      });
      return out;
    },

    /**
     * 删除结果：接口只回 {"deleted": bool}，所以用操作前后的 id 集合 diff 报数。
     * 返回 {gone:[], left:[]}
     */
    diffDeleted: function (beforeIds, afterIds) {
      var after = {};
      (afterIds || []).forEach(function (id) {
        after[id] = true;
      });
      var gone = [];
      var left = [];
      (beforeIds || []).forEach(function (id) {
        if (after[id]) left.push(id);
        else gone.push(id);
      });
      return { gone: gone, left: left };
    },
  };

  /* ================================================================== *
   * 二、宿主环境（window.QwenPaw）
   * ================================================================== */

  var doc = typeof document !== "undefined" ? document : null;

  function host() {
    return (typeof window !== "undefined" && window.QwenPaw && window.QwenPaw.host) || {};
  }

  /** 中英双语文案（跟随宿主界面语言） */
  function detectZh() {
    if (!doc) return true;
    // ① 宿主把界面语言存在 localStorage（键名随版本变，这里多试几个；值可能是 "zh" 或 "\"zh-CN\""）
    try {
      var keys = ["language", "locale", "i18n_language", "lang"];
      for (var i = 0; i < keys.length; i += 1) {
        var raw = localStorage.getItem(keys[i]);
        if (!raw) continue;
        var v = String(raw).replace(/["']/g, "").toLowerCase();
        if (v.indexOf("zh") === 0) return true;
        if (v.indexOf("en") === 0) return false;
      }
    } catch (e) {
      /* ignore */
    }
    // ② 宿主侧栏文案
    var more = doc.querySelector('[class*="index-module__moreSettings"]');
    var txt = more ? more.textContent || "" : "";
    if (/更多设置/.test(txt)) return true;
    if (/more settings/i.test(txt)) return false;
    // ③ 页面正文里有没有中文（宿主已渲染出来的界面就是最可靠的证据）
    try {
      var sample = doc.body ? String(doc.body.textContent || "").slice(0, 4000) : "";
      if (/[\u4e00-\u9fa5]/.test(sample)) return true;
    } catch (e) {
      /* ignore */
    }
    // ④ 最后才看浏览器语言
    try {
      return String(navigator.language || "").toLowerCase().indexOf("zh") === 0;
    } catch (e) {
      return true;
    }
  }

  var ZH = true;
  function t(zh, en) {
    return ZH ? zh : en;
  }

  /* ================================================================== *
   * 三、状态
   * ================================================================== */

  var DEFAULT_FILTERS = {
    view: "active", // active | archived | all
    source: "all", // all | chat | cron | subagent
    ageDays: 0, // 0=不限，>0 表示「早于 N 天」
    q: "",
    hideRunning: false,
    includeAppOwned: false, // 含 PawApp 会话
    keepN: 10, // 规则「保留最近 N 个」
  };

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return v && typeof v === "object" ? v : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
      /* 隐私模式等场景静默失败 */
    }
  }

  var state = {
    open: false,
    loading: false,
    chats: [], // 最近一次 GET /api/chats 的原始结果
    filters: Object.assign({}, DEFAULT_FILTERS, readJSON(LS_FILTERS, {})),
    selected: {},
    rows: RENDER_STEP,
    busy: false,
    message: null, // {kind:"ok"|"warn"|"err", text:""}
    currentChatId: "",
    anchorRect: null, // 入口按钮的位置，面板贴着它展开
  };
  if (!state.filters.q) state.filters.q = "";

  function saveFilters() {
    writeJSON(LS_FILTERS, state.filters);
  }

  function selectedIds() {
    return Object.keys(state.selected);
  }

  function clearSelection() {
    state.selected = {};
  }

  /* ================================================================== *
   * 四、平台 API
   * ================================================================== */

  function apiHeaders(json) {
    var h = { Accept: "application/json" };
    var H = host();
    try {
      var tok = H.getApiToken ? H.getApiToken() : "";
      if (tok) h.Authorization = "Bearer " + tok;
      var aid = H.getSelectedAgentId ? H.getSelectedAgentId() : "";
      if (aid) h["X-Agent-Id"] = aid;
    } catch (e) {
      /* host 未就绪时退化为无鉴权（本地开发） */
    }
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  // 不用 host.fetch：它的 getApiUrl 会自动补 "/api" 前缀，传 "/api/..." 会变成 /api/api/...
  function apiFetch(method, path, body) {
    var opt = { method: method, headers: apiHeaders(body !== undefined) };
    if (body !== undefined) opt.body = JSON.stringify(body);
    return fetch(path, opt).then(function (r) {
      return r.text().then(function (text) {
        var json = null;
        try {
          json = JSON.parse(text);
        } catch (e) {
          /* 非 JSON（登录页/网关拦截） */
        }
        if (!r.ok) {
          var detail = (json && (json.detail || json.message)) || ("HTTP " + r.status);
          if (typeof detail !== "string") detail = JSON.stringify(detail);
          throw new Error(detail);
        }
        if (json === null) throw new Error(t("响应不是 JSON（可能被登录页或网关拦截）", "Non-JSON response (login page or gateway?)"));
        return json;
      });
    });
  }

  function listChats() {
    var qs = state.filters.includeAppOwned ? "" : "?include_app_owned=false";
    return apiFetch("GET", API.list + qs).then(function (list) {
      state.chats = Array.isArray(list) ? list : [];
      // 会话已被别处删掉的，从选中集合里摘掉，避免「已选 N」虚高
      var alive = {};
      state.chats.forEach(function (c) {
        alive[c.id] = true;
      });
      Object.keys(state.selected).forEach(function (id) {
        if (!alive[id]) delete state.selected[id];
      });
      return state.chats;
    });
  }

  function postBatch(path, ids) {
    var chunks = CORE.chunk(ids, MAX_BATCH);
    var results = [];
    var chain = Promise.resolve();
    chunks.forEach(function (part) {
      chain = chain.then(function () {
        return apiFetch("POST", path, { chat_ids: part }).then(function (r) {
          results.push(r);
        });
      });
    });
    return chain.then(function () {
      return CORE.mergeBatchResult(results);
    });
  }

  function doArchive(ids) {
    return postBatch(API.archive, ids);
  }

  function doUnarchive(ids) {
    return postBatch(API.unarchive, ids);
  }

  /** 删除：请求体是裸数组；返回真实被删掉的 id（接口不回条数） */
  function doDelete(ids) {
    var chunks = CORE.chunk(ids, MAX_BATCH);
    var chain = Promise.resolve();
    chunks.forEach(function (part) {
      chain = chain.then(function () {
        return apiFetch("POST", API.del, part);
      });
    });
    return chain.then(function () {
      return listChats().then(function (after) {
        var afterIds = after.map(function (c) {
          return c.id;
        });
        return CORE.diffDeleted(ids, afterIds);
      });
    });
  }

  /* ================================================================== *
   * 五、视图数据（筛选 → 排序 → 切页）
   * ================================================================== */

  function filtered() {
    return CORE.filterChats(state.chats, state.filters, Date.now());
  }

  function visibleSorted() {
    return CORE.sortChats(filtered());
  }

  function currentChatIdFromUrl() {
    try {
      var m = /\/chat\/([^/?#]+)/.exec(location.pathname || "");
      return m ? decodeURIComponent(m[1]) : "";
    } catch (e) {
      return "";
    }
  }

  /* ================================================================== *
   * 六、样式
   * ================================================================== */

  var STYLE_ID = PLUGIN_ID + "-style";

  var CSS = [
    ".qcb-btn{border:none;background:transparent;cursor:pointer;padding:0 6px;height:28px;border-radius:6px;font-size:15px;line-height:28px;color:inherit;display:inline-flex;align-items:center;gap:4px}",
    ".qcb-btn:hover{background:rgba(127,127,127,.14)}",
    ".qcb-btn[aria-expanded=true]{background:rgba(127,127,127,.2)}",
    // 侧栏历史操作行里的那个入口按钮：外形与宿主自己的 26×26 图标按钮一致
    ".qcb-inline-btn{width:26px;height:26px;min-width:26px;padding:0;line-height:1;border-radius:6px;justify-content:center;opacity:.72;flex:0 0 auto}",
    ".qcb-inline-btn:hover{opacity:1}",
    ".qcb-inline-btn[aria-expanded=true]{opacity:1}",
    ".qcb-badge{min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#d4380d;color:#fff;font-size:11px;line-height:16px;text-align:center}",
    ".qcb-panel{position:fixed;z-index:2147482000;background:var(--qcb-bg,#fff);color:inherit;border:1px solid rgba(127,127,127,.28);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.18);display:flex;flex-direction:column;overflow:hidden;font-size:13px}",
    ".qcb-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid rgba(127,127,127,.2)}",
    ".qcb-title{font-weight:600;flex:1}",
    ".qcb-filters{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;border-bottom:1px solid rgba(127,127,127,.16)}",
    ".qcb-filters select,.qcb-filters input[type=text],.qcb-filters input[type=number]{height:26px;border:1px solid rgba(127,127,127,.35);border-radius:6px;background:transparent;color:inherit;padding:0 6px;font-size:12px;min-width:0}",
    ".qcb-filters input[type=text]{flex:1}",
    ".qcb-seg{display:inline-flex;border:1px solid rgba(127,127,127,.35);border-radius:6px;overflow:hidden}",
    ".qcb-seg button{border:none;background:transparent;color:inherit;font-size:12px;height:26px;padding:0 8px;cursor:pointer}",
    ".qcb-seg button[aria-pressed=true]{background:rgba(22,119,255,.16);font-weight:600}",
    ".qcb-chk{display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;user-select:none}",
    ".qcb-quick{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid rgba(127,127,127,.16);font-size:12px}",
    ".qcb-quick button{border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;border-radius:6px;height:24px;padding:0 8px;cursor:pointer;font-size:12px}",
    ".qcb-quick button:hover{background:rgba(127,127,127,.12)}",
    ".qcb-rows{overflow:auto;flex:1;min-height:120px}",
    ".qcb-row{display:flex;align-items:center;gap:8px;padding:5px 10px;border-bottom:1px solid rgba(127,127,127,.1);cursor:default}",
    ".qcb-row:hover{background:rgba(127,127,127,.08)}",
    ".qcb-row[data-sel=true]{background:rgba(22,119,255,.1)}",
    ".qcb-row[data-run=true] .qcb-name{opacity:.6}",
    ".qcb-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".qcb-a{color:inherit;text-decoration:none;border-bottom:1px dotted rgba(127,127,127,.6)}",
    ".qcb-meta{color:rgba(127,127,127,1);font-size:11px;white-space:nowrap}",
    ".qcb-tag{font-size:10px;padding:0 4px;border-radius:4px;border:1px solid rgba(127,127,127,.4)}",
    ".qcb-tag[data-k=running]{border-color:#d4380d;color:#d4380d}",
    ".qcb-tag[data-k=archived]{border-color:#8c8c8c;color:#8c8c8c}",
    ".qcb-tag[data-k=current]{border-color:#1677ff;color:#1677ff}",
    ".qcb-foot{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 10px;border-top:1px solid rgba(127,127,127,.2)}",
    ".qcb-foot button{border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;border-radius:6px;height:26px;padding:0 10px;cursor:pointer}",
    ".qcb-foot button:disabled{opacity:.45;cursor:not-allowed}",
    ".qcb-foot button[data-danger=true]:not(:disabled){border-color:#d4380d;color:#d4380d}",
    ".qcb-foot .qcb-count{margin-right:auto;font-size:12px;color:rgba(127,127,127,1)}",
    ".qcb-msg{padding:6px 10px;font-size:12px;border-top:1px solid rgba(127,127,127,.16)}",
    ".qcb-msg[data-k=ok]{color:#389e0d}",
    ".qcb-msg[data-k=warn]{color:#d46b08}",
    ".qcb-msg[data-k=err]{color:#cf1322}",
    ".qcb-mask{position:fixed;inset:0;z-index:2147481999;background:transparent}",
    ".qcb-confirm{position:fixed;z-index:2147482100;width:420px;background:var(--qcb-bg,#fff);color:inherit;border:1px solid rgba(212,56,13,.5);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.24);padding:12px;font-size:13px}",
    ".qcb-confirm h4{margin:0 0 6px;font-size:13px}",
    ".qcb-confirm ul{margin:6px 0;padding-left:18px;max-height:120px;overflow:auto;color:rgba(127,127,127,1)}",
    ".qcb-confirm .qcb-warn{color:#cf1322}",
    ".qcb-confirm .qcb-acts{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}",
    ".qcb-confirm .qcb-acts button{border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;border-radius:6px;height:26px;padding:0 10px;cursor:pointer}",
    ".qcb-confirm .qcb-acts button[data-primary=true]{border-color:#d4380d;color:#d4380d}",
    ".qcb-confirm .qcb-acts button:disabled{opacity:.45;cursor:not-allowed}",
    ".qcb-empty{padding:16px;text-align:center;color:rgba(127,127,127,1);font-size:12px}",
  ].join("");

  function injectStyle() {
    if (!doc || !doc.head) return;
    var el = doc.getElementById(STYLE_ID);
    if (!el) {
      el = doc.createElement("style");
      el.id = STYLE_ID;
      doc.head.appendChild(el);
    }
    // 热更新（插件覆盖安装后没刷新页面）时把旧样式换掉，别复用过期的那份
    if (el.textContent !== CSS) el.textContent = CSS;
  }

  /* ================================================================== *
   * 七、面板
   * ================================================================== */

  var ui = { panel: null, mask: null, list: null, foot: null, msg: null, count: null, confirm: null };
  function el(tag, attrs, children) {
    var node = doc.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "text") node.textContent = v;
        else if (k === "html") node.innerHTML = v;
        else if (k.indexOf("on") === 0 && typeof v === "function") node.addEventListener(k.slice(2), v);
        else if (v === true) node.setAttribute(k, "");
        else node.setAttribute(k, v);
      });
    }
    (children || []).forEach(function (c) {
      if (c) node.appendChild(c);
    });
    return node;
  }

  /** 折行成短标签用：'yyyy-mm-dd hh:mm'（本地时区，只留到分钟） */
  function fmtTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var p = function (n) {
      return (n < 10 ? "0" : "") + n;
    };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function buildPanel() {
    var panel = el("div", { class: "qcb-panel", role: "dialog", "aria-label": t("会话批量管理", "Batch chat manager") });
    panel.style.width = PANEL_W + "px";
    panel.style.maxHeight = "min(72vh, 660px)";
    panel.style.top = "56px";
    panel.style.right = "12px";

    var head = el("div", { class: "qcb-head" }, [
      el("span", { text: "🗂" }),
      el("span", { class: "qcb-title", text: t("会话批量管理", "Batch chat manager") + " v" + VERSION }),
      el("button", {
        class: "qcb-btn",
        title: t("刷新列表", "Refresh"),
        text: "⟳",
        onclick: function () {
          refresh();
        },
      }),
      el("button", {
        class: "qcb-btn",
        title: t("关闭", "Close"),
        text: "✕",
        onclick: function () {
          close();
        },
      }),
    ]);

    var filters = el("div", { class: "qcb-filters" });
    var quick = el("div", { class: "qcb-quick" });
    var list = el("div", { class: "qcb-rows" });
    var msg = el("div", { class: "qcb-msg", style: "display:none" });
    var count = el("span", { class: "qcb-count", text: "" });
    var foot = el("div", { class: "qcb-foot" }, [
      count,
      el("button", { text: t("归档", "Archive"), "data-act": "archive", onclick: function () { act("archive"); } }),
      el("button", { text: t("还原", "Unarchive"), "data-act": "unarchive", onclick: function () { act("unarchive"); } }),
      el("button", { text: t("删除", "Delete"), "data-act": "delete", "data-danger": "true", onclick: function () { act("delete"); } }),
    ]);

    panel.appendChild(head);
    panel.appendChild(filters);
    panel.appendChild(quick);
    panel.appendChild(list);
    panel.appendChild(msg);
    panel.appendChild(foot);

    ui.panel = panel;
    ui.filters = filters;
    ui.quick = quick;
    ui.list = list;
    ui.msg = msg;
    ui.count = count;
    ui.foot = foot;
    return panel;
  }

  /* ---------- 筛选条 ---------- */

  function segButton(label, value, group, key) {
    return el("button", {
      type: "button",
      text: label,
      "aria-pressed": String(state.filters[key] === value),
      onclick: function () {
        state.filters[key] = value;
        saveFilters();
        render();
      },
    });
  }

  function selectField(label, options, key) {
    var sel = el("select", {
      title: label,
      onchange: function (e) {
        var v = e.target.value;
        state.filters[key] = key === "ageDays" ? parseInt(v, 10) || 0 : v;
        saveFilters();
        render();
      },
    });
    options.forEach(function (o) {
      var att = { value: o[0], text: o[1] };
      if (String(state.filters[key]) === String(o[0])) att.selected = true;
      sel.appendChild(el("option", att));
    });
    return sel;
  }

  function renderFilters() {
    var wrap = ui.filters;
    wrap.textContent = "";
    var seg = el("div", { class: "qcb-seg", title: t("视图", "View") }, [
      segButton(t("活跃", "Active"), "active", "view", "view"),
      segButton(t("已归档", "Archived"), "archived", "view", "view"),
      segButton(t("全部", "All"), "all", "view", "view"),
    ]);
    wrap.appendChild(seg);
    wrap.appendChild(
      selectField(t("来源", "Source"), [["all", t("全部来源", "Any source")], ["chat", "chat"], ["cron", "cron"], ["subagent", "subagent"]], "source"),
    );
    wrap.appendChild(
      selectField(
        t("时间", "Age"),
        [[0, t("不限时间", "Any time")], [1, t("早于 1 天", "older than 1d")], [3, t("早于 3 天", "older than 3d")], [7, t("早于 7 天", "older than 7d")], [30, t("早于 30 天", "older than 30d")]],
        "ageDays",
      ),
    );
    var q = el("input", {
      type: "text",
      placeholder: t("名称 / session_id 关键字", "name / session_id"),
      value: state.filters.q || "",
      oninput: function (e) {
        state.filters.q = e.target.value;
        saveFilters();
        renderList();
        renderFoot();
      },
    });
    wrap.appendChild(q);
    var chk = function (label, key) {
      return el("label", { class: "qcb-chk", title: label }, [
        el("input", {
          type: "checkbox",
          checked: !!state.filters[key],
          onchange: function (e) {
            state.filters[key] = e.target.checked;
            saveFilters();
            if (key === "includeAppOwned") refresh();
            else render();
          },
        }),
        el("span", { text: label }),
      ]);
    };
    wrap.appendChild(chk(t("隐藏运行中", "Hide running"), "hideRunning"));
    wrap.appendChild(chk(t("含 PawApp 会话", "Include PawApp"), "includeAppOwned"));
  }

  /* ---------- 快捷选择 ---------- */

  function renderQuick() {
    var wrap = ui.quick;
    wrap.textContent = "";
    var keepInput = el("input", {
      type: "number",
      min: "0",
      step: "1",
      value: state.filters.keepN,
      style: "width:56px",
      title: t("保留最近多少个", "Keep most recent N"),
      onchange: function (e) {
        state.filters.keepN = Math.max(0, parseInt(e.target.value, 10) || 0);
        saveFilters();
      },
    });
    wrap.appendChild(
      el("button", {
        type: "button",
        text: t("保留最近", "Keep recent"),
        title: t("按当前筛选结果排序，保留最近 N 个，其余全部选中", "Select all but the most recent N in the current filter"),
        onclick: function () {
          var res = CORE.keepRecent(filtered(), state.filters.keepN, false);
          state.selected = {};
          res.pick.forEach(function (c) {
            state.selected[c.id] = true;
          });
          var extra = res.skippedRunning.length ? t("，跳过运行中 " + res.skippedRunning.length + " 个", " (skipped " + res.skippedRunning.length + " running)") : "";
          setMessage("ok", t("保留 " + res.kept.length + " 个，选中其余 " + res.pick.length + " 个" + extra, "Kept " + res.kept.length + ", selected " + res.pick.length + extra));
          renderList();
          renderFoot();
        },
      }),
    );
    wrap.appendChild(keepInput);
    wrap.appendChild(el("span", { text: t("个", "items") }));
    wrap.appendChild(
      el("button", {
        type: "button",
        text: t("全选筛选结果", "Select filtered"),
        onclick: function () {
          var n = 0;
          visibleSorted().forEach(function (c) {
            if (CORE.isRunning(c)) return; // 运行中一律不自动选
            state.selected[c.id] = true;
            n += 1;
          });
          setMessage(null);
          renderList();
          renderFoot();
          void n;
        },
      }),
    );
    wrap.appendChild(
      el("button", {
        type: "button",
        text: t("反选", "Invert"),
        onclick: function () {
          visibleSorted().forEach(function (c) {
            if (CORE.isRunning(c)) return;
            if (state.selected[c.id]) delete state.selected[c.id];
            else state.selected[c.id] = true;
          });
          renderList();
          renderFoot();
        },
      }),
    );
    wrap.appendChild(
      el("button", {
        type: "button",
        text: t("清空", "Clear"),
        onclick: function () {
          clearSelection();
          renderList();
          renderFoot();
        },
      }),
    );
    wrap.appendChild(
      el("button", {
        type: "button",
        text: t("只看已选", "Only selected"),
        onclick: function () {
          onlySelected = !onlySelected;
          render();
        },
      }),
    );
  }

  /* ---------- 列表 ---------- */

  function rowEl(c) {
    var running = CORE.isRunning(c);
    var isCurrent = state.currentChatId && c.id === state.currentChatId;
    var sel = !!state.selected[c.id];
    var title = c.name || c.session_id || c.id;
    var nameNode = el("span", { class: "qcb-name" }, [
      // 已归档的会话在宿主聊天面里打不开，就用纯文本，不给假入口
      c.archived
        ? el("span", { text: title })
        : el("a", { class: "qcb-a", href: "/chat/" + encodeURIComponent(c.id), title: t("打开会话", "Open chat"), text: title }),
      el("span", { class: "qcb-meta", text: "  " + (c.session_id || "") }),
    ]);
    var tags = [
      el("span", { class: "qcb-tag", text: c.source || "chat" }),
      el("span", { class: "qcb-tag", text: fmtTime(CORE.lastActive(c)) }),
    ];
    if (running) tags.push(el("span", { class: "qcb-tag", "data-k": "running", text: t("运行中", "running") }));
    if (c.archived) tags.push(el("span", { class: "qcb-tag", "data-k": "archived", text: t("已归档", "archived") }));
    if (isCurrent) tags.push(el("span", { class: "qcb-tag", "data-k": "current", text: t("当前", "current") }));
    var box = el("input", {
      type: "checkbox",
      checked: sel,
      disabled: running,
      title: running ? t("运行中的会话不能批量操作", "Running chats cannot be batch-operated") : "",
      onchange: function (e) {
        if (e.target.checked) state.selected[c.id] = true;
        else delete state.selected[c.id];
        rowElUpdate(box.parentNode, c);
        renderFoot();
      },
    });
    return el("div", { class: "qcb-row", "data-id": c.id, "data-sel": String(sel), "data-run": String(running) }, [box, nameNode].concat(tags));
  }

  function rowElUpdate(row, c) {
    row.setAttribute("data-sel", String(!!state.selected[c.id]));
  }

  function renderList() {
    if (!ui.list) return;
    ui.list.textContent = "";
    var all = visibleSorted();
    var rows = onlySelected
      ? all.filter(function (c) {
          return state.selected[c.id];
        })
      : all.slice(0, state.rows);
    if (!all.length) {
      ui.list.appendChild(el("div", { class: "qcb-empty", text: t("没有符合筛选条件的会话", "No chats match the filter") }));
      return;
    }
    var frag = doc.createDocumentFragment();
    rows.forEach(function (c) {
      frag.appendChild(rowEl(c));
    });
    ui.list.appendChild(frag);
    if (!onlySelected && all.length > state.rows) {
      ui.list.appendChild(
        el("div", { class: "qcb-empty" }, [
          el("button", {
            class: "qcb-btn",
            text: t("显示更多（已显示 " + state.rows + " / 共 " + all.length + "）", "Show more (" + state.rows + " / " + all.length + ")"),
            onclick: function () {
              state.rows += RENDER_STEP;
              renderList();
            },
          }),
        ]),
      );
    }
  }

  /* ---------- 底部动作 ---------- */

  function renderFoot() {
    var allSplit = CORE.splitByAction(state.chats, selectedIds(), false);
    var n = selectedIds().length;
    ui.count.textContent = t(
      "已选 " + n + " 个（可归档 " + allSplit.archive.length + " / 可还原 " + allSplit.unarchive.length + " / 可删除 " + allSplit.delete.length + "）",
      "Selected " + n + " (archive " + allSplit.archive.length + " / unarchive " + allSplit.unarchive.length + " / delete " + allSplit.delete.length + ")",
    );
    Array.prototype.forEach.call(ui.foot.querySelectorAll("button[data-act]"), function (b) {
      var k = b.getAttribute("data-act");
      var eligible = allSplit[k] ? allSplit[k].length : 0;
      b.disabled = state.busy || eligible === 0;
      b.textContent =
        k === "archive"
          ? t("归档", "Archive") + (eligible ? " " + eligible : "")
          : k === "unarchive"
            ? t("还原", "Unarchive") + (eligible ? " " + eligible : "")
            : t("删除", "Delete") + (eligible ? " " + eligible : "");
    });
  }

  function setMessage(kind, text) {
    state.message = text ? { kind: kind || "warn", text: text } : null;
    if (!ui.msg) return;
    if (!state.message) {
      ui.msg.style.display = "none";
      ui.msg.textContent = "";
      return;
    }
    ui.msg.style.display = "";
    ui.msg.setAttribute("data-k", state.message.kind);
    ui.msg.textContent = state.message.text;
  }

  function render() {
    renderFilters();
    renderQuick();
    renderList();
    renderFoot();
  }

  /* ---------- 动作执行 ---------- */

  function act(kind) {
    var ids = CORE.splitByAction(state.chats, selectedIds(), false)[kind] || [];
    if (!ids.length) return;
    if (kind === "delete") return askDelete(ids);
    runBatch(kind, ids);
  }

  function runBatch(kind, ids) {
    state.busy = true;
    renderFoot();
    var done = function (text, kindOfMsg) {
      state.busy = false;
      setMessage(kindOfMsg || "ok", text);
      render();
    };
    var fail = function (err) {
      state.busy = false;
      setMessage("err", t("操作失败：", "Failed: ") + ((err && err.message) || err));
      render();
    };
    if (kind === "archive") {
      setMessage("warn", t("正在归档 " + ids.length + " 个…", "Archiving " + ids.length + "…"));
      return doArchive(ids)
        .then(function (r) {
          var reasons = CORE.countReasons(r.failed);
          var extra = Object.keys(reasons)
            .map(function (k) {
              return k + " " + reasons[k];
            })
            .join(", ");
          done(
            t(
              "归档完成：成功 " + r.succeeded.length + "，失败 " + r.failed.length + (extra ? "（" + extra + "）" : ""),
              "Archived " + r.succeeded.length + ", failed " + r.failed.length + (extra ? " (" + extra + ")" : ""),
            ),
            r.failed.length ? "warn" : "ok",
          );
        })
        .then(function () {
          clearSelection();
          return refresh({ silent: true });
        })
        .catch(fail);
    }
    if (kind === "unarchive") {
      setMessage("warn", t("正在还原 " + ids.length + " 个…", "Unarchiving " + ids.length + "…"));
      return doUnarchive(ids)
        .then(function (r) {
          var reasons = CORE.countReasons(r.failed);
          var extra = Object.keys(reasons)
            .map(function (k) {
              return k + " " + reasons[k];
            })
            .join(", ");
          done(
            t(
              "还原完成：成功 " + r.succeeded.length + "，失败 " + r.failed.length + (extra ? "（" + extra + "）" : ""),
              "Unarchived " + r.succeeded.length + ", failed " + r.failed.length + (extra ? " (" + extra + ")" : ""),
            ),
            r.failed.length ? "warn" : "ok",
          );
        })
        .then(function () {
          clearSelection();
          return refresh({ silent: true });
        })
        .catch(fail);
    }
  }

  /* ---------- 删除确认 ---------- */

  function askDelete(ids) {
    closeConfirm();
    var byId = {};
    state.chats.forEach(function (c) {
      byId[c.id] = c;
    });
    var names = ids.map(function (id) {
      var c = byId[id];
      return c ? (c.name || c.session_id || id) : id;
    });
    var runningIds = ids.filter(function (id) {
      return byId[id] && CORE.isRunning(byId[id]);
    });
    var curIn = !!state.currentChatId && ids.indexOf(state.currentChatId) >= 0;

    var runningOpt = el("label", { class: "qcb-chk", style: "display:flex;margin:6px 0" }, [
      el("input", { type: "checkbox", checked: false }),
      el("span", {
        text: t(
          "同时删除运行中的会话（" + runningIds.length + " 个）：会让正在跑的任务失去会话记录",
          "Also delete running chats (" + runningIds.length + "): the running tasks lose their chat record",
        ),
      }),
    ]);
    var ack = el("label", { class: "qcb-chk", style: "display:flex;margin:6px 0" }, [
      el("input", { type: "checkbox", checked: false }),
      el("span", { text: t("我已确认：删除不可撤销", "I understand: deletion cannot be undone") }),
    ]);
    var okBtn = el("button", { "data-primary": "true", disabled: true, text: t("确认删除", "Delete"), onclick: function () { onOk(); } });
    var box = el("div", { class: "qcb-confirm" }, [
      el("h4", { text: t("确认删除 " + ids.length + " 个会话？", "Delete " + ids.length + " chats?") }),
      el("div", { class: "qcb-warn", text: t("会话记录与检查点会一并删除，不可撤销；会话的 JSONSession 状态文件不会被删（宿主接口如此）。", "The chat record and its checkpoints are removed permanently; the JSONSession state file is not (host API behaviour).") }),
      curIn ? el("div", { class: "qcb-warn", text: t("包含你当前打开的会话，删掉后当前页面会失去这个会话。", "Includes the chat you currently have open.") }) : null,
      runningIds.length ? el("div", {}, [el("div", { class: "qcb-warn", text: t("其中 " + runningIds.length + " 个正在运行，默认会被跳过。", runningIds.length + " of them are running and will be skipped by default.") }), runningOpt]) : null,
      el("ul", {}, names.slice(0, 8).map(function (nm) {
        return el("li", { text: nm });
      }).concat(names.length > 8 ? [el("li", { text: t("…等共 " + names.length + " 个", "… total " + names.length) })] : [])),
      ack,
      el("div", { class: "qcb-acts" }, [el("button", { text: t("取消", "Cancel"), onclick: closeConfirm }), okBtn]),
    ]);

    ui.confirm = box;
    doc.body.appendChild(box);
    positionConfirm();
    var syncOk = function () {
      var extra = runningOpt.querySelector("input").checked ? runningIds : [];
      var total = ids.filter(function (id) {
        return extra.indexOf(id) < 0;
      });
      okBtn.disabled = !ack.querySelector("input").checked || total.length === 0;
      okBtn.textContent = total.length ? t("确认删除 " + total.length + " 个", "Delete " + total.length) : t("没有可删除的", "Nothing to delete");
    };
    ack.querySelector("input").addEventListener("change", syncOk);
    runningOpt.querySelector("input").addEventListener("change", syncOk);
    syncOk();

    function onOk() {
      var includeRunning = runningOpt.querySelector("input").checked;
      var targets = includeRunning
        ? ids
        : ids.filter(function (id) {
            return !(byId[id] && CORE.isRunning(byId[id]));
          });
      closeConfirm();
      state.busy = true;
      renderFoot();
      setMessage("warn", t("正在删除 " + targets.length + " 个…", "Deleting " + targets.length + "…"));
      doDelete(targets)
        .then(function (r) {
          state.busy = false;
          var text = t("删除完成：已删除 " + r.gone.length + " / " + targets.length, "Deleted " + r.gone.length + " / " + targets.length);
          if (r.left.length) text += t("，仍有 " + r.left.length + " 个在列表中（服务端未删掉）", ", " + r.left.length + " still listed");
          setMessage(r.left.length ? "warn" : "ok", text);
          clearSelection();
          render();
          return refresh({ silent: true });
        })
        .catch(function (err) {
          state.busy = false;
          setMessage("err", t("删除失败：", "Delete failed: ") + ((err && err.message) || err));
          render();
        });
    }
  }

  function positionConfirm() {
    if (!ui.confirm) return;
    var w = 420;
    var left = Math.max(8, Math.round((window.innerWidth - w) / 2));
    var top = Math.max(8, Math.round((window.innerHeight - 260) / 2));
    ui.confirm.style.left = left + "px";
    ui.confirm.style.top = top + "px";
    ui.confirm.style.width = w + "px";
  }

  function closeConfirm() {
    if (ui.confirm && ui.confirm.parentNode) ui.confirm.parentNode.removeChild(ui.confirm);
    ui.confirm = null;
  }

  /* ---------- 开关 / 刷新 ---------- */

  /**
   * 重新拉列表并重绘。
   * opts.silent = true 时不写「已加载 N 个会话」，也不清空当前提示——
   * 批量操作后要用它，否则操作结果会被这句加载提示盖掉（报错仍然照常显示）。
   */
  function refresh(opts) {
    var silent = !!(opts && opts.silent);
    state.loading = true;
    if (!silent) setMessage(null);
    return listChats()
      .then(function (chats) {
        state.loading = false;
        render();
        if (!silent) setMessage("ok", t("已加载 " + chats.length + " 个会话", "Loaded " + chats.length + " chats"));
        return chats;
      })
      .catch(function (err) {
        state.loading = false;
        render();
        setMessage("err", t("加载失败：", "Load failed: ") + ((err && err.message) || err));
        throw err;
      });
  }

  function openPanel(anchorRect) {
    if (!doc) return;
    if (!ui.panel) doc.body.appendChild(buildPanel());
    if (!ui.mask) {
      ui.mask = el("div", {
        class: "qcb-mask",
        onclick: function () {
          close();
        },
      });
    }
    state.anchorRect = anchorRect || state.anchorRect || null;
    doc.body.appendChild(ui.mask);
    ui.panel.style.display = "";
    state.open = true;
    state.currentChatId = currentChatIdFromUrl();
    state.rows = RENDER_STEP;
    syncButtons();
    positionPanel();
    render();
    refresh().catch(function () {
      /* 错误已显示在面板里 */
    });
  }

  function close() {
    state.open = false;
    if (ui.panel) ui.panel.style.display = "none";
    if (ui.mask && ui.mask.parentNode) ui.mask.parentNode.removeChild(ui.mask);
    closeConfirm();
    syncButtons();
  }

  function toggle(anchorRect) {
    if (state.open) close();
    else openPanel(anchorRect);
  }

  /** 面板贴着按钮展开：横向不溢出视口，纵向不够高就往上挪 */
  function positionPanel() {
    if (!ui.panel) return;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var rect = state.anchorRect;
    var left;
    var top;
    if (rect && rect.width) {
      left = rect.left + rect.width - PANEL_W; // 右边缘对齐按钮
      if (left < 8) left = rect.left;
      if (left + PANEL_W > vw - 8) left = vw - PANEL_W - 8;
      top = rect.bottom + 6;
    } else {
      left = vw - PANEL_W - 12;
      top = 56;
    }
    left = Math.max(8, Math.round(left));
    top = Math.max(8, Math.round(top));
    var maxH = Math.min(Math.round(vh * 0.72), vh - top - 12);
    if (maxH < 260) {
      top = Math.max(8, vh - 272);
      maxH = Math.min(Math.round(vh * 0.72), vh - top - 12);
    }
    ui.panel.style.left = left + "px";
    ui.panel.style.top = top + "px";
    ui.panel.style.right = "auto";
    ui.panel.style.maxHeight = Math.max(200, maxH) + "px";
  }

  /* ================================================================== *
   * 八、入口按钮：塞进侧栏「历史对话」那一行的操作区
   *    （class 前缀 sidebarSessionList-module__historyActions）
   *    宿主那行是 React 渲染的，插件不能塞进它的 React 树里（没有对应 slot），
   *    所以用原生 DOM 挂一个按钮到那行的末尾：样式对齐宿主自己的 26×26 图标按钮，
   *    **只在同一行内多一个图标，不新占一行、不改行高**；React 重建 DOM 后由
   *    定时器 + MutationObserver 重新挂上（与「历史对话右置」同一套做法）。
   * ================================================================== */

  var SEL_ACTIONS = '[class*="sidebarSessionList-module__historyActions"]';
  var SEL_SESSION_AREA = '[class*="index-module__sessionArea"]';
  var BTN_CLASS = "qcb-inline-btn";

  /** lucide 的 list-checks，与宿主自己的图标同源同尺寸（16×16、stroke=currentColor） */
  var ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M11 18H3"/><path d="m15 18 2 2 4-4"/><path d="M16 12H3"/><path d="M16 6H3"/></svg>';

  var inlineBtns = [];

  function buttonTitle() {
    return t("会话批量管理：按条件批量删除 / 归档 / 还原", "Batch chat manager: bulk delete / archive");
  }

  function buildInlineButton() {
    var btn = el("button", {
      type: "button",
      class: "qcb-btn " + BTN_CLASS,
      title: buttonTitle(),
      "aria-label": buttonTitle(),
      "aria-expanded": "false",
    });
    btn.innerHTML = ICON_SVG;
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggle(btn.getBoundingClientRect());
    });
    return btn;
  }

  /** 把入口按钮挂进侧栏历史操作行（每 tick 幂等；宿主重建 DOM 后自动补回） */
  function mountInlineButton() {
    if (!doc) return;
    var rows = doc.querySelectorAll(SEL_ACTIONS);
    if (!rows.length) {
      // 侧栏折叠 / 聊天面未就绪：宿主那一行不存在，面板也一起收掉，不留孤儿
      if (state.open) close();
      inlineBtns = [];
      return;
    }
    inlineBtns = [];
    Array.prototype.forEach.call(rows, function (row) {
      var existing = row.querySelector("." + BTN_CLASS);
      var btn = existing || buildInlineButton();
      if (!existing) row.appendChild(btn);
      inlineBtns.push(btn);
    });
    syncButtons();
  }

  function syncButtons() {
    inlineBtns.forEach(function (b) {
      if (b && b.parentNode) b.setAttribute("aria-expanded", String(!!state.open));
    });
    if (state.open) {
      var anchor = inlineBtns[0];
      if (anchor && anchor.parentNode) state.anchorRect = anchor.getBoundingClientRect();
    }
  }

  function updateButtonLabels() {
    inlineBtns.forEach(function (b) {
      if (!b || !b.parentNode) return;
      b.setAttribute("title", buttonTitle());
      b.setAttribute("aria-label", buttonTitle());
    });
  }

  /* ================================================================== *
   * 九、启动
   * ================================================================== */

  function onKey(e) {
    if (e.key === "Escape") {
      if (ui.confirm) closeConfirm();
      else if (state.open) close();
    }
  }

  var mo = null;
  var moTimer = null;

  /** 侧栏 DOM 一变（React 重建、折叠展开、切分组）就轻量重挂一次按钮 */
  function observeSidebar() {
    if (mo) return;
    var target = doc.querySelector('[class*="index-module__sider__"]') || doc.querySelector(SEL_SESSION_AREA) || doc.body;
    try {
      mo = new MutationObserver(function () {
        if (moTimer) return;
        moTimer = setTimeout(function () {
          moTimer = null;
          mountInlineButton();
        }, 200);
      });
      mo.observe(target, { childList: true, subtree: true });
    } catch (e) {
      /* ignore */
    }
  }

  function boot() {
    ZH = detectZh();
    injectStyle();
    mountInlineButton();
    doc.addEventListener("keydown", onKey);
    window.addEventListener("resize", function () {
      positionPanel();
      positionConfirm();
    });
    window.addEventListener("scroll", positionPanel, true);
    setInterval(mountInlineButton, 1500);
    // 首屏宿主是异步渲染的，前几秒多挂几次，之后交给定时器与观察器
    [300, 800, 1500, 2500, 4000].forEach(function (ms) {
      setTimeout(mountInlineButton, ms);
    });
    // 一直挂不上就报一声：多半是宿主改了这个类名前缀，改 SEL_ACTIONS 即可
    setTimeout(function () {
      if (!inlineBtns.length) {
        console.warn("[" + PLUGIN_ID + "] 找不到侧栏历史操作行（选择器 " + SEL_ACTIONS + "），入口按钮未挂载；宿主改版时改这个选择器即可");
      }
    }, 6000);
    observeSidebar();
    console.log("[" + PLUGIN_ID + "] 已加载 v" + VERSION + "（会话批量管理，入口在侧栏历史对话行）");
  }

  // 自检入口（调试与自动化测试用；不影响宿主）
  if (typeof window !== "undefined") {
    window.__qwenpawChatBatch = {
      pluginId: PLUGIN_ID,
      version: VERSION,
      core: CORE,
      state: state,
      open: function () {
        openPanel(inlineBtns[0] ? inlineBtns[0].getBoundingClientRect() : null);
      },
      close: close,
      toggle: toggle,
      refresh: refresh,
      filtered: filtered,
      visible: visibleSorted,
      act: act,
      buttons: function () {
        return inlineBtns.slice();
      },
      api: {
        list: listChats,
        archive: doArchive,
        unarchive: doUnarchive,
        remove: doDelete,
      },
      setFilters: function (patch) {
        Object.assign(state.filters, patch || {});
        saveFilters();
        render();
      },
      /** 手动切中英文案（自检/自动化用；正常跟随宿主界面语言） */
      setLang: function (zh) {
        ZH = !!zh;
        updateButtonLabels();
        if (ui.panel) render();
      },
    };
  }

  if (typeof module === "object" && module.exports) module.exports = CORE;
  if (typeof document !== "undefined" && document) {
    if (document.body) boot();
    else document.addEventListener("DOMContentLoaded", boot, { once: true });
  }
})();
