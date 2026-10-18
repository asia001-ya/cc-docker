#!/usr/bin/env node
/**
 * tdc-lib —— 额度健康度与热切换候选排序（命令行版）
 *
 * 与桌面端 src-tauri/src/quota/switch.rs 实现同一算法，二者共用测试用例
 * docker/tests/fixtures/ranking-cases.json，保证 CLI 与桌面端结论一致。
 * 镜像内路径 /opt/tdc/tdc-lib.mjs；宿主机脚本通过 docker exec -i 调用，宿主机无需安装 Node。
 *
 * 子命令（输入均从 stdin 读取 JSON 数组：[{name, running, auth_mode?, quota? | snapshot?}]）：
 *   node tdc-lib.mjs table [--json]          打印全部容器的额度表
 *   node tdc-lib.mjs rank <源容器>           输出候选列表 JSON（第一个为推荐）
 */
import { pathToFileURL } from "node:url";

/** 默认阈值（与 DESIGN.md 状态色一致：>30 绿、5~30 黄、<5 红） */
export const DEFAULT_SETTINGS = Object.freeze({
  warn_threshold: 30,
  critical_threshold: 5,
  switch_threshold: 100,
  allow_api_fallback: false,
  include_stopped: false,
});

/**
 * 计算单个窗口的有效已用百分比：重置时间已过则推断为 0。
 * @param {{used_percentage:number, resets_at:number|null}|null} win 额度窗口
 * @param {number} now 当前 epoch 秒
 * @returns {{used:number, inferred:boolean}|null} 无数据时返回 null
 */
export function effectiveUsed(win, now) {
  if (!win || typeof win.used_percentage !== "number") return null;
  if (typeof win.resets_at === "number" && now >= win.resets_at) return { used: 0, inferred: true };
  return { used: win.used_percentage, inferred: false };
}

/**
 * 计算剩余额度百分比 = 100 − max(5h 已用, 周已用)。
 * @param {object|null} quota quota.json 内容
 * @param {number} now 当前 epoch 秒
 * @returns {{remaining:number, inferred:boolean}|null} 两个窗口都无数据时返回 null
 */
export function remainingOf(quota, now) {
  if (!quota) return null;
  const wins = [effectiveUsed(quota.five_hour, now), effectiveUsed(quota.seven_day, now)].filter(Boolean);
  if (wins.length === 0) return null;
  const used = Math.max(...wins.map((w) => w.used));
  return { remaining: Math.round((100 - used) * 10) / 10, inferred: wins.some((w) => w.inferred) };
}

/**
 * 判断是否已达到切换阈值（任一窗口有效已用 ≥ 阈值）。
 * @param {object|null} quota quota.json 内容
 * @param {number} now 当前 epoch 秒
 * @param {number} threshold 切换阈值（已用百分比）
 * @returns {boolean} 达到阈值返回 true
 */
export function isExhausted(quota, now, threshold) {
  if (!quota) return false;
  return [quota.five_hour, quota.seven_day].some((w) => {
    const eff = effectiveUsed(w, now);
    return eff !== null && eff.used >= threshold;
  });
}

/**
 * 计算额度恢复时间：取所有达到阈值窗口中最晚的 resets_at。
 * @param {object|null} quota quota.json 内容
 * @param {number} now 当前 epoch 秒
 * @param {number} threshold 切换阈值
 * @returns {number|null} epoch 秒；未耗尽或无重置时间时返回 null
 */
export function blockedUntil(quota, now, threshold) {
  if (!quota) return null;
  let result = null;
  for (const w of [quota.five_hour, quota.seven_day]) {
    const eff = effectiveUsed(w, now);
    if (eff && eff.used >= threshold && typeof w.resets_at === "number") {
      result = result === null ? w.resets_at : Math.max(result, w.resets_at);
    }
  }
  return result;
}

/**
 * 计算容器健康状态。
 * @param {{running:boolean, auth_mode:string, quota:object|null, limit_hit?:boolean}} c 容器
 * @param {number} now 当前 epoch 秒
 * @param {typeof DEFAULT_SETTINGS} s 阈值设置
 * @returns {"stopped"|"api"|"unknown"|"healthy"|"warning"|"exhausted"} 健康状态
 */
export function healthOf(c, now, s = DEFAULT_SETTINGS) {
  if (!c.running) return "stopped";
  if (c.auth_mode === "api") return "api";
  if (c.limit_hit || isExhausted(c.quota, now, s.switch_threshold)) return "exhausted";
  const r = remainingOf(c.quota, now);
  if (r === null) return "unknown";
  if (r.remaining > s.warn_threshold) return "healthy";
  if (r.remaining >= s.critical_threshold) return "warning";
  return "exhausted";
}

/**
 * 把多种输入形态统一为 {name, running, auth_mode, quota, limit_hit}。
 * 支持直接给 quota，或给 tdc-ctl snapshot 的完整输出（snapshot 字段）。
 * @param {object} raw 原始容器描述
 * @returns {{name:string, running:boolean, auth_mode:string, quota:object|null, limit_hit:boolean}} 规范化后的容器
 */
