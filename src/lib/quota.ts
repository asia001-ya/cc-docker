/**
 * 额度展示的派生计算（状态色、进度条、重置倒计时）。UI 组件只消费这里的结果。
 */
import type { FleetEntry, Health, QuotaWindow } from "../api/types";

/** 状态灯颜色（DESIGN.md 语义色） */
export const HEALTH_COLOR: Record<Health, string> = {
  healthy: "#28CA41",
  warning: "#FCE100",
  exhausted: "#FF5449",
  stopped: "#8A8886",
  unknown: "#8A8886",
  api: "#60CDFF",
};

/** 状态中文名 */
export const HEALTH_LABEL: Record<Health, string> = {
  healthy: "额度充足",
  warning: "额度预警",
  exhausted: "额度耗尽",
  stopped: "已停止",
  unknown: "额度未知",
  api: "API 按量",
};

/**
 * 计算单窗口剩余百分比（重置时间已过视为 100）。
 * @param win 额度窗口
 * @param now 当前 epoch 秒
 * @returns 剩余百分比与是否推断；无数据返回 null
 */
export function windowRemaining(win: QuotaWindow | null | undefined, now: number): { pct: number; inferred: boolean } | null {
  if (!win || typeof win.used_percentage !== "number") return null;
  if (typeof win.resets_at === "number" && now >= win.resets_at) return { pct: 100, inferred: true };
  return { pct: Math.max(0, Math.min(100, 100 - win.used_percentage)), inferred: false };
}

/**
 * 按剩余百分比取颜色。
 * @param pct 剩余百分比
 * @param warn 黄色阈值
 * @param critical 红色阈值
 * @returns 颜色值
 */
export function colorForRemaining(pct: number, warn = 30, critical = 5): string {
  if (pct > warn) return HEALTH_COLOR.healthy;
  if (pct >= critical) return HEALTH_COLOR.warning;
  return HEALTH_COLOR.exhausted;
}

/**
 * 生成方块进度条文本，如 ■■■■■■■■░░。
 * @param pct 百分比 0~100
 * @param cells 格数
 * @returns 进度条文本
 */
export function blockBar(pct: number, cells = 10): string {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * cells);
  return "■".repeat(filled) + "░".repeat(cells - filled);
}

/**
 * 格式化重置时间：今天显示 HH:mm，其它显示 M/D HH:mm。
 * @param resetsAt epoch 秒
 * @param now 当前 epoch 秒
 * @returns 文本；空值返回空串
 */
export function formatReset(resetsAt: number | null | undefined, now: number): string {
  if (typeof resetsAt !== "number") return "";
  const d = new Date(resetsAt * 1000);
  const n = new Date(now * 1000);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/**
 * 格式化剩余时长，如 2小时13分 / 45分 / 3天2小时。
 * @param resetsAt epoch 秒
 * @param now 当前 epoch 秒
 * @returns 文本；已过期返回"即将重置"
 */
export function formatCountdown(resetsAt: number | null | undefined, now: number): string {
  if (typeof resetsAt !== "number") return "";
  const s = resetsAt - now;
  if (s <= 0) return "即将重置";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  return `${Math.max(1, m)}分`;
}

/**
 * 数据新鲜度描述（额度只在 claude 运行时刷新，需要让用户知道数据有多旧）。
 * @param updatedAt epoch 秒
 * @param now 当前 epoch 秒
 * @returns 如"刚刚" / "12 分钟前" / "未上报"
 */
export function freshness(updatedAt: number | null | undefined, now: number): string {
  if (typeof updatedAt !== "number") return "未上报";
  const s = Math.max(0, now - updatedAt);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/**
 * 侧栏与状态栏使用的单行额度摘要。
 * @param e 容器汇总
 * @returns 如"85%" / "API" / "—"
 */
export function remainingLabel(e: FleetEntry): string {
  if (e.health === "api") return "API";
  if (e.health === "stopped") return "已停止";
  if (!e.remaining) return "—";
  return `${Math.round(e.remaining.remaining)}%`;
}
