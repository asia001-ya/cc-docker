/**
 * 前端纯逻辑单元测试：分屏树、额度展示、校验、快捷键、剪贴板。
 */
import { describe, expect, it } from "vitest";
import { findLeaf, leaf, leaves, neighbor, remove, replaceSession, setRatio, split, type PaneNode } from "./splitTree";
import { blockBar, colorForRemaining, formatCountdown, formatReset, freshness, windowRemaining, HEALTH_COLOR } from "./quota";
import { buildSocks5Uri, deriveContainerPath, isWindowsDrivePath, parseEnvLines, validateContainerName, validatePort } from "./validators";
import { buildShortcuts, isPlainPaste, matchShortcut } from "./shortcuts";
import { choosePaste, oscWritesClipboard } from "./clipboard";

/**
 * 构造键盘事件替身（node 环境没有 KeyboardEvent）。
 * @param init 字段
 * @returns 事件对象
 */
function key(init: Partial<KeyboardEvent>): KeyboardEvent {
  return { type: "keydown", key: "", code: "", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...init } as KeyboardEvent;
}

describe("splitTree", () => {
  it("切分、查找、移除后兄弟上提", () => {
    let t: PaneNode = leaf("a");
    t = split(t, "a", "b", "row");
    t = split(t, "b", "c", "column");
    expect(leaves(t).map((l) => l.sessionId)).toEqual(["a", "b", "c"]);
    expect(findLeaf(t, "c")).toBeDefined();
    const r = remove(t, "b")!;
    expect(leaves(r).map((l) => l.sessionId)).toEqual(["a", "c"]);
    expect(remove(leaf("x"), "x")).toBeNull();
  });

  it("未命中目标时返回同一引用", () => {
    const t = split(leaf("a"), "a", "b", "row");
    expect(split(t, "zzz", "c", "row")).toBe(t);
    expect(replaceSession(t, "zzz", "y")).toBe(t);
  });

  it("替换会话、比例夹取与焦点循环", () => {
    let t = split(leaf("a"), "a", "b", "row");
    t = replaceSession(t, "b", "b2");
    expect(leaves(t).map((l) => l.sessionId)).toEqual(["a", "b2"]);
    if (t.type !== "split") throw new Error("应为分支");
    expect((setRatio(t, t.id, 2) as typeof t).ratio).toBe(0.9);
    expect(neighbor(t, "b2", 1)).toBe("a");
    expect(neighbor(t, "a", -1)).toBe("b2");
  });
});

