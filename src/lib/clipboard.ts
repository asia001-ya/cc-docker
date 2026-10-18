/**
 * 剪贴板纯逻辑：粘贴内容选择、OSC 52 选区判定。
 * 图片粘贴流程：前端取到剪贴板图片 → 后端写入容器 /tmp → 把容器内路径以括号粘贴送入终端，
 * Claude Code 按扩展名把路径识别为图片附件（容器内没有 X 剪贴板，Ctrl+V 读图在容器里无效）。
 */

/** 可粘贴的图片类型（与 Claude Code 识别图片路径的扩展名 png / jpg / gif / webp 一致） */
export const PASTE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** 粘贴内容选择结果 */
export type PastePick = { kind: "text" } | { kind: "image"; mime: string } | null;

/**
 * 决定粘贴文本还是图片：有非空文本时优先文本，否则取第一个支持的图片类型。
 * @param text 剪贴板中的 text/plain 内容（没有时传空串）
 * @param types 剪贴板中的全部 MIME 类型
 * @returns 选择结果；没有可粘贴内容时返回 null
 */
export function choosePaste(text: string, types: readonly string[]): PastePick {
  if (text) return { kind: "text" };
  const mime = types.find((t) => (PASTE_IMAGE_TYPES as readonly string[]).includes(t));
  return mime ? { kind: "image", mime } : null;
}

/**
 * 判断 OSC 52 写剪贴板请求是否应写入系统剪贴板。
 * tmux copy-mode 发出的选区参数为空串（ESC]52;;…），程序直接写时一般为 "c"；Windows 只有一个剪贴板，
 * 因此空串与 c / p / s 都写入系统剪贴板，只忽略纯 cut buffer（0-7）。
 * @param selection OSC 52 的选区参数
 * @returns 是否写入系统剪贴板
 */
export function oscWritesClipboard(selection: string): boolean {
  return selection === "" || /[cps]/.test(selection);
}
