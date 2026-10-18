#!/usr/bin/env node
/**
 * tdc statusline 采集器（容器内运行，由 managed-settings.json 强制注册为 Claude Code 的 statusLine）
 *
 * 作用：
 *   1. 读取 Claude Code 通过 stdin 传入的 statusline JSON
 *   2. 把账号级额度（rate_limits.five_hour / seven_day）原子写入 $TDC_STATE_DIR/quota.json
 *   3. 把会话级信息（session_id / cwd / 模型 / 上下文占用）写入 $TDC_STATE_DIR/sessions/<key>.json
 *      key 优先使用桌面端注入的 TDC_SESSION_ID，从而建立「桌面终端会话 ↔ Claude 会话」映射，供热切换 --resume 使用
 *   4. 向 stdout 输出模型、思考级别、上下文进度、Git 分支、目录和会话名
 *
 * 协议版本：1（字段说明见 docs/03-quota-and-switch.md）
 * Git 读取最多 600ms，自定义链路最多 2 秒；任何失败都降级展示，不中断 Claude。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { renderStatusLine } from "./statusline-display.mjs";
import { getSessionTitle } from "./tdc-session-history.mjs";
export { renderStatusLine } from "./statusline-display.mjs";

export const PROTOCOL_VERSION = 1;

/**
 * 把未知值规整为 0~100 的百分比数字。
 * @param {unknown} value 原始值（Claude Code 给出 0~100，可能带小数）
 * @returns {number|null} 合法时返回保留一位小数的百分比，否则 null
 */
export function normalizePercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

/**
 * 把未知值规整为 epoch 秒。
 * @param {unknown} value 原始值（epoch 秒；兼容误传的毫秒）
 * @returns {number|null} 合法时返回整数秒，否则 null
 */
export function normalizeEpochSeconds(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value > 1e12 ? value / 1000 : value);
}

/**
 * 解析单个额度窗口。
 * @param {unknown} win stdin 中的 rate_limits.five_hour / seven_day
 * @returns {{used_percentage:number, resets_at:number|null}|null} 无有效百分比时返回 null
 */
export function parseWindow(win) {
  if (!win || typeof win !== "object") return null;
  const used = normalizePercent(win.used_percentage);
  if (used === null) return null;
  return { used_percentage: used, resets_at: normalizeEpochSeconds(win.resets_at) };
}

/**
 * 从环境变量推断授权模式（仅作提示，权威值由桌面端维护）。
 * @param {Record<string,string|undefined>} env 进程环境变量
 * @returns {"api"|"subscription"} 设置了 API 相关变量时为 api
 */
export function detectAuthHint(env) {
  const keys = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"];
  return keys.some((k) => typeof env[k] === "string" && env[k].trim() !== "") ? "api" : "subscription";
}

/**
 * 合并新旧额度快照：stdin 缺少某窗口时（首次响应前 / API 模式）保留旧值，避免把有效数据覆盖为空。
 * @param {object|null} previous 旧的 quota.json 内容
 * @param {object} input 本次 stdin JSON
 * @param {Record<string,string|undefined>} env 进程环境变量
 * @param {number} nowSec 当前 epoch 秒
 * @returns {object} 新的 quota.json 内容
 */
export function buildQuotaSnapshot(previous, input, env, nowSec) {
  const prev = previous && previous.protocol === PROTOCOL_VERSION ? previous : null;
  const limits = input && typeof input.rate_limits === "object" && input.rate_limits ? input.rate_limits : {};
  const fiveHour = parseWindow(limits.five_hour);
  const sevenDay = parseWindow(limits.seven_day);
  const gotFresh = fiveHour !== null || sevenDay !== null;

  return {
    protocol: PROTOCOL_VERSION,
    updated_at: nowSec,
    rate_limits_updated_at: gotFresh ? nowSec : prev?.rate_limits_updated_at ?? null,
    container: env.TDC_CONTAINER_NAME || prev?.container || null,
    auth_hint: detectAuthHint(env),
    five_hour: fiveHour ?? prev?.five_hour ?? null,
    seven_day: sevenDay ?? prev?.seven_day ?? null,
    model: pickModel(input) ?? prev?.model ?? null,
    claude_version: typeof input?.version === "string" ? input.version : prev?.claude_version ?? null,
    last_session: {
      session_id: typeof input?.session_id === "string" ? input.session_id : null,
      tdc_session_id: env.TDC_SESSION_ID || null,
      cwd: pickCwd(input),
    },
  };
}