describe("quota", () => {
  const now = 1_792_120_000;
  it("剩余百分比与重置推断", () => {
    expect(windowRemaining({ used_percentage: 15, resets_at: now + 100 }, now)).toEqual({ pct: 85, inferred: false });
    expect(windowRemaining({ used_percentage: 100, resets_at: now - 1 }, now)).toEqual({ pct: 100, inferred: true });
    expect(windowRemaining(null, now)).toBeNull();
  });

  it("颜色阈值与进度条", () => {
    expect(colorForRemaining(85)).toBe(HEALTH_COLOR.healthy);
    expect(colorForRemaining(30)).toBe(HEALTH_COLOR.warning);
    expect(colorForRemaining(4)).toBe(HEALTH_COLOR.exhausted);
    expect(blockBar(85)).toBe("■■■■■■■■■░");
    expect(blockBar(0, 4)).toBe("░░░░");
  });

  it("倒计时与新鲜度文案", () => {
    expect(formatCountdown(now + 2 * 3600 + 13 * 60, now)).toBe("2小时13分");
    expect(formatCountdown(now + 3 * 86400 + 7200, now)).toBe("3天2小时");
    expect(formatCountdown(now - 5, now)).toBe("即将重置");
    expect(freshness(now - 30, now)).toBe("刚刚");
    expect(freshness(now - 720, now)).toBe("12 分钟前");
    expect(freshness(null, now)).toBe("未上报");
    expect(formatReset(now + 60, now)).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe("validators", () => {
  it("容器名、端口、环境变量", () => {
    expect(validateContainerName("claude-dev-05")).toBeNull();
    expect(validateContainerName("Claude")).not.toBeNull();
    expect(validatePort(3000, 1024)).toBeNull();
    expect(validatePort(80, 1024)).not.toBeNull();
    const r = parseEnvLines("# 注释\nA=1\nB = x=y\n坏\n1X=2");
    expect(r.env).toEqual(["A=1", "B= x=y"]);
    expect(r.errors).toHaveLength(2);
  });

  it("容器路径推导与盘符识别", () => {
    expect(deriveContainerPath("D:\\Projects\\My App")).toBe("/workspace/my-app");
    expect(deriveContainerPath("\\\\wsl$\\Ubuntu\\home\\me\\api")).toBe("/workspace/api");
    expect(isWindowsDrivePath("D:\\x")).toBe(true);
    expect(isWindowsDrivePath("\\\\wsl$\\Ubuntu")).toBe(false);
  });

  it("SOCKS5 表单拼接规范链接", () => {
    const f = { host: " 203.0.113.9 ", port: "1080", username: "us@er", password: "p@ss:w/d%" };
    expect(buildSocks5Uri(f)).toEqual({ uri: "socks5://us%40er:p%40ss%3Aw%2Fd%25@203.0.113.9:1080" });
    expect(buildSocks5Uri({ ...f, username: "", password: "" })).toEqual({ uri: "socks5://203.0.113.9:1080" });
    expect(buildSocks5Uri({ ...f, password: "" })).toEqual({ uri: "socks5://us%40er@203.0.113.9:1080" });
    expect(buildSocks5Uri({ ...f, host: "2001:db8::1" })).toEqual({ uri: "socks5://us%40er:p%40ss%3Aw%2Fd%25@[2001:db8::1]:1080" });
    expect(buildSocks5Uri({ ...f, host: "" }).error).toBeTruthy();
    expect(buildSocks5Uri({ ...f, host: "a b" }).error).toBeTruthy();
    expect(buildSocks5Uri({ ...f, port: "0" }).error).toBeTruthy();
    expect(buildSocks5Uri({ ...f, port: "65536" }).error).toBeTruthy();
    expect(buildSocks5Uri({ ...f, port: "1080x" }).error).toBeTruthy();
    expect(buildSocks5Uri({ ...f, username: "" }).error).toBe("填写了密码时必须填写用户名");
  });
});

describe("shortcuts", () => {
  it("关闭快捷键只处理一次，已消费的事件不再触发关闭", () => {
    const list = buildShortcuts("ctrl+shift+b");
    const close = { key: "W", ctrlKey: true, shiftKey: true };
    expect(matchShortcut(list, key(close))).toBe("closeSession");
    expect(matchShortcut(list, key({ ...close, defaultPrevented: true }))).toBeNull();
    expect(matchShortcut(list, key({ ...close, type: "keyup" }))).toBeNull();
  });

  it("默认侧栏键为 Ctrl+Shift+B，不拦截 Ctrl+B", () => {
    const list = buildShortcuts("ctrl+shift+b");
    expect(matchShortcut(list, key({ key: "B", ctrlKey: true, shiftKey: true }))).toBe("toggleSidebar");
    expect(matchShortcut(list, key({ key: "b", ctrlKey: true }))).toBeNull();
  });

  it("可切换为 Ctrl+B；分屏键按物理键位匹配", () => {
    const list = buildShortcuts("ctrl+b");
    expect(matchShortcut(list, key({ key: "b", ctrlKey: true }))).toBe("toggleSidebar");
    expect(matchShortcut(list, key({ key: "|", code: "Backslash", ctrlKey: true, shiftKey: true }))).toBe("splitRight");
    expect(matchShortcut(list, key({ key: "_", code: "Minus", ctrlKey: true, shiftKey: true }))).toBe("splitDown");
    expect(matchShortcut(list, key({ key: "c", ctrlKey: true }))).toBeNull();
    expect(matchShortcut(list, key({ type: "keyup", key: "t", ctrlKey: true, shiftKey: true }))).toBeNull();
  });
});

describe("clipboard", () => {
  it("Ctrl+V 识别为原生粘贴，带其它修饰键或 keyup 不算", () => {
    expect(isPlainPaste(key({ key: "v", ctrlKey: true }))).toBe(true);
    expect(isPlainPaste(key({ key: "V", ctrlKey: true }))).toBe(true);
    expect(isPlainPaste(key({ key: "v", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isPlainPaste(key({ key: "v", ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPlainPaste(key({ type: "keyup", key: "v", ctrlKey: true }))).toBe(false);
    expect(isPlainPaste(key({ key: "v" }))).toBe(false);
  });

  it("有文本时粘贴文本，否则取支持的图片类型", () => {
    expect(choosePaste("hello", ["text/plain", "image/png"])).toEqual({ kind: "text" });
    expect(choosePaste("", ["text/html", "image/png"])).toEqual({ kind: "image", mime: "image/png" });
    expect(choosePaste("", ["image/bmp"])).toBeNull();
    expect(choosePaste("", [])).toBeNull();
  });

  it("OSC 52：tmux 的空选区与 c/p/s 写系统剪贴板，纯 cut buffer 忽略", () => {
    expect(oscWritesClipboard("")).toBe(true);
    expect(oscWritesClipboard("c")).toBe(true);
    expect(oscWritesClipboard("pc")).toBe(true);
    expect(oscWritesClipboard("s")).toBe(true);
    expect(oscWritesClipboard("0")).toBe(false);
  });
});
