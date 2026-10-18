import type { Config } from "tailwindcss";

/**
 * Tailwind 配置：设计令牌来自 stitch_claude/DESIGN.md（Fluent Container Studio）。
 * 圆角使用 DESIGN.md 的标准刻度（设计稿 code.html 中被 Stitch 压缩过的圆角不采用）。
 */
const config: Config = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: "#131313",
        "surface-dim": "#131313",
        "surface-bright": "#393939",
        "surface-container-lowest": "#0e0e0e",
        "surface-container-low": "#1b1c1c",
        "surface-container": "#202020",
        "surface-container-high": "#2a2a2a",
        "surface-container-highest": "#353535",
        "on-surface": "#e5e2e1",
        "on-surface-variant": "#bdc8cf",
        outline: "#889299",
        "outline-variant": "#3e484e",
        primary: "#b4e4ff",
        "on-primary": "#003548",
        "primary-container": "#60cdff",
        "on-primary-container": "#005572",
        secondary: "#f4b1ee",
        tertiary: "#7af2d7",
        error: "#ffb4ab",
        "error-container": "#93000a",
        "on-error-container": "#ffdad6",
        // Fluent 材质
        mica: "#202020",
        "mica-alt": "#181818",
        // 强调色
        accent: { DEFAULT: "#60CDFF", hover: "#7BE0FF", active: "#4BAFD6" },
        magenta: "#C586C0",
        teal: "#4EC9B0",
        // 容器状态语义色
        "st-ok": { DEFAULT: "#28CA41", bg: "#103B19" },
        "st-warn": { DEFAULT: "#FCE100", bg: "#3D3700" },
        "st-bad": { DEFAULT: "#FF5449", bg: "#45110E" },
        "st-off": { DEFAULT: "#8A8886", bg: "#252423" },
        // 终端
        term: { bg: "#121317", fg: "#E6EDF3", dim: "#6E7681" },
        caption: { close: "#E81123" },
      },
      fontFamily: {
        ui: ['"Segoe UI Variable"', '"Segoe UI"', '"Microsoft YaHei UI"', '"PingFang SC"', "sans-serif"],
        mono: ['"JetBrains Mono"', '"Cascadia Code"', "Consolas", "monospace"],
      },
      fontSize: {
        "headline-lg": ["20px", { lineHeight: "26px", fontWeight: "600" }],
        "headline-md": ["16px", { lineHeight: "22px", fontWeight: "600" }],
        "headline-sm": ["14px", { lineHeight: "20px", fontWeight: "600" }],
        "body-lg": ["14px", { lineHeight: "20px" }],
        "body-md": ["13px", { lineHeight: "18px" }],
        "body-sm": ["12px", { lineHeight: "16px" }],
        "label-md": ["12px", { lineHeight: "16px", fontWeight: "500" }],
        "label-sm": ["11px", { lineHeight: "14px", fontWeight: "500" }],
        "code-md": ["12px", { lineHeight: "18px" }],
        "code-sm": ["11px", { lineHeight: "16px" }],
      },
      borderRadius: {
        sm: "0.125rem",
        DEFAULT: "0.25rem",
        md: "0.375rem",
        lg: "0.5rem",
        xl: "0.75rem",
      },
      boxShadow: {
        flyout: "0 8px 16px rgba(0,0,0,0.36), 0 2px 4px rgba(0,0,0,0.24)",
        modal: "0 24px 48px rgba(0,0,0,0.65), 0 2px 6px rgba(255,255,255,0.06)",
        tooltip: "0 16px 32px rgba(0,0,0,0.48)",
      },
      transitionTimingFunction: {
        fluent: "cubic-bezier(0.1, 0.9, 0.2, 1.0)",
      },
    },
  },
  plugins: [],
};

export default config;
