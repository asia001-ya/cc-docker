import { describe, expect, it } from "vitest";
import type { MemoryCleanupResult, ProcessTrimResult, SystemMemorySnapshot } from "../api/types";
import { cleanupSummary, cleanupTone, memorySize, processMemorySummary, systemMemorySummary, systemMemoryTone } from "./systemMemory";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const system: SystemMemorySnapshot = { totalBytes: 8 * GIB, availableBytes: 2 * GIB, usedBytes: 6 * GIB,
  commitBytes: 5 * GIB, commitLimitBytes: 16 * GIB, sampledAtMs: 1000 };
const process: ProcessTrimResult = { pid: 100, createdAt: "134059583021234567", name: "test-app.exe",
  status: "trimmed", beforeBytes: GIB, afterBytes: 100 * MIB, reason: null };
const result: MemoryCleanupResult = { systemBefore: system, systemAfter: { ...system, availableBytes: system.availableBytes + GIB },
  processes: [process], wsl: null, errors: [], observationSeconds: 5 };

describe("memory reports", () => {
  it("reports system availability, process working set, and WSL independently", () => {
    const text = cleanupSummary({ ...result, wsl: { operation: "cache", cacheBeforeBytes: 3 * GIB,
      cacheAfterBytes: GIB, hostBeforeBytes: 5 * GIB, hostAfterBytes: GIB, observationSeconds: 15 } });
    expect(text).toContain("整机可用内存增加 1.00 GiB");
    expect(text).not.toContain("WSL");
    expect(text).not.toContain("工作集");
    expect(text).not.toContain("5.00 GiB");
    expect(processMemorySummary(process)).toContain("工作集减少 924.0 MiB");
    expect(cleanupTone(result)).toBe("success");
  });

  it("describes falling availability, small changes and equal samples honestly", () => {
    expect(systemMemorySummary(system, { ...system, availableBytes: system.availableBytes - 20 * MIB })).toContain("采样期间减少 20.0 MiB");
    expect(systemMemoryTone(system, { ...system, availableBytes: system.availableBytes - 20 * MIB })).toBe("info");
    expect(systemMemorySummary(system, { ...system, availableBytes: system.availableBytes + MIB })).toContain("仅增加 1.0 MiB，未观察到明显变化");
    expect(systemMemoryTone(system, { ...system, availableBytes: system.availableBytes + MIB })).toBe("info");
    expect(systemMemorySummary(system, system)).toContain("前后采样相同");
    expect(systemMemorySummary(system, { ...system, availableBytes: system.availableBytes + 4096 })).toContain("小于 0.1 MiB");
  });

  it("does not turn missing readings into zero or success", () => {
    expect(cleanupSummary({ ...result, systemAfter: null })).toContain("读数不完整");
    expect(cleanupTone({ ...result, systemAfter: null })).toBe("info");
    expect(processMemorySummary({ ...process, afterBytes: null })).toContain("工作集整理已完成；读数不完整");
    expect(processMemorySummary({ ...process, afterBytes: null, reason: "进程在观察期间退出" })).toContain("进程在观察期间退出");
    expect(memorySize(null)).toBe("读数不可用");
    expect(memorySize(0)).toBe("0 MiB");
  });

  it("shows partial failures even when availability increased", () => {
    const skipped: ProcessTrimResult = { ...process, status: "skipped", reason: "进程已退出" };
    expect(processMemorySummary(skipped)).toContain("已跳过：进程已退出");
    expect(cleanupTone({ ...result, processes: [process, skipped] })).toBe("warning");
    expect(cleanupTone({ ...result, errors: ["WSL 缓存回收失败"] })).toBe("warning");
  });

  it("reports rebound and small changes without claiming a clear working set reduction", () => {
    expect(processMemorySummary({ ...process, afterBytes: GIB + 20 * MIB })).toContain("工作集增加 20.0 MiB");
    expect(processMemorySummary({ ...process, afterBytes: GIB - MIB })).toContain("仅减少 1.0 MiB");
    expect(processMemorySummary({ ...process, afterBytes: GIB })).toContain("前后采样相同");
    expect(memorySize(4096)).toBe("小于 0.1 MiB");
  });
});
