/**
 * 演示数据：仅在开发模式（npm run dev，无 Tauri 后端）中预览界面使用。
 * 正式构建裁掉所有演示账号、供应商、代理和会话数据。
 * 真实应用中所有数据均来自后端 fleet://update 事件。
 */
import type { FleetEntry, FleetState, ProviderView, ProxyNodeView, SessionRecord, Settings } from "../api/types";
import { DEFAULT_WALLPAPER } from "./wallpaper";
import { mergeBuiltinModelPricing } from "./providerPricing";

const now = Math.floor(Date.now() / 1000);

/**
 * 构造演示容器。
 * @param name 容器名
 * @param slot 槽位
 * @param used5h 5 小时已用
 * @param used7d 周已用
 * @param opts 其它覆盖字段
 * @returns 汇总项
 */
function entry(name: string, slot: number, used5h: number | null, used7d: number | null, opts: Partial<FleetEntry> = {}): FleetEntry {
  const quota =
    used5h === null
      ? null
      : {
          updated_at: now - 40,
          rate_limits_updated_at: now - 40,
          five_hour: { used_percentage: used5h, resets_at: now + 2 * 3600 + 780 },
          seven_day: used7d === null ? null : { used_percentage: used7d, resets_at: now + 4 * 86400 },
          model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
          claude_version: "2.1.300",
        };
  const rem = quota ? 100 - Math.max(used5h ?? 0, used7d ?? 0) : null;
  return {
    container: {
      id: `demo${slot}`,
      name,
      image: "tdc/claude-dev:latest",
      state: "running",
      status: "Up 3 hours",
      running: true,
      slot,
      authMode: "subscription",
      providerId: null,
      sharedGroup: "default",
      ports: [
        [3000, 3000 + slot * 10],
        [5173, 5173 + slot * 10],
        [8080, 8080 + slot * 10],
      ],
      mounts: [{ kind: "bind", source: "D:/Projects/app", destination: "/workspace/app", rw: true }],
    },
    health: rem === null ? "unknown" : rem > 30 ? "healthy" : rem >= 5 ? "warning" : "exhausted",
    remaining: rem === null ? null : { remaining: rem, inferred: false },
    quota,
    blockedUntil: rem !== null && rem <= 0 ? now + 2 * 3600 + 780 : null,
    account: { logged_in: true, email: `dev${slot}@example.com`, display_name: null, organization_type: "claude_max", rate_limit_tier: "default_claude_max_5x" },
    provider: { mode: "subscription", base_url: null, model: null },
    ports: [{ containerPort: 3000, hostPort: 3000 + slot * 10, url: `http://localhost:${3000 + slot * 10}`, process: "node", hint: null }],
    sessions: [],
    error: null,
    limitHit: false,
    proxy: null,
    ...opts,
  };
}

/** 演示用容器汇总 */
export const DEMO_FLEET: FleetState = import.meta.env.DEV ? {
  engineOk: true,
  engineError: null,
  latencyMs: 12,
  engineVersion: "28.4.0",
  generatedAt: now,
  entries: [
    entry("claude-dev-01", 1, 15, 40, {
      sessions: [
        { session_id: "demo-history-frontend", title: "修复登录页面的表单校验", cwd: "/workspace/app", updated_at: now - 120, model: { id: "claude-opus-5-5", display_name: "Opus 5.5" } },
        { session_id: "demo-history-backend", title: "为订单接口补充自动化测试", cwd: "/workspace/app/server", updated_at: now - 3600, model: { id: "claude-opus-5-5", display_name: "Opus 5.5" } },
        { session_id: "demo-history-untitled", cwd: "/workspace/app", updated_at: now - 86400 },
      ],
    }),
    entry("claude-dev-02", 2, 55, 62),
    entry("claude-dev-03", 3, 96, 30),
    entry("claude-dev-04", 4, 100, 70, { health: "exhausted" }),
    {
      ...entry("claude-api-05", 5, null, null),
      health: "api",
      container: { ...entry("claude-api-05", 5, null, null).container, authMode: "api", providerId: "relay" },
      provider: { mode: "api", base_url: "https://api.example.com", model: "claude-sonnet-5" },
    },
    {
      ...entry("claude-dev-06", 6, 0, 10),
      health: "stopped",
      container: { ...entry("claude-dev-06", 6, 0, 10).container, running: false, state: "exited", status: "Exited (0) 2 hours ago" },
      ports: [],
    },
  ],
} : { engineOk: false, engineError: null, latencyMs: null, engineVersion: null, entries: [], generatedAt: 0 };

/** 演示用会话 */
export const DEMO_SESSIONS: SessionRecord[] = import.meta.env.DEV ? [
  { id: "demo0001", container: "claude-dev-01", title: "前端开发 #1", cwd: "/workspace/app", mode: "claude", args: [], env: [], tmux: true, createdAt: now },
  { id: "demo0002", container: "claude-dev-01", title: "后端服务 #2", cwd: "/workspace/app", mode: "bash", args: [], env: [], tmux: true, createdAt: now },
] : [];

/** 演示用供应商 */
export const DEMO_PROVIDERS: ProviderView[] = import.meta.env.DEV ? [
  { id: "relay", name: "团队中转", baseUrl: "https://api.example.com", model: "claude-sonnet-5", smallModel: "", tokenEnv: "ANTHROPIC_AUTH_TOKEN", extraEnv: {}, hasToken: true, pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, modelPricing: mergeBuiltinModelPricing() },
  { id: "official", name: "Anthropic 官方 API", baseUrl: "", model: "", smallModel: "", tokenEnv: "ANTHROPIC_API_KEY", extraEnv: {}, hasToken: false, pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, modelPricing: mergeBuiltinModelPricing() },
] : [];

