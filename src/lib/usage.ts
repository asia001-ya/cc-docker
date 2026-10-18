import type { UsageContainerSummary, UsageMetrics, UsageQuery, UsageTrendPoint } from "../api/types";

export type UsageRange = "today" | "7d" | "30d" | "all" | "custom";
export type TrendMetric = "costUsd" | "requests" | "totalTokens";

export const USAGE_RANGES: { value: UsageRange; label: string }[] = [
  { value: "today", label: "今日" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "all", label: "全部" },
  { value: "custom", label: "自定义" },
];

export const ZERO_USAGE: UsageMetrics = {
  requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, cacheHitRate: 0,
};

/** 按当前 Docker 清单区分现存容器与历史记录；清单读取失败时不推断容器已移除。 */
export function partitionUsageContainers(items: UsageContainerSummary[], currentNames: ReadonlySet<string> | null): {
  current: UsageContainerSummary[];
  historical: UsageContainerSummary[];
  unconfirmed: UsageContainerSummary[];
} {
  const current: UsageContainerSummary[] = [];
  const historical: UsageContainerSummary[] = [];
  const unconfirmed: UsageContainerSummary[] = [];
  for (const item of items) {
    if (item.container === "未归属（历史）") historical.push(item);
    else if (currentNames === null) unconfirmed.push(item);
    else if (currentNames.has(item.container)) current.push(item);
    else historical.push(item);
  }
  return { current, historical, unconfirmed };
}

/** 使用本地日期，避免 UTC 转换使日期选择前移一天。 */
export function localDateInput(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseLocalDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

/** 日期选择含结束当天；IPC 使用结束次日零点，不依赖一天固定为 24 小时。 */
export function usageDateRange(range: UsageRange, start: string, end: string, now = new Date()): Pick<UsageQuery, "from" | "to" | "utcOffsetMinutes"> & { error?: string } {
  const utcOffsetMinutes = -now.getTimezoneOffset();
  if (range === "all") return { utcOffsetMinutes };
  let from: Date;
  let to: Date;
  if (range === "custom") {
    const first = parseLocalDate(start);
    const last = parseLocalDate(end);
    if (!first || !last) return { utcOffsetMinutes, error: "请选择有效的开始和结束日期" };
    if (first > last) return { utcOffsetMinutes, error: "结束日期不能早于开始日期" };
    from = first;
    to = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  } else {
    const count = range === "today" ? 1 : range === "7d" ? 7 : 30;
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - count + 1);
    to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  }
  return { from: Math.floor(from.getTime() / 1000), to: Math.floor(to.getTime() / 1000), utcOffsetMinutes };
}

export function formatUsageNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
}

export function formatUsageCompact(value: number): string {
  if (value >= 1_000_000) return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value / 1_000_000)}M`;
  if (value >= 10_000) return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value / 1000)}K`;
  return formatUsageNumber(value);
}

/** 小额请求也显示有效数字，不把已产生成本四舍五入成零。 */
export function formatUsageCost(value: number): string {
  const digits = value > 0 && value < 0.01 ? 6 : value < 1 && value > 0 ? 4 : 2;
  if (value > 0 && value < 0.000001) return "<$0.000001";
  return `$${new Intl.NumberFormat("en-US", { minimumFractionDigits: value === 0 ? 2 : Math.min(digits, 2), maximumFractionDigits: digits }).format(value)}`;
}

export function formatUsagePercent(value: number, hasInput = true): string {
  return hasInput ? `${(value * 100).toFixed(1)}%` : "—";
}

export function formatUsageSpeed(value: number | null): string {
  return value !== null && Number.isFinite(value) && value >= 0 ? `${value.toFixed(1)} t/s` : "—";
}

export function addUsageMetrics(a: UsageMetrics, b: UsageMetrics): UsageMetrics {
  const value = {
    requests: a.requests + b.requests,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    costUsd: a.costUsd + b.costUsd,
    cacheHitRate: 0,
  };
  const input = value.inputTokens + value.cacheReadTokens + value.cacheWriteTokens;
  value.cacheHitRate = input ? value.cacheReadTokens / input : 0;
  return value;
}

/** 补齐没有用量的日期，并将长区间合并为月，保证多年历史仍可阅读。 */
export function displayUsageTrend(points: UsageTrendPoint[], query: Pick<UsageQuery, "from" | "to" | "utcOffsetMinutes">): { points: UsageTrendPoint[]; monthly: boolean } {
  const offset = (query.utcOffsetMinutes ?? 0) * 60;
  const asDate = (stamp: number) => new Date((stamp + offset) * 1000).toISOString().slice(0, 10);
  const ordered = points.slice().sort((a, b) => a.date.localeCompare(b.date));
  const first = query.from !== undefined ? asDate(query.from) : ordered[0]?.date;
  const last = query.to !== undefined ? asDate(query.to - 1) : ordered[ordered.length - 1]?.date;
  if (!first || !last) return { points: [], monthly: false };
  const start = Date.parse(`${first}T00:00:00Z`);
  const finish = Date.parse(`${last}T00:00:00Z`);
  const monthly = (finish - start) / 86_400_000 > 62;
  const map = new Map<string, UsageMetrics>();
  for (const point of ordered) {
    const key = monthly ? point.date.slice(0, 7) : point.date;
    map.set(key, addUsageMetrics(map.get(key) ?? ZERO_USAGE, point.metrics));
  }
  const filled: UsageTrendPoint[] = [];
  if (monthly) {
    const current = new Date(start);
    current.setUTCDate(1);
    // Date inputs are browser-bounded; this also bounds payload rendering for malformed source dates.
    for (let i = 0; current.getTime() <= finish && i < 1200; i++) {
      const key = current.toISOString().slice(0, 7);
      filled.push({ date: key, metrics: map.get(key) ?? ZERO_USAGE });
      current.setUTCMonth(current.getUTCMonth() + 1);
    }
  } else {
    for (let stamp = start; stamp <= finish; stamp += 86_400_000) {
      const key = new Date(stamp).toISOString().slice(0, 10);
      filled.push({ date: key, metrics: map.get(key) ?? ZERO_USAGE });
    }
  }
  return { points: filled, monthly };
}
