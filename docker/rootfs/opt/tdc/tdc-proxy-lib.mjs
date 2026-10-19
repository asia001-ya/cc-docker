#!/usr/bin/env node
/**
 * tdc-proxy-lib —— 代理运行状态分类（纯函数，供 tdc-proxy.sh 守护调用与单测）
 *
 * 输入是守护每轮采集的"原始事实"，输出 proxy-status.json（协议 1）。
 * 状态语义（与桌面端 ProxyModal 的颜色一一对应）：
 *   off        未启用且无兜底规则（直连）
 *   starting   内核刚启动、TUN 尚未就绪（此期间网络不通）
 *   ok         内核运行、TUN 就绪、兜底完整
 *   blackhole  兜底在但内核或 TUN 不在 → 已断网（fail-closed 生效）
 *   leak       已启用但兜底缺失 → 流量可能绕过代理（守护会立即自愈，出现即告警）
 *
 * 子命令：
 *   node tdc-proxy-lib.mjs status     stdin 读原始事实 JSON，stdout 输出状态 JSON
 */
import { pathToFileURL } from "node:url";
import { lanCidrsFromIntent } from "./tdc-lan.mjs";

/** 内核启动后允许 TUN 未就绪的宽限秒数 */
export const STARTING_GRACE_SECS = 15;

/**
 * 把 mihomo 的 ISO 时间（updatedAt）转为 epoch 秒。
 * @param {unknown} v 时间字符串
 * @returns {number|null} epoch 秒；无法解析返回 null
 */
export function isoToEpoch(v) {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  // mihomo 对从未更新的 provider 返回 0001-01-01，视为无数据
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}

/**
 * 从 GET /providers/proxies 的响应中提取订阅类 provider 摘要（排除内置的 default 等）。
 * @param {unknown} raw 控制器响应
 * @returns {{name:string, count:number, updated_at:number|null}[]} 按名称排序
 */
export function summarizeProviders(raw) {
  const map = raw && typeof raw === "object" ? raw.providers : null;
  if (!map || typeof map !== "object") return [];
  return Object.values(map)
    .filter((p) => p && (p.vehicleType === "HTTP" || p.vehicleType === "File"))
    .map((p) => ({
      name: String(p.name ?? ""),
      count: Array.isArray(p.proxies) ? p.proxies.length : 0,
      updated_at: isoToEpoch(p.updatedAt),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 根据原始事实判定状态。
 * @param {{enabled:boolean, guard:boolean, core_alive:boolean, tun:boolean, core_age:number|null}} f 事实
 * @returns {"off"|"starting"|"ok"|"blackhole"|"leak"} 状态
 */
export function classify(f) {
  if (!f.enabled) return f.guard ? "blackhole" : "off";
  if (!f.guard) return "leak";
  if (f.core_alive && f.tun) return "ok";
  if (f.core_alive && typeof f.core_age === "number" && f.core_age < STARTING_GRACE_SECS) return "starting";
  return "blackhole";
}

/**
 * 生成 proxy-status.json 内容。
 * @param {object} raw 原始事实：{now, intent, core:{pid,alive,age}, tun, guard, restarts, last_error, controller:{now, providers}}
 * @returns {object} 状态对象（协议 1）
 */
export function buildStatus(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const intent = r.intent && typeof r.intent === "object" ? r.intent : {};
  const core = r.core && typeof r.core === "object" ? r.core : {};
  const enabled = intent.enabled === true;
  let lanCidrs = [];
  const lanWarnings = [];
  if (intent.allow_lan === true) {
    try { lanCidrs = lanCidrsFromIntent(intent); }
    catch { lanWarnings.push("内网直连网段无效，请重新应用代理设置"); }
  }
  const facts = {
    enabled,
    guard: r.guard === true && lanWarnings.length === 0,
    core_alive: core.alive === true,
    tun: r.tun === true,
    core_age: typeof core.age === "number" ? core.age : null,
  };
  const state = classify(facts);
  const providers = summarizeProviders(r.controller?.providers);
  const warnings = [...lanWarnings, ...(Array.isArray(r.xray?.warnings) ? r.xray.warnings.filter((w) => typeof w === "string") : [])];
  if (state === "ok") {
    for (const p of providers) if (p.count === 0) warnings.push(`订阅 ${p.name} 没有拉到任何节点`);
    const desired = typeof intent.selected === "string" ? intent.selected : null;
    const now = typeof r.controller?.now === "string" ? r.controller.now : null;
    if (desired && now && desired !== now) warnings.push(`期望节点 ${desired} 不可用，当前为 ${now}`);
  }
  return {
    protocol: 1,
    updated_at: typeof r.now === "number" ? r.now : Math.floor(Date.now() / 1000),
    state,
    enabled,
    allow_lan: intent.allow_lan === true,
    lan_cidrs: lanCidrs,
    guard: facts.guard,
    tun: facts.tun,
    core_pid: facts.core_alive && Number.isInteger(core.pid) ? core.pid : null,
    engine: intent.engine === "xray" ? "xray" : "mihomo",
    xray_pid: Number.isInteger(r.xray?.pid) ? r.xray.pid : null,
    restarts: Number.isInteger(r.restarts) ? r.restarts : 0,
    selected: typeof r.controller?.now === "string" ? r.controller.now : null,
    providers,
    warnings,
    last_error: typeof r.last_error === "string" && r.last_error.trim() ? r.last_error.trim().slice(-500) : null,
  };
}

/**
 * 读取 stdin 全部内容。
 * @returns {Promise<string>} 文本
 */
async function readStdin() {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  if (cmd === "status") {
    let raw = {};
    try {
      raw = JSON.parse(await readStdin());
    } catch {
      raw = {};
    }
    process.stdout.write(JSON.stringify(buildStatus(raw)) + "\n");
  } else {
    process.stderr.write("用法：node tdc-proxy-lib.mjs status < facts.json\n");
    process.exit(2);
  }
}