/** 演示用代理节点 */
export const DEMO_PROXY_NODES: ProxyNodeView[] = import.meta.env.DEV ? [
  { id: "sub1", name: "我的机场", kind: "subscription", engine: "mihomo", display: "https://sub.example.com", hasSecret: true },
  { id: "tokyo", name: "东京 VPS", kind: "vless", engine: "xray", display: "tokyo.example.com:443 · reality/tcp", hasSecret: true },
  { id: "relay", name: "上海中转", kind: "vless", engine: "mihomo", display: "relay.example.com:8443 · tls/ws", hasSecret: true },
  { id: "resi", name: "住宅 IP", kind: "socks5", engine: "mihomo", display: "203.0.113.9:1080 · 认证", hasSecret: true },
] : [];

/** 默认设置（与后端 Default 一致） */
export const DEFAULT_SETTINGS: Settings = {
  wallpaper: { ...DEFAULT_WALLPAPER },
  terminal: {
    fontFamily: "JetBrains Mono",
    fontSize: 14,
    lineHeight: 1.2,
    theme: "fluent",
    cursorStyle: "block",
    cursorBlink: true,
    webgl: true,
    ligatures: true,
    scrollback: 5000,
  },
  quota: {
    refreshSecs: 5,
    warnThreshold: 30,
    criticalThreshold: 5,
    switchThreshold: 100,
    autoPrompt: true,
    allowApiFallback: false,
    includeStopped: false,
    limitPatterns: ["(?i)usage limit reached", "(?i)you've (hit|reached) your .*limit", "(?i)(5-hour|weekly) limit", "(?i)limit will reset"],
  },
  docker: { host: "", defaultImage: "tdc/claude-dev:latest" },
  sidebarShortcut: "ctrl+shift+b",
};

/**
 * 演示终端欢迎文本（展示 24-bit 真彩与 Claude Code 风格界面）。
 * @param title 会话名
 * @param container 容器名
 * @returns 带转义的文本
 */
export function demoBanner(title: string, container: string): string {
  if (!import.meta.env.DEV) return "";
  const c = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
  const reset = "\x1b[0m";
  let band = "";
  for (let i = 0; i < 72; i++) {
    const t = i / 71;
    band += `\x1b[48;2;${Math.round(96 + 150 * t)};${Math.round(205 - 120 * t)};${Math.round(255 - 60 * t)}m ${reset}`;
  }
  return [
    `${c(110, 118, 129)}# 演示模式：未检测到 Tauri 后端，以下为界面预览${reset}`,
    `${c(86, 182, 194)}node@${container}${reset}:${c(97, 175, 239)}/workspace/app${reset} ${c(198, 120, 221)}(main ✓)${reset} $ claude`,
    "",
    `${c(255, 140, 90)}╭───────────────────────────────────────────────────╮${reset}`,
    `${c(255, 140, 90)}│${reset} ${c(255, 140, 90)}✻${reset} Welcome to ${c(230, 237, 243)}Claude Code${reset}  ${c(110, 118, 129)}v2.1.300${reset}                 ${c(255, 140, 90)}│${reset}`,
    `${c(255, 140, 90)}│${reset}   ${c(110, 118, 129)}cwd: /workspace/app · 会话：${title}${reset}`,
    `${c(255, 140, 90)}╰───────────────────────────────────────────────────╯${reset}`,
    "",
    `${c(230, 237, 243)}> 重构登录模块并补充单元测试${reset}`,
    "",
    `${c(152, 195, 121)}●${reset} 读取 ${c(229, 192, 123)}src/auth/login.ts${reset}（212 行）`,
    `${c(152, 195, 121)}●${reset} 更新 ${c(229, 192, 123)}src/auth/session.ts${reset}  ${c(40, 202, 65)}+38${reset} ${c(255, 84, 73)}-12${reset}`,
    `   ${c(110, 118, 129)}  41 │${reset} ${c(198, 120, 221)}export async function${reset} ${c(97, 175, 239)}refreshToken${reset}(${c(224, 108, 117)}ctx${reset}: ${c(229, 192, 123)}Context${reset}) {`,
    `   ${c(110, 118, 129)}  42 │${reset}   ${c(198, 120, 221)}const${reset} res = ${c(198, 120, 221)}await${reset} ctx.http.${c(97, 175, 239)}post${reset}(${c(152, 195, 121)}"/oauth/refresh"${reset});`,
    `${c(252, 225, 0)}●${reset} 运行 ${c(86, 182, 194)}npm test${reset} … ${c(40, 202, 65)}✓ 48 passed${reset}`,
    "",
    `${c(110, 118, 129)}24-bit 真彩色带：${reset}`,
    band,
    "",
    `${c(96, 205, 255)}${container}${reset}${c(110, 118, 129)} · ${reset}Opus 5.5${c(110, 118, 129)} · ${reset}5h 余 ${c(40, 202, 65)}85%${reset}${c(110, 118, 129)} · ${reset}周 余 ${c(40, 202, 65)}60%${reset}`,
    "",
  ].join("\r\n");
}
