import { describe, expect, it } from "vitest";
import type { UsageCollectionContainer, UsageContainerSummary } from "../api/types";
import { partitionUsageContainers } from "./usage";

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