/**
 * 构造会话级快照。
 * @param {object} input 本次 stdin JSON
 * @param {Record<string,string|undefined>} env 进程环境变量
 * @param {number} nowSec 当前 epoch 秒
 * @returns {object} sessions/<key>.json 内容
 */
export function buildSessionSnapshot(input, env, nowSec) {
  const ctx = input?.context_window ?? {};
  return {
    protocol: PROTOCOL_VERSION,
    updated_at: nowSec,
    tdc_session_id: env.TDC_SESSION_ID || null,
    session_id: typeof input?.session_id === "string" ? input.session_id : null,
    transcript_path: typeof input?.transcript_path === "string" ? input.transcript_path : null,
    cwd: pickCwd(input),
    model: pickModel(input),
    title: typeof input?.session_name === "string" && input.session_name.trim() ? input.session_name : null,
    effort_level: ["low", "medium", "high", "xhigh", "max"].includes(input?.effort?.level) ? input.effort.level : null,
    thinking_enabled: typeof input?.thinking?.enabled === "boolean" ? input.thinking.enabled : null,
    context_window_size: Number.isSafeInteger(ctx.context_window_size) && ctx.context_window_size > 0 ? ctx.context_window_size : null,
    context_used_percentage: normalizePercent(ctx.used_percentage),
    cost_usd: typeof input?.cost?.total_cost_usd === "number" ? input.cost.total_cost_usd : null,
  };
}

/**
 * 计算会话快照的文件名键。
 * @param {object} input stdin JSON
 * @param {Record<string,string|undefined>} env 进程环境变量
 * @returns {string|null} 仅含安全字符的文件名（不含扩展名），无法确定时返回 null
 */
export function sessionKey(input, env) {
  const raw = env.TDC_SESSION_ID || (typeof input?.session_id === "string" ? `claude-${input.session_id}` : "");
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, "");
  return safe.length > 0 ? safe.slice(0, 80) : null;
}

/**
 * 读取 stdin 中的模型信息。
 * @param {object} input stdin JSON
 * @returns {{id:string|null, display_name:string|null}|null} 无模型字段时返回 null
 */
function pickModel(input) {
  const m = input?.model;
  if (!m || typeof m !== "object") return null;
  return {
    id: typeof m.id === "string" ? m.id : null,
    display_name: typeof m.display_name === "string" ? m.display_name : null,
  };
}

/**
 * 读取当前工作目录（优先 workspace.current_dir）。
 * @param {object} input stdin JSON
 * @returns {string|null} 目录路径
 */
function pickCwd(input) {
  const dir = input?.workspace?.current_dir ?? input?.cwd;
  return typeof dir === "string" ? dir : null;
}

/**
 * 原子写 JSON：先写临时文件再 rename；rename 失败（如宿主机正占用文件）时回退为直接覆盖写。
 * @param {string} file 目标文件
 * @param {object} data 要写入的对象
 * @returns {void}
 */
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 忽略清理失败 */
    }
    fs.writeFileSync(file, body);
  }
}

/**
 * 安全读取 JSON 文件。
 * @param {string} file 文件路径
 * @returns {object|null} 解析结果，不存在或损坏时返回 null
 */
export function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 按剩余百分比返回真彩前景色序列（阈值与桌面端一致：>30 绿、5~30 黄、<5 红）。
 * @param {number} remaining 剩余百分比
 * @returns {string} ANSI 24-bit 前景色转义序列
 */
export function colorForRemaining(remaining) {
  if (remaining > 30) return "\x1b[38;2;40;202;65m";
  if (remaining >= 5) return "\x1b[38;2;252;225;0m";
  return "\x1b[38;2;255;84;73m";
}