export function normalizeContainer(raw) {
  const snap = raw.snapshot && typeof raw.snapshot === "object" ? raw.snapshot : null;
  return {
    name: String(raw.name ?? ""),
    running: raw.running !== false,
    auth_mode: raw.auth_mode ?? snap?.provider?.mode ?? "subscription",
    quota: raw.quota ?? snap?.quota ?? null,
    limit_hit: raw.limit_hit === true,
  };
}

/**
 * 生成热切换候选列表（已排序，第一个为推荐）。
 * 分层：①运行中订阅且额度已知未耗尽（剩余降序 → 5h 重置早者优先 → 名称）
 *      ②运行中订阅但额度未知 ③已停止订阅（include_stopped 时） ④API 模式（allow_api_fallback 时）
 * @param {Array<object>} containers 容器列表
 * @param {string} source 源容器名（排除）
 * @param {number} now 当前 epoch 秒
 * @param {typeof DEFAULT_SETTINGS} settings 阈值设置
 * @returns {Array<{name:string, tier:number, remaining:number|null, reason:string}>} 候选
 */
export function rankCandidates(containers, source, now, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const out = [];
  for (const c of containers) {
    if (c.name === source) continue;
    const r = remainingOf(c.quota, now);
    const remaining = r ? r.remaining : null;
    const reset5h = typeof c.quota?.five_hour?.resets_at === "number" ? c.quota.five_hour.resets_at : Number.MAX_SAFE_INTEGER;
    if (c.auth_mode === "api") {
      if (s.allow_api_fallback && c.running) out.push({ name: c.name, tier: 4, remaining: null, reset5h, reason: "API 按量计费兜底" });
      continue;
    }
    if (!c.running) {
      if (s.include_stopped) out.push({ name: c.name, tier: 3, remaining, reset5h, reason: "已停止，切换前需启动" });
      continue;
    }
    if (c.limit_hit || isExhausted(c.quota, now, s.switch_threshold)) continue;
    if (remaining === null) out.push({ name: c.name, tier: 2, remaining: null, reset5h, reason: "额度未知（尚无数据）" });
    else if (remaining > 0) out.push({ name: c.name, tier: 1, remaining, reset5h, reason: `剩余 ${remaining}%${r.inferred ? "（推断已重置）" : ""}` });
  }
  out.sort((a, b) =>
    a.tier - b.tier ||
    (b.remaining ?? -1) - (a.remaining ?? -1) ||
    a.reset5h - b.reset5h ||
    a.name.localeCompare(b.name));
  return out.map(({ reset5h, ...rest }) => rest);
}

/**
 * 把 epoch 秒格式化为本地 "MM-DD HH:mm"。
 * @param {number|null|undefined} sec epoch 秒
 * @returns {string} 格式化文本，空值返回 "-"
 */
function fmtTime(sec) {
  if (typeof sec !== "number") return "-";
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 把窗口格式化为 "剩余% (重置时间)"。
 * @param {object|null} win 额度窗口
 * @param {number} now 当前 epoch 秒
 * @returns {string} 显示文本
 */
function fmtWindow(win, now) {
  const eff = effectiveUsed(win, now);
  if (!eff) return "-";
  const rem = Math.round(100 - eff.used);
  return eff.inferred ? `${rem}%*` : `${rem}% @${fmtTime(win.resets_at)}`;
}

/**
 * 读取全部 stdin。
 * @returns {Promise<string>} stdin 文本
 */
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

/**
 * 命令行入口。
 * @param {string[]} argv 参数（不含 node 与脚本路径）
 * @returns {Promise<number>} 退出码
 */
async function main(argv) {
  const [cmd, arg] = argv;
  const containers = JSON.parse((await readStdin()) || "[]").map(normalizeContainer);
  const now = Math.floor(Date.now() / 1000);
  if (cmd === "rank") {
    process.stdout.write(`${JSON.stringify(rankCandidates(containers, arg ?? "", now), null, 2)}\n`);
    return 0;
  }
  if (cmd === "table") {
    if (arg === "--json") {
      const rows = containers.map((c) => ({ ...c, health: healthOf(c, now), remaining: remainingOf(c.quota, now) }));
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return 0;
    }
    const icon = { healthy: "🟢", warning: "🟡", exhausted: "🔴", stopped: "⚪", unknown: "⚪", api: "🔵" };
    const lines = [["", "容器", "模式", "5h 剩余 / 重置", "周剩余 / 重置", "模型"]];
    for (const c of containers) {
      const h = healthOf(c, now);
      lines.push([icon[h], c.name, c.auth_mode === "api" ? "API" : "订阅", fmtWindow(c.quota?.five_hour, now),
        fmtWindow(c.quota?.seven_day, now), c.quota?.model?.display_name ?? "-"]);
    }
    const widths = lines[0].map((_, i) => Math.max(...lines.map((l) => [...l[i]].length)));
    for (const l of lines) process.stdout.write(`${l.map((v, i) => v.padEnd(widths[i])).join("  ")}\n`);
    process.stdout.write("（* 表示重置时间已过，推断为已恢复；数据仅在容器内 claude 运行时刷新）\n");
    return 0;
  }
  process.stderr.write("用法: tdc-lib.mjs table [--json] | rank <源容器>\n");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
