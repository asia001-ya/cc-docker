/**
 * 终端配色方案（24-bit 真彩）。fluent 为 DESIGN.md 指定的高对比默认方案。
 */
import type { ITheme } from "@xterm/xterm";

/** 方案定义 */
export interface TermTheme {
  id: string;
  name: string;
  theme: ITheme;
}

export const THEMES: TermTheme[] = [
  {
    id: "fluent",
    name: "Fluent 高对比（默认）",
    theme: {
      background: "#121317",
      foreground: "#E6EDF3",
      cursor: "#60CDFF",
      cursorAccent: "#121317",
      selectionBackground: "rgba(96,205,255,0.30)",
      black: "#1B1C1C",
      red: "#FF5449",
      green: "#98C379",
      yellow: "#E5C07B",
      blue: "#61AFEF",
      magenta: "#C678DD",
      cyan: "#56B6C2",
      white: "#E6EDF3",
      brightBlack: "#6E7681",
      brightRed: "#FF7B72",
      brightGreen: "#28CA41",
      brightYellow: "#FCE100",
      brightBlue: "#60CDFF",
      brightMagenta: "#F4B1EE",
      brightCyan: "#7AF2D7",
      brightWhite: "#FFFFFF",
      scrollbarSliderBackground: "rgba(255,255,255,0.10)",
      scrollbarSliderHoverBackground: "rgba(255,255,255,0.18)",
      scrollbarSliderActiveBackground: "rgba(96,205,255,0.35)",
    },
  },
  {
    id: "campbell",
    name: "Windows Terminal · Campbell",
    // 取自 Windows Terminal 1.24 defaults.json 的 Campbell 方案（cmd / PowerShell 默认配置所用）；选区色不在该方案内，为自定值
    theme: {
      background: "#0C0C0C",
      foreground: "#CCCCCC",
      cursor: "#FFFFFF",
      cursorAccent: "#0C0C0C",
      selectionBackground: "rgba(255,255,255,0.25)",
      black: "#0C0C0C",
      red: "#C50F1F",
      green: "#13A10E",
      yellow: "#C19C00",
      blue: "#0037DA",
      magenta: "#881798",
      cyan: "#3A96DD",
      white: "#CCCCCC",
      brightBlack: "#767676",
      brightRed: "#E74856",
      brightGreen: "#16C60C",
      brightYellow: "#F9F1A5",
      brightBlue: "#3B78FF",
      brightMagenta: "#B4009E",
      brightCyan: "#61D6D6",
      brightWhite: "#F2F2F2",
    },
  },
  {
    id: "one-dark",
    name: "One Dark",
    theme: {
      background: "#282C34",
      foreground: "#ABB2BF",
      cursor: "#528BFF",
      selectionBackground: "rgba(82,139,255,0.30)",
      black: "#282C34",
      red: "#E06C75",
      green: "#98C379",
      yellow: "#E5C07B",
      blue: "#61AFEF",
      magenta: "#C678DD",
      cyan: "#56B6C2",
      white: "#ABB2BF",
      brightBlack: "#5C6370",
      brightRed: "#E06C75",
      brightGreen: "#98C379",
      brightYellow: "#E5C07B",
      brightBlue: "#61AFEF",
      brightMagenta: "#C678DD",
      brightCyan: "#56B6C2",
      brightWhite: "#FFFFFF",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    theme: {
      background: "#1E1E2E",
      foreground: "#CDD6F4",
      cursor: "#F5E0DC",
      selectionBackground: "rgba(88,91,112,0.6)",
      black: "#45475A",
      red: "#F38BA8",
      green: "#A6E3A1",
      yellow: "#F9E2AF",
      blue: "#89B4FA",
      magenta: "#F5C2E7",
      cyan: "#94E2D5",
      white: "#BAC2DE",
      brightBlack: "#585B70",
      brightRed: "#F38BA8",
      brightGreen: "#A6E3A1",
      brightYellow: "#F9E2AF",
      brightBlue: "#89B4FA",
      brightMagenta: "#F5C2E7",
      brightCyan: "#94E2D5",
      brightWhite: "#A6ADC8",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    theme: {
      background: "#282A36",
      foreground: "#F8F8F2",
      cursor: "#F8F8F2",
      selectionBackground: "rgba(68,71,90,0.8)",
      black: "#21222C",
      red: "#FF5555",
      green: "#50FA7B",
      yellow: "#F1FA8C",
      blue: "#BD93F9",
      magenta: "#FF79C6",
      cyan: "#8BE9FD",
      white: "#F8F8F2",
      brightBlack: "#6272A4",
      brightRed: "#FF6E6E",
      brightGreen: "#69FF94",
      brightYellow: "#FFFFA5",
      brightBlue: "#D6ACFF",
      brightMagenta: "#FF92DF",
      brightCyan: "#A4FFFF",
      brightWhite: "#FFFFFF",
    },
  },
];

/**
 * 按 ID 取配色，未知 ID 回落到默认方案。
 * @param id 方案 ID
 * @returns 配色
 */
export function themeById(id: string): TermTheme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** 可选字体 */
export const FONTS = ["JetBrains Mono", "Fira Code", "Cascadia Code", "Consolas"];

/**
 * 生成 xterm fontFamily 字符串（附带中文与等宽回落）。
 * @param primary 首选字体
 * @returns CSS font-family
 */
export function fontStack(primary: string): string {
  return `"${primary}", "Cascadia Mono", Consolas, "Microsoft YaHei UI", monospace`;
}

/**
 * 生成 24-bit 色带测试序列（用于设置预览与真彩验证）。
 * @param width 列数
 * @returns 带转义的文本
 */
export function truecolorBand(width = 60): string {
  let out = "";
  for (let i = 0; i < width; i++) {
    const r = Math.round(255 - (i * 255) / width);
    const g = Math.round((i * 510) / width > 255 ? 510 - (i * 510) / width : (i * 510) / width);
    const b = Math.round((i * 255) / width);
    out += `\x1b[48;2;${r};${g};${b}m \x1b[0m`;
  }
  return out;
}
