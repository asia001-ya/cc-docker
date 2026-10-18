/**
 * 应用快捷键表与匹配。终端获得焦点时由 xterm 的 attachCustomKeyEventHandler 调用 matchShortcut，
 * 命中则阻止按键进入终端。
 *
 * 默认侧栏键为 Ctrl+Shift+B：Ctrl+B 是 Claude Code「转后台」、tmux 默认前缀与 bash 光标左移，不宜占用。
 * 终端无法区分 Ctrl+Shift+字母与 Ctrl+字母，因此拦截 Ctrl+Shift 组合不影响终端程序。
 */

/** 应用动作 */
export type Action =
  | "toggleSidebar"
  | "newSession"
  | "closeSession"
  | "splitRight"
  | "splitDown"
  | "nextTab"
  | "prevTab"
  | "focusNext"
  | "focusPrev"
  | "copy"
  | "paste"
  | "newContainer"
  | "settings"
  | "quotaFlyout"
  | "find"
  | "fontUp"
  | "fontDown";

/** 快捷键定义 */
export interface Shortcut {
  action: Action;
  /** 展示文本 */
  label: string;
  /** 说明 */
  desc: string;
  /** 匹配函数 */
  match: (e: KeyboardEvent) => boolean;
}

/**
 * 判断组合键。
 * @param e 键盘事件
 * @param key 键（小写字母或 e.key）
 * @param mods 需要的修饰键
 * @returns 是否匹配
 */
function combo(e: KeyboardEvent, key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean }): boolean {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return (
    k === key &&
    e.ctrlKey === !!mods.ctrl &&
    e.shiftKey === !!mods.shift &&
    e.altKey === !!mods.alt &&
    !e.metaKey
  );
}

/**
 * 生成快捷键表。
 * @param sidebarKey 侧栏快捷键设置（ctrl+shift+b / ctrl+b）
 * @returns 快捷键列表
 */
export function buildShortcuts(sidebarKey: string): Shortcut[] {
  const sidebarPlain = sidebarKey === "ctrl+b";
  return [
    {
      action: "toggleSidebar",
      label: sidebarPlain ? "Ctrl+B" : "Ctrl+Shift+B",
      desc: "展开 / 收起容器侧栏",
      match: (e) => combo(e, "b", { ctrl: true, shift: !sidebarPlain }),
    },
    { action: "newSession", label: "Ctrl+Shift+T", desc: "新建终端会话", match: (e) => combo(e, "t", { ctrl: true, shift: true }) },
    { action: "closeSession", label: "Ctrl+Shift+W", desc: "关闭当前会话", match: (e) => combo(e, "w", { ctrl: true, shift: true }) },
    {
      action: "splitRight",
      label: "Ctrl+Shift+\\",
      desc: "左右分屏",
      match: (e) => e.ctrlKey && e.shiftKey && !e.altKey && (e.code === "Backslash" || e.key === "|"),
    },
    {
      action: "splitDown",
      label: "Ctrl+Shift+-",
      desc: "上下分屏",
      match: (e) => e.ctrlKey && e.shiftKey && !e.altKey && (e.code === "Minus" || e.key === "_"),
    },
    { action: "nextTab", label: "Ctrl+Tab", desc: "下一个标签页", match: (e) => combo(e, "Tab", { ctrl: true }) },
    { action: "prevTab", label: "Ctrl+Shift+Tab", desc: "上一个标签页", match: (e) => combo(e, "Tab", { ctrl: true, shift: true }) },
    { action: "focusNext", label: "Alt+→", desc: "焦点移到下一个分屏", match: (e) => combo(e, "ArrowRight", { alt: true }) || combo(e, "ArrowDown", { alt: true }) },
    { action: "focusPrev", label: "Alt+←", desc: "焦点移到上一个分屏", match: (e) => combo(e, "ArrowLeft", { alt: true }) || combo(e, "ArrowUp", { alt: true }) },
    { action: "copy", label: "Ctrl+Shift+C", desc: "复制选中文本", match: (e) => combo(e, "c", { ctrl: true, shift: true }) },
    { action: "paste", label: "Ctrl+Shift+V", desc: "粘贴", match: (e) => combo(e, "v", { ctrl: true, shift: true }) },
    { action: "newContainer", label: "Ctrl+Shift+N", desc: "新建容器", match: (e) => combo(e, "n", { ctrl: true, shift: true }) },
    { action: "quotaFlyout", label: "Ctrl+Shift+Q", desc: "额度面板", match: (e) => combo(e, "q", { ctrl: true, shift: true }) },
    { action: "find", label: "Ctrl+Shift+F", desc: "在终端中搜索", match: (e) => combo(e, "f", { ctrl: true, shift: true }) },
    { action: "settings", label: "Ctrl+,", desc: "设置", match: (e) => combo(e, ",", { ctrl: true }) },
    { action: "fontUp", label: "Ctrl+=", desc: "放大字号", match: (e) => e.ctrlKey && !e.altKey && (e.key === "=" || e.key === "+") },
    { action: "fontDown", label: "Ctrl+-", desc: "缩小字号", match: (e) => e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "-" },
  ];
}

/**
 * 判断是否为 Ctrl+V（不含 Shift / Alt / Meta）。xterm 默认把它发成 ^V，终端获得焦点时应放行浏览器原生粘贴。
 * @param e 键盘事件
 * @returns 是否为 Ctrl+V 按下
 */
export function isPlainPaste(e: KeyboardEvent): boolean {
  return e.type === "keydown" && combo(e, "v", { ctrl: true });
}

/**
 * 匹配尚未被消费的快捷键，避免同一事件在终端与窗口监听器中重复执行。
 * @param list 快捷键表
 * @param e 键盘事件
 * @returns 命中的动作；未命中返回 null
 */
export function matchShortcut(list: Shortcut[], e: KeyboardEvent): Action | null {
  if (e.type !== "keydown" || e.defaultPrevented) return null;
  return list.find((s) => s.match(e))?.action ?? null;
}
