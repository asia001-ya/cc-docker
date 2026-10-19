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

/** Parse a server bucket in the query's fixed local time zone for chart spacing. */
export function trendTimestamp(date: string): number {
  return Date.parse(date.length === 10 ? date + "T00:00:00Z" : date + ":00Z");
}

/** Fill empty days/hours without changing the chosen aggregation or losing non-empty buckets. */
export function displayUsageTrend(points: UsageTrendPoint[], query: Pick<UsageQuery, "from" | "to" | "utcOffsetMinutes" | "granularity">): { points: UsageTrendPoint[]; granularity: "day" | "hour" } {
  const granularity = query.granularity ?? "day";
  const hourly = granularity === "hour";
  const offset = (query.utcOffsetMinutes ?? 0) * 60;
  const asKey = (stampMs: number) => new Date(stampMs).toISOString().slice(0, hourly ? 13 : 10) + (hourly ? ":00" : "");
  const ordered = points.slice().sort((a, b) => a.date.localeCompare(b.date));
  const first = query.from !== undefined ? asKey((query.from + offset) * 1000) : ordered[0]?.date;
  const last = query.to !== undefined ? asKey((query.to - 1 + offset) * 1000) : ordered[ordered.length - 1]?.date;
  if (!first || !last) return { points: [], granularity };
  const start = trendTimestamp(first);
  const finish = trendTimestamp(last);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return { points: [], granularity };
  const step = hourly ? 3_600_000 : 86_400_000;
  const map = new Map(ordered.filter((point) => point.date >= first && point.date <= last).map((point) => [point.date, point.metrics]));
  const fill = (stamp: number) => {
    if (stamp < start || stamp > finish) return;
    const key = asKey(stamp);
    if (!map.has(key)) map.set(key, ZERO_USAGE);
  };
  if ((finish - start) / step <= 3660) {
    for (let stamp = start; stamp <= finish; stamp += step) fill(stamp);
  } else {
    // Preserve the true time axis over long histories, with zero-valued neighbours around activity.
    fill(start);
    fill(finish);
    for (const point of ordered) {
      const stamp = trendTimestamp(point.date);
      if (!Number.isFinite(stamp)) continue;
      fill(stamp - step);
      fill(stamp + step);
    }
  }
  return { points: [...map].sort(([a], [b]) => a.localeCompare(b)).map(([date, metrics]) => ({ date, metrics })), granularity };
}
