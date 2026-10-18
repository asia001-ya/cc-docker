import { describe, expect, it } from "vitest";
import type { FleetEntry, SessionRecord, SessionSnapshot } from "../api/types";
import { buildSessionCatalog, filterSessionCatalog, findOpenSessionForHistory, type SessionCatalogInput } from "./sessionCatalog";

function entry(name: string, snapshots: SessionSnapshot[] = [], running = true): FleetEntry {
  return {
    container: {
      id: name, name, image: "tdc/claude-dev:latest", state: running ? "running" : "exited", status: "", running,
      slot: 1, authMode: "subscription", providerId: null, sharedGroup: "default", ports: [], mounts: [],
    },
    health: running ? "unknown" : "stopped", remaining: null, quota: null, blockedUntil: null, account: null,
    provider: null, ports: [], sessions: snapshots, error: null, limitHit: false, proxy: null,
  };
}

function record(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return { id, container: "one", title: "会话 #1", cwd: "/workspace/app", mode: "claude", args: [], env: [], tmux: true, createdAt: 1, ...overrides };
}

function input(overrides: Partial<SessionCatalogInput> = {}): SessionCatalogInput {
  return { entries: [], sessions: {}, openSessionIds: [], exited: {}, activeSessionId: null, ...overrides };
}

describe("底部会话目录", () => {
  it("仅列出树中打开的终端，保持打开顺序并去重，忽略残留记录和预览 ID", () => {
    const data = input({
      entries: [entry("one")], sessions: { a: record("a", { title: "终端甲" }), b: record("b", { title: "终端乙" }), stale: record("stale") },
      openSessionIds: ["b", "pv:preview", "a", "b", "missing"], activeSessionId: "a",
    });
    const rows = buildSessionCatalog(data);
    expect(rows.map((row) => row.openSessionId)).toEqual(["b", "a"]);
    expect(rows.map((row) => row.title)).toEqual(["终端乙", "终端甲"]);
    expect(rows.map((row) => row.isActive)).toEqual([false, true]);
    expect(rows.every((row) => row.kind === "open" && row.containerRunning)).toBe(true);
  });

  it("默认终端名使用最新匹配快照标题和目录，自定义终端名称不覆盖", () => {
    const snapshots: SessionSnapshot[] = [
      { tdc_session_id: "a", session_id: "old", title: "旧会话", cwd: "/workspace/old", updated_at: 10 },
      { tdc_session_id: "a", session_id: "current", title: "修复中文列表", cwd: "/workspace/new", updated_at: 30 },
      { tdc_session_id: "b", session_id: "custom", title: "Claude 自动标题", cwd: "/workspace/custom", updated_at: 20 },
    ];
    const rows = buildSessionCatalog(input({
      entries: [entry("one", snapshots)], sessions: { a: record("a"), b: record("b", { title: "我的部署终端" }) }, openSessionIds: ["a", "b"],
    }));
    expect(rows[0]).toMatchObject({ title: "修复中文列表", cwd: "/workspace/new", project: "new", claudeSessionId: "current", updatedAt: 30 });
    expect(rows[1].title).toBe("我的部署终端");
    expect(rows.filter((row) => row.kind === "history").map((row) => row.claudeSessionId)).toEqual(["old"]);
  });

  it("手动退出再启动后的快照覆盖旧 resume 参数，不把旧历史误认为已打开", () => {
    const sessions = { a: record("a", { args: ["--resume", "old"] }) };
    const entries = [entry("one", [
      { tdc_session_id: "a", session_id: "new", title: "新对话", updated_at: 20 },
      { session_id: "old", title: "原来的对话", updated_at: 10 },
    ])];
    const rows = buildSessionCatalog(input({ sessions, entries, openSessionIds: ["a"] }));
    expect(rows.map((row) => [row.kind, row.claudeSessionId])).toEqual([["open", "new"], ["history", "old"]]);
    expect(findOpenSessionForHistory("one", "old", sessions, entries, ["a"], {})).toBeNull();
    expect(findOpenSessionForHistory("one", "new", sessions, entries, ["a"], {})).toBe("a");
  });

  it("最新匹配快照 ID 为空时禁止回退到较旧快照或 resume 参数", () => {
    const sessions = { a: record("a", { args: ["--resume=old"] }) };
    const entries = [entry("one", [
      { tdc_session_id: "a", session_id: "old", title: "旧对话", updated_at: 10 },
      { tdc_session_id: "a", session_id: "  ", title: "刚打开的终端", updated_at: 20 },
    ])];
    const rows = buildSessionCatalog(input({ sessions, entries, openSessionIds: ["a"] }));
    expect(rows[0].claudeSessionId).toBeNull();
    expect(rows.find((row) => row.kind === "history")?.claudeSessionId).toBe("old");
    expect(findOpenSessionForHistory("one", "old", sessions, entries, ["a"], {})).toBeNull();
  });

  it("无当前快照时支持两种 resume 参数，纯 shell 和 -- 后的参数不产生错误匹配", () => {
    const sessions = {
      a: record("a", { args: ["--resume", "first"] }),
      b: record("b", { args: ["--resume=second"] }),
      shell: record("shell", { mode: "bash", args: ["--resume", "shell-id"] }),
      literal: record("literal", { args: ["--", "--resume", "literal-id"] }),
      picker: record("picker", { args: ["--resume"] }),
      flag: record("flag", { args: ["--resume", "--verbose"] }),
    };
    const entries = [entry("one", [{ session_id: "first", title: "恢复第一项" }, { session_id: "second", title: "恢复第二项" }])];
    const openSessionIds = Object.keys(sessions);
    const rows = buildSessionCatalog(input({ sessions, entries, openSessionIds }));
    expect(rows.map((row) => row.claudeSessionId)).toEqual(["first", "second", null, null, null, null]);
    expect(findOpenSessionForHistory("one", "first", sessions, entries, openSessionIds, {})).toBe("a");
    expect(findOpenSessionForHistory("one", "second", sessions, entries, openSessionIds, {})).toBe("b");
    expect(findOpenSessionForHistory("one", "shell-id", sessions, entries, openSessionIds, {})).toBeNull();
  });

  it("纯 shell 中启动 Claude 时仍使用 tdc 快照进行匹配", () => {
    const sessions = { shell: record("shell", { mode: "bash" }) };
    const entries = [entry("one", [{ tdc_session_id: "shell", session_id: "manual", title: "手工启动的会话" }])];
    expect(findOpenSessionForHistory("one", "manual", sessions, entries, ["shell"], {})).toBe("shell");
    expect(buildSessionCatalog(input({ sessions, entries, openSessionIds: ["shell"] }))).toHaveLength(1);
  });

  it("按容器隔离同一 Claude ID，跨容器共享历史不会错误去重或定位", () => {
    const sessions = { a: record("a") };
    const entries = [
      entry("one", [{ tdc_session_id: "a", session_id: "same", title: "源容器对话", updated_at: 10 }]),
      entry("two", [{ tdc_session_id: "a", session_id: "same", title: "目标容器对话", updated_at: 20 }]),
    ];
    const rows = buildSessionCatalog(input({ sessions, entries, openSessionIds: ["a"] }));
    expect(rows.map((row) => [row.kind, row.container, row.claudeSessionId])).toEqual([["open", "one", "same"], ["history", "two", "same"]]);
    expect(findOpenSessionForHistory("two", "same", sessions, entries, ["a"], {})).toBeNull();
    const histories = buildSessionCatalog(input({ entries }));
    expect(new Set(histories.map((row) => row.key)).size).toBe(2);
  });

  it("退出码为 0 或 null 的终端均已退出，不隐藏可恢复历史，不把残留记录视为打开", () => {
    const sessions = { a: record("a", { args: ["--resume=first"] }), b: record("b", { args: ["--resume=second"] }), stale: record("stale", { args: ["--resume=third"] }) };
    const entries = [entry("one", [
      { session_id: "first", title: "第一项" }, { session_id: "second", title: "第二项" }, { session_id: "third", title: "第三项" },
    ])];
    const exited = { a: 0, b: null };
    const rows = buildSessionCatalog(input({ sessions, entries, openSessionIds: ["a", "b"], exited }));
    expect(rows.slice(0, 2).map((row) => row.exited)).toEqual([true, true]);
    expect(rows.filter((row) => row.kind === "history")).toHaveLength(3);
    for (const id of ["first", "second", "third"]) expect(findOpenSessionForHistory("one", id, sessions, entries, ["a", "b"], exited)).toBeNull();
  });

  it("历史使用已有中文名称逻辑去重，最近在前，缺目录和停止容器仍展示", () => {
    const entries = [entry("one", [
      { session_id: "same", title: "最新中文名称", cwd: null, updated_at: 40 },
      { session_id: "same", title: "旧名称", cwd: "/workspace/历史项目", updated_at: 10 },
      { session_id: "no-cwd", updated_at: 30 },
      { session_id: "invalid-time", title: "时间未知", updated_at: NaN },
    ], false), entry("two", [{ session_id: "recent", title: "最近对话", cwd: "/workspace/recent", updated_at: 50 }])];
    const original = structuredClone(entries);
    const rows = buildSessionCatalog(input({ entries }));
    expect(rows.map((row) => row.claudeSessionId)).toEqual(["recent", "same", "no-cwd", "invalid-time"]);
    expect(rows[1]).toMatchObject({ title: "最新中文名称", cwd: "/workspace/历史项目", project: "历史项目", containerRunning: false });
    expect(rows[2]).toMatchObject({ cwd: null, project: "未指定项目", openSessionId: null, isActive: false });
    expect(rows[2].title).toMatch(/^未指定项目的会话 · /);
    expect(rows[3]).toMatchObject({ updatedAt: null, updatedLabel: "时间未知" });
    expect(entries).toEqual(original);
  });

  it("默认终端名可从相同历史补齐缺失标题，缺少容器信息时仍保留打开终端", () => {
    const rows = buildSessionCatalog(input({
      entries: [entry("one", [
        { tdc_session_id: "a", session_id: "same", title: " ", updated_at: 20 },
        { session_id: "same", title: "补齐中文标题", updated_at: 10 },
      ])],
      sessions: { a: record("a"), absent: record("absent", { container: "missing", title: "保留终端", cwd: "", createdAt: NaN }) },
      openSessionIds: ["a", "absent"],
    }));
    expect(rows[0].title).toBe("补齐中文标题");
    expect(rows[1]).toMatchObject({ kind: "open", title: "保留终端", cwd: null, containerRunning: false, updatedAt: null, updatedLabel: "时间未知" });
  });

  it("终端名称是 UUID 时回退到对话标题或项目中文名称", () => {
    const uuid = "11111111-2222-4333-8444-555555555555";
    const rows = buildSessionCatalog(input({
      entries: [entry("one", [{ tdc_session_id: "known", session_id: "current", title: "实际中文对话名" }])],
      sessions: { known: record("known", { title: uuid }), unknown: record("unknown", { title: uuid, cwd: "/workspace/中文项目" }) },
      openSessionIds: ["known", "unknown"],
    }));
    expect(rows[0].title).toBe("实际中文对话名");
    expect(rows[1].title).toMatch(/^中文项目的会话 · /);
    expect(rows.every((row) => !row.title.includes(uuid))).toBe(true);
  });
});

describe("会话目录过滤", () => {
  it("按容器、类别及大小写无关的多个关键词过滤，不改变原列表排序", () => {
    const rows = buildSessionCatalog(input({
      entries: [entry("one", [{ session_id: "saved", title: "修复 Login 接口", cwd: "/workspace/server", updated_at: 30 }]), entry("two", [{ session_id: "other", title: "修复 Login 页面", cwd: "/workspace/client", updated_at: 40 }])],
      sessions: { a: record("a", { title: "实时终端" }) }, openSessionIds: ["a"],
    }));
    const keys = rows.map((row) => row.key);
    expect(filterSessionCatalog(rows, { container: "one", kind: "history", query: "LOGIN server" }).map((row) => row.claudeSessionId)).toEqual(["saved"]);
    expect(filterSessionCatalog(rows, { kind: "open" }).map((row) => row.openSessionId)).toEqual(["a"]);
    expect(filterSessionCatalog(rows, { query: "修复" }).map((row) => row.claudeSessionId)).toEqual(["other", "saved"]);
    expect(filterSessionCatalog(rows, { query: "不存在" })).toEqual([]);
    expect(filterSessionCatalog(rows)).toEqual(rows);
    expect(rows.map((row) => row.key)).toEqual(keys);
  });
});
