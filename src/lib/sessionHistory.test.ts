import { describe, expect, it } from "vitest";
import { buildSessionHistory, deriveHistorySelection } from "./sessionHistory";

describe("恢复会话列表", () => {
  it("按最近活动排序并按 ID 去重，保留同名的不同会话和输入快照", () => {
    const snapshots = [
      { session_id: "older", title: "修复登录", updated_at: 10, cwd: "/workspace/old" },
      { session_id: "newer", title: "修复登录", updated_at: 30, cwd: "/workspace/new" },
      { session_id: "older", title: "旧标题", updated_at: 5, cwd: "/workspace/stale" },
      { session_id: " ", title: "无效会话", updated_at: 50 },
      { session_id: "undated", title: "日期未知", updated_at: NaN },
    ];
    const original = structuredClone(snapshots);
    const history = buildSessionHistory(snapshots);
    expect(history.map((item) => item.sessionId)).toEqual(["newer", "older", "undated"]);
    expect(history.slice(0, 2).map((item) => item.title)).toEqual(["修复登录", "修复登录"]);
    expect(history[1].cwd).toBe("/workspace/old");
    expect(history[2].updatedLabel).toBe("时间未知");
    expect(snapshots).toEqual(original);
  });

  it("最新快照缺少标题或目录时，从同一 ID 的历史记录补齐", () => {
    const [item] = buildSessionHistory([
      { session_id: "same", updated_at: 20, title: "  ", cwd: null },
      { session_id: "same", updated_at: 10, title: "整理\n  中文会话名", cwd: "/workspace/project/" },
    ]);
    expect(item).toMatchObject({ title: "整理 中文会话名", cwd: "/workspace/project/", project: "project", updatedAt: 20 });
    expect(item.optionLabel).toMatch(/^整理 中文会话名 · project · /);
  });

  it("没有可读标题时用项目和时间生成中文名称，不把 UUID 当名称", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const time = new Date(2026, 9, 18, 10, 30).getTime() / 1000;
    const history = buildSessionHistory([
      { session_id: id, title: id, updated_at: time, cwd: "/workspace/中文项目" },
      { session_id: "no-title", updated_at: time + 60, cwd: "/workspace/中文项目" },
      { session_id: "unknown" },
    ]);
    expect(history[1].title).toBe("中文项目的会话 · 2026/10/18 10:30");
    expect(history[0].title).not.toBe(history[1].title);
    expect(history[1].optionLabel).not.toContain(id);
    expect(history[2].title).toBe("未指定项目的会话 · 时间未知");
  });
});

describe("选择历史会话", () => {
  const selected = buildSessionHistory([{ session_id: "resume", title: "恢复中文会话", cwd: "/workspace/resume" }])[0];
  const draft = { title: "会话 #1", cwd: "/workspace", titleEdited: false, cwdEdited: false };

  it("为未编辑的名称和目录填入历史值", () => {
    expect(deriveHistorySelection(selected, draft)).toEqual({ title: "恢复中文会话", cwd: "/workspace/resume" });
  });

  it("分别保护用户手工输入的名称和目录", () => {
    expect(deriveHistorySelection(selected, { ...draft, title: "我的标题", titleEdited: true }))
      .toEqual({ title: "我的标题", cwd: "/workspace/resume" });
    expect(deriveHistorySelection(selected, { ...draft, cwd: "/workspace/custom", cwdEdited: true }))
      .toEqual({ title: "恢复中文会话", cwd: "/workspace/custom" });
    expect(deriveHistorySelection(selected, { ...draft, titleEdited: true, cwdEdited: true }))
      .toEqual({ title: draft.title, cwd: draft.cwd });
  });

  it("没有历史目录或取消选择时，保留当前字段", () => {
    expect(deriveHistorySelection({ ...selected, cwd: null }, draft).cwd).toBe(draft.cwd);
    expect(deriveHistorySelection(undefined, draft)).toEqual({ title: draft.title, cwd: draft.cwd });
  });
});
