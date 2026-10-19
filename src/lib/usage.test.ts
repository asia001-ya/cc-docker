import { describe, expect, it } from "vitest";
import type { UsageCollectionContainer, UsageContainerSummary } from "../api/types";
import { displayUsageTrend, partitionUsageContainers, ZERO_USAGE } from "./usage";

function summary(container: string, status: UsageCollectionContainer["status"], requests = 1): UsageContainerSummary {
  return Object.freeze({
    container,
    metrics: Object.freeze({
      requests, inputTokens: 13, outputTokens: 5, cacheReadTokens: 4,
      cacheWriteTokens: 0, totalTokens: 22, costUsd: 0.000078, cacheHitRate: 4 / 17,
    }),
    collection: Object.freeze({ container, status, lastCollectedAt: 1792322054, error: null }),
  });
}

describe("用量卡片区分现存容器与历史记录", () => {
  it("只有一个现存容器时，已删除容器与未归属历史不增加当前容器数", () => {
    const deleted = summary("claude-dev-01", "stopped");
    const unattributed = summary("未归属（历史）", "stopped", 103);
    const current = summary("claude-01", "active");
    const items = [deleted, unattributed, current];

    const result = partitionUsageContainers(items, new Set(["claude-01"]));

    expect(result.current).toEqual([current]);
    expect(result.historical).toEqual([deleted, unattributed]);
    expect(result.unconfirmed).toEqual([]);
    expect(result.current[0]).toBe(current);
    expect(result.historical[0]).toBe(deleted);
    expect(result.historical[1]).toBe(unattributed);
    expect(items).toEqual([deleted, unattributed, current]);
    expect(result.historical[0].metrics.costUsd).toBe(0.000078);
    expect(result.historical[1].metrics.requests).toBe(103);
  });

  it("已停止但仍存在的容器保留在当前分组，不以采集状态判断是否删除", () => {
    const stopped = summary("claude-paused", "stopped");
    const deleted = summary("claude-removed", "active");
    const unsupported = summary("claude-old-image", "unsupported");
    const failed = summary("claude-collection-error", "error");

    const result = partitionUsageContainers(
      [stopped, deleted, unsupported, failed],
      new Set([stopped.container, unsupported.container, failed.container]),
    );

    expect(result.current).toEqual([stopped, unsupported, failed]);
    expect(result.historical).toEqual([deleted]);
    expect(result.unconfirmed).toEqual([]);
  });

  it("Docker 清单无法确认时，已知名称进入待确认分组而非被判为已删除", () => {
    const stopped = summary("claude-paused", "stopped");
    const unattributed = summary("未归属（历史）", "stopped");
    const active = summary("claude-01", "active");

    const result = partitionUsageContainers([stopped, unattributed, active], null);

    expect(result.current).toEqual([]);
    expect(result.historical).toEqual([unattributed]);
    expect(result.unconfirmed).toEqual([stopped, active]);
    expect(result.unconfirmed[0]).toBe(stopped);
    expect(result.unconfirmed[1]).toBe(active);
  });

  it("已确认空清单时不保留当前容器卡片，历史数据与输入顺序仍保留", () => {
    const active = summary("claude-01", "active");
    const unattributed = summary("未归属（历史）", "stopped");
    const stopped = summary("claude-dev-01", "stopped");

    const result = partitionUsageContainers([active, unattributed, stopped], new Set());

    expect(result.current).toEqual([]);
    expect(result.historical).toEqual([active, unattributed, stopped]);
    expect(result.unconfirmed).toEqual([]);
    expect(result.historical[0].metrics).toBe(active.metrics);
    expect(result.historical[1].metrics).toBe(unattributed.metrics);
    expect(result.historical[2].metrics).toBe(stopped.metrics);
  });

  it("未归属历史是统计分组，即使出现在清单内也不作为真实容器", () => {
    const unattributed = summary("未归属（历史）", "stopped");

    expect(partitionUsageContainers([unattributed], new Set([unattributed.container]))).toEqual({
      current: [], historical: [unattributed], unconfirmed: [],
    });
  });
});

describe("趋势按选定天或小时展示", () => {
  it("小时边界使用查询时区并补齐空小时，结束时间不额外多算一小时", () => {
    const from = Date.UTC(2026, 9, 18, 16) / 1000;
    const metrics = { ...ZERO_USAGE, requests: 2, totalTokens: 45, costUsd: 0.5 };
    const trend = displayUsageTrend([{ date: "2026-10-19T01:00", metrics }], {
      from, to: from + 3 * 3600, utcOffsetMinutes: 480, granularity: "hour",
    });
    expect(trend.granularity).toBe("hour");
    expect(trend.points.map((point) => point.date)).toEqual(["2026-10-19T00:00", "2026-10-19T01:00", "2026-10-19T02:00"]);
    expect(trend.points.map((point) => point.metrics.requests)).toEqual([0, 2, 0]);
    expect(trend.points.reduce((sum, point) => sum + point.metrics.costUsd, 0)).toBe(0.5);
  });

  it("较长日期范围仍保留用户选择的天粒度", () => {
    const from = Date.UTC(2026, 0, 1) / 1000;
    const trend = displayUsageTrend([{ date: "2026-01-05", metrics: { ...ZERO_USAGE, requests: 1 } }], {
      from, to: from + 90 * 86400, granularity: "day",
    });
    expect(trend.granularity).toBe("day");
    expect(trend.points).toHaveLength(90);
    expect(trend.points[4].metrics.requests).toBe(1);
    expect(trend.points.at(-1)?.date).toBe("2026-03-31");
  });

  it("多年小时数据不改变粒度或丢失有用量的数据点", () => {
    const from = Date.UTC(2020, 0, 1) / 1000;
    const to = Date.UTC(2026, 0, 1) / 1000;
    const points = [
      { date: "2020-01-02T00:00", metrics: { ...ZERO_USAGE, totalTokens: 10 } },
      { date: "2025-12-31T10:00", metrics: { ...ZERO_USAGE, totalTokens: 15 } },
    ];
    const trend = displayUsageTrend(points, { from, to, granularity: "hour" });
    expect(trend.points.length).toBeLessThan(12);
    expect(trend.points.reduce((sum, point) => sum + point.metrics.totalTokens, 0)).toBe(25);
    expect(trend.points.find((point) => point.date === "2025-12-31T10:00")?.metrics.totalTokens).toBe(15);
  });
});
