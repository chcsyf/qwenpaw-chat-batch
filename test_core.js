/**
 * qwenpaw-chat-batch 纯逻辑核心的单测（不依赖浏览器、不碰网络）。
 *
 *   node --test test_core.js      # Node 18+ 内置 test runner
 *
 * index.js 是 IIFE：没有 document 时不会启动，只在末尾把 CORE 挂到
 * module.exports，所以这里 require 它就能拿到纯函数。
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const CORE = require("./index.js");

/** 造一个会话（字段名与 GET /api/chats 的 ChatSpec 对齐） */
function chat(id, opts) {
  const o = opts || {};
  return {
    id,
    name: o.name || "chat-" + id,
    session_id: o.session_id || "console:" + id,
    source: o.source || "chat",
    status: o.status || "idle",
    archived: !!o.archived,
    created_at: o.created_at || "2026-01-01T00:00:00Z",
    updated_at: o.updated_at || "2026-01-01T00:00:00Z",
  };
}

// 固定「现在」，避免测试随着真实时间漂移
const NOW = Date.parse("2026-06-01T00:00:00Z");
const days = (n) => new Date(NOW - n * 86400000).toISOString();

test("chunk：按 500 切块，边界不丢不多", () => {
  assert.deepEqual(CORE.chunk([], 500), []);
  assert.deepEqual(CORE.chunk(["a"], 500), [["a"]]);
  assert.deepEqual(CORE.chunk(["a", "b", "c"], 2), [["a", "b"], ["c"]]);
  const many = Array.from({ length: 1001 }, (_, i) => String(i));
  const parts = CORE.chunk(many);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map((p) => p.length), [500, 500, 1]);
  assert.equal(parts.flat().length, 1001);
});

test("sortChats：最近活跃优先，时间相同按 id 稳定排序", () => {
  const list = [
    chat("b", { updated_at: days(1) }),
    chat("a", { updated_at: days(1) }),
    chat("c", { updated_at: days(9) }),
  ];
  assert.deepEqual(CORE.sortChats(list).map((c) => c.id), ["a", "b", "c"]);
});

test("lastActive：updated_at 缺失时退到 created_at", () => {
  assert.equal(CORE.lastActive({ created_at: "X" }), "X");
  assert.equal(CORE.lastActive({}), "");
  assert.equal(CORE.lastActive(null), "");
});

test("filterChats：视图（活跃 / 已归档 / 全部）", () => {
  const list = [chat("1"), chat("2", { archived: true })];
  const ids = (f) => CORE.filterChats(list, f, NOW).map((c) => c.id);
  assert.deepEqual(ids({ view: "active" }), ["1"]);
  assert.deepEqual(ids({ view: "archived" }), ["2"]);
  assert.deepEqual(ids({ view: "all" }), ["1", "2"]);
});

test("filterChats：来源 + 关键字（名称或 session_id，忽略大小写）", () => {
  const list = [
    chat("1", { source: "subagent", name: "Reindeer 书城面板" }),
    chat("2", { source: "cron", name: "nightly", session_id: "CRON:job-x" }),
    chat("3", { source: "subagent", name: "别的" }),
  ];
  const q = (f) => CORE.filterChats(list, f, NOW).map((c) => c.id);
  assert.deepEqual(q({ view: "all", source: "subagent" }), ["1", "3"]);
  assert.deepEqual(q({ view: "all", q: "reindeer" }), ["1"]);
  assert.deepEqual(q({ view: "all", q: "cron:job" }), ["2"]);
  assert.deepEqual(q({ view: "all", q: "   " }), ["1", "2", "3"]);
});

test("filterChats：时间窗口只留「早于 N 天」，隐藏运行中", () => {
  const list = [
    chat("fresh", { updated_at: days(0.5) }),
    chat("old5", { updated_at: days(5) }),
    chat("old40", { updated_at: days(40) }),
    chat("run", { updated_at: days(40), status: "running" }),
  ];
  assert.deepEqual(
    CORE.filterChats(list, { view: "all", ageDays: 3 }, NOW).map((c) => c.id),
    ["old5", "old40", "run"],
  );
  assert.deepEqual(
    CORE.filterChats(list, { view: "all", hideRunning: true }, NOW).map((c) => c.id),
    ["fresh", "old5", "old40"],
  );
  // 时间戳坏了就不算「早于」，避免误选中
  assert.deepEqual(CORE.filterChats([chat("bad", { updated_at: "not-a-date" })], { view: "all", ageDays: 1 }, NOW), []);
});

