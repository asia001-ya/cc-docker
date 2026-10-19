/** 仅开发模式演示使用；正式构建裁掉模拟的供应商、用量和采集记录。 */
import type { UsageCollectionContainer, UsageLog, UsageMetrics, UsageQuery, UsageResult } from "../api/types";
import { addUsageMetrics, ZERO_USAGE } from "./usage";

const DEMO_COLLECTION: UsageCollectionContainer[] = import.meta.env.DEV ? [
  { container: "claude-dev-01", status: "active", lastCollectedAt: null, error: null, captureReady: true },
  { container: "claude-dev-02", status: "active", lastCollectedAt: null, error: null, captureReady: false },
  { container: "claude-build", status: "stopped", lastCollectedAt: null, error: null },
  { container: "未归属（历史）", status: "stopped", lastCollectedAt: null, error: null },
] : [];

function demoRows(now: Date): UsageLog[] {
  const rows: UsageLog[] = [];
  for (let day = 0; day < 35; day++) {
    for (let index = 0; index < 8 + day % 7; index++) {
      const ordinal = day * 20 + index;
      const historical = index === 0 && day > 15;
      const api = index % 3 !== 0;
      const inputTokens = 650 + ordinal * 19;
      const outputTokens = 350 + ordinal * 7;
      const cacheReadTokens = index % 4 ? 2_400 + ordinal * 37 : 0;
      const cacheWriteTokens = index % 4 ? 0 : 1_800 + ordinal * 11;
      const pricing = !historical ? { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const timestamp = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day, 8 + index, ordinal % 60).getTime() / 1000;
      if (timestamp > now.getTime() / 1000) continue;
      const durationMs = index % 5 ? 15_000 + index * 2_700 : null;
      rows.push({
        id: `demo-usage-${day}-${index}`, timestamp,
        container: historical ? "未归属（历史）" : index % 5 === 0 ? "claude-build" : index % 2 ? "claude-dev-01" : "claude-dev-02",
        sessionId: `demo-session-${day}-${index % 3}`,
        authType: historical ? "unknown" : api ? "api" : "authorization",
        providerId: api && !historical ? "demo-anthropic" : null,
        providerName: historical ? "未知供应商" : api ? "Anthropic API（示例）" : "Claude 授权",
        model: index % 4 === 0 ? "claude-haiku-4-5" : "claude-sonnet-4-6",
        inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
        totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
        costUsd: (inputTokens * pricing.input + outputTokens * pricing.output + cacheReadTokens * pricing.cacheRead + cacheWriteTokens * pricing.cacheWrite) / 1_000_000,
        durationMs, speed: durationMs ? outputTokens / (durationMs / 1000) : null,
        pricing, attribution: historical ? "historical" : "captured",
      });
    }
  }
  return rows;
}

function metricsOf(rows: UsageLog[]): UsageMetrics {
  return rows.reduce((all, row) => addUsageMetrics(all, { ...row, requests: 1, cacheHitRate: 0 }), { ...ZERO_USAGE });
}

export function queryUsageDemo(query: UsageQuery, now = new Date()): UsageResult {
  if (!import.meta.env.DEV) return {
    generatedAt: Math.floor(now.getTime() / 1000), totals: { ...ZERO_USAGE },
    containers: [], trend: [], logs: [], totalLogs: 0,
    page: 1, pageSize: Math.max(1, Math.min(100, query.pageSize ?? 25)),
    providers: [], models: [], collection: { lastCollectedAt: null, containers: [], warnings: [] },
  };
  const rows = demoRows(now);
  const scope = rows.filter((row) =>
    (query.from === undefined || row.timestamp >= query.from)
    && (query.to === undefined || row.timestamp < query.to)
    && (!query.container || row.container === query.container)
    && (!query.authType || row.authType === query.authType)
    && (!query.providerId || row.providerId === query.providerId)
    && (!query.model || row.model === query.model));
  const groups = new Map<string, UsageLog[]>();
  for (const row of scope) {
    const date = new Date((row.timestamp + (query.utcOffsetMinutes ?? 0) * 60) * 1000).toISOString().slice(0, query.granularity === "hour" ? 13 : 10) + (query.granularity === "hour" ? ":00" : "");
    groups.set(date, [...(groups.get(date) ?? []), row]);
  }
  const generatedAt = Math.floor(now.getTime() / 1000);
  const collection = DEMO_COLLECTION.map((item) => ({ ...item, lastCollectedAt: generatedAt - (item.status === "active" ? 10 : 7200) }));
  const pageSize = Math.max(1, Math.min(100, query.pageSize ?? 25));
  const page = Math.max(1, Math.min(Math.ceil(scope.length / pageSize) || 1, query.page ?? 1));
  return {
    generatedAt, totals: metricsOf(scope),
    containers: collection.filter((item) => !query.container || item.container === query.container).map((item) => ({
      container: item.container,
      metrics: metricsOf(scope.filter((row) => row.container === item.container)), collection: item,
    })),
    trend: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([date, values]) => ({ date, metrics: metricsOf(values) })),
    logs: scope.sort((a, b) => b.timestamp - a.timestamp).slice((page - 1) * pageSize, page * pageSize),
    totalLogs: scope.length, page, pageSize,
    providers: [{ id: "demo-anthropic", name: "Anthropic API（示例）" }],
    models: [...new Set(rows.map((row) => row.model))].sort(),
    collection: { lastCollectedAt: generatedAt - 10, containers: collection, warnings: ["演示中包含未归属历史记录，用于展示采集前历史的处理方式；历史记录未计算 API 成本。"] },
  };
}