/**
 * 只读获取当前分支；五秒内复用同一目录缓存，非仓库返回 null。
 * @param {string|null} cwd 当前目录
 * @param {object|null} previous 旧的会话快照
 * @param {number} nowSec 当前时间
 * @returns {string|null} 分支名或 detached 提交 ID
 */
export function readGitBranch(cwd, previous, nowSec) {
  if (previous?.cwd === cwd && typeof previous.git_checked_at === 'number' && nowSec >= previous.git_checked_at && nowSec - previous.git_checked_at < 5) return previous.git_branch ?? null;
  if (typeof cwd !== 'string' || !cwd.trim()) return null;
  const options = { encoding: 'utf8', timeout: 300, windowsHide: true, maxBuffer: 4096 };
  try {
    const branch = spawnSync('git', ['--no-optional-locks', '-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'], options);
    if (branch.status === 0) return branch.stdout.trim() || null;
    if (branch.status !== 1) return null;
    const detached = spawnSync('git', ['--no-optional-locks', '-C', cwd, 'rev-parse', '--short', 'HEAD'], options);
    return detached.status === 0 ? `detached:${detached.stdout.trim()}` : null;
  } catch { return null; }
}

/**
 * 若设置了 TDC_STATUSLINE_CHAIN，把原始 stdin 交给用户自定义的 statusline 命令并返回其输出。
 * @param {string} chain 用户命令（bash -c 执行）
 * @param {string} raw 原始 stdin 文本
 * @returns {string|null} 命令输出；失败或超时返回 null
 */
function runChain(chain, raw) {
  const res = spawnSync("/bin/bash", ["-c", chain], { input: raw, encoding: "utf8", timeout: 2000 });
  if (res.status !== 0 || typeof res.stdout !== "string") return null;
  return res.stdout.replace(/\s+$/, "");
}

/**
 * 主流程：读 stdin → 写 quota.json / sessions/<key>.json → 输出状态行。
 * @param {string} raw stdin 原文
 * @param {Record<string,string|undefined>} env 进程环境变量
 * @param {number} nowSec 当前 epoch 秒
 * @returns {string} 需要输出到 stdout 的文本
 */
export function run(raw, env, nowSec) {
  let input = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    input = {};
  }
  const stateDir = env.TDC_STATE_DIR || "/home/node/.claude/tdc/state";
  const quotaFile = path.join(stateDir, "quota.json");
  const quota = buildQuotaSnapshot(readJsonSafe(quotaFile), input, env, nowSec);
  const session = buildSessionSnapshot(input, env, nowSec);
  const key = sessionKey(input, env);
  const previous = key ? readJsonSafe(path.join(stateDir, 'sessions', `${key}.json`)) : null;
  const cachedGit = previous?.cwd === session.cwd && nowSec >= previous?.git_checked_at && nowSec - previous.git_checked_at < 5;
  session.git_branch = readGitBranch(session.cwd, previous, nowSec);
  session.git_checked_at = cachedGit ? previous.git_checked_at : nowSec;
  session.title ||= getSessionTitle(session, { projectsDir: path.join(env.CLAUDE_CONFIG_DIR || '/home/node/.claude', 'projects') });

  try {
    writeJsonAtomic(quotaFile, quota);
  } catch {
    /* 状态目录不可写时只影响桌面端展示，不影响 Claude Code */
  }
  if (key) {
    try {
      writeJsonAtomic(path.join(stateDir, "sessions", `${key}.json`), session);
    } catch {
      /* 同上 */
    }
  }

  if (env.TDC_STATUSLINE_CHAIN) {
    const chained = runChain(env.TDC_STATUSLINE_CHAIN, raw);
    if (chained !== null) return chained;
  }
  return renderStatusLine(quota, session, env.COLUMNS);
}

/**
 * 读取全部 stdin（Claude Code 写完后会关闭管道）。
 * @returns {Promise<string>} stdin 文本
 */
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = await readStdin();
  let line = "";
  try {
    line = run(raw, process.env, Math.floor(Date.now() / 1000));
  } catch {
    line = "tdc";
  }
  process.stdout.write(`${line}\n`);
}