test("selectable：运行中一律不可选；归档/还原按当前状态", () => {
  const run = chat("r", { status: "running" });
  const act = chat("a");
  const arc = chat("b", { archived: true });
  assert.equal(CORE.selectable(run, "archive"), false);
  assert.equal(CORE.selectable(run, "delete"), false);
  assert.equal(CORE.selectable(run, "delete", true), true); // 显式允许
  assert.equal(CORE.selectable(act, "archive"), true);
  assert.equal(CORE.selectable(act, "unarchive"), false);
  assert.equal(CORE.selectable(arc, "archive"), false);
  assert.equal(CORE.selectable(arc, "unarchive"), true);
  assert.equal(CORE.selectable(arc, "delete"), true);
});

test("keepRecent：保留最近 N 个，其余选中，运行中跳过（等价 CLI --keep）", () => {
  const list = [
    chat("newest", { updated_at: days(1) }),
    chat("mid", { updated_at: days(2) }),
    chat("old1", { updated_at: days(3) }),
    chat("old2", { updated_at: days(4) }),
    chat("old-run", { updated_at: days(5), status: "running" }),
  ];
  const r = CORE.keepRecent(list, 2);
  assert.deepEqual(r.kept.map((c) => c.id), ["newest", "mid"]);
  assert.deepEqual(r.pick.map((c) => c.id), ["old1", "old2"]);
  assert.deepEqual(r.skippedRunning.map((c) => c.id), ["old-run"]);

  // keep=0 = 全选；keep 超过总数 = 一个都不选
  assert.equal(CORE.keepRecent(list, 0).pick.length, 4);
  assert.equal(CORE.keepRecent(list, 99).pick.length, 0);
  // keep 传脏值按 0 处理，不抛
  assert.equal(CORE.keepRecent(list, "abc").pick.length, 4);
});

test("splitByAction：按动作拆出可执行的 id，未选中的不掺进来", () => {
  const list = [chat("a"), chat("b", { archived: true }), chat("c", { status: "running" })];
  const s = CORE.splitByAction(list, ["a", "b", "c"], false);
  assert.deepEqual(s.archive, ["a"]);
  assert.deepEqual(s.unarchive, ["b"]);
  assert.deepEqual(s.delete, ["a", "b"]);
  assert.deepEqual(s.running, ["c"]);
  const s2 = CORE.splitByAction(list, ["c"], true);
  assert.deepEqual(s2.delete, ["c"]);
});

test("mergeBatchResult / countReasons：多分块结果合并与失败原因计数", () => {
  const merged = CORE.mergeBatchResult([
    { succeeded: ["a"], failed: [{ chat_id: "x", reason: "in_progress", message: "Chat is running" }] },
    { succeeded: ["b", "c"], failed: [{ chat_id: "y", reason: "not_found", message: "gone" }] },
  ]);
  assert.deepEqual(merged.succeeded, ["a", "b", "c"]);
  assert.equal(merged.failed.length, 2);
  assert.deepEqual(CORE.countReasons(merged.failed), { in_progress: 1, not_found: 1 });
  assert.deepEqual(CORE.mergeBatchResult([]), { succeeded: [], failed: [] });
});

test("diffDeleted：接口只回布尔，用前后列表 diff 报真实删除数", () => {
  assert.deepEqual(CORE.diffDeleted(["a", "b", "c"], ["c"]), { gone: ["a", "b"], left: ["c"] });
  assert.deepEqual(CORE.diffDeleted(["a"], []), { gone: ["a"], left: [] });
  assert.deepEqual(CORE.diffDeleted([], ["z"]), { gone: [], left: [] });
});

test("真实数据形状：字段名与 GET /api/chats 的返回一致（回归护栏）", () => {
  // 这几项是面板渲染与动作判定依赖的字段，改名就会静默失效，所以钉死
  const c = chat("x");
  ["id", "name", "session_id", "source", "status", "archived", "created_at", "updated_at"].forEach((k) => {
    assert.ok(k in c, "缺少字段 " + k);
  });
  assert.equal(CORE.MAX_BATCH, 500); // 与 app/chats/manager.py MAX_BATCH_SIZE 对齐
});
