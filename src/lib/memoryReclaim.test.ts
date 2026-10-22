import { describe, expect, it } from "vitest";
import type { MemoryReclaimResult } from "../api/types";
import { memoryReclaimSummary, memoryReclaimTone } from "./memoryReclaim";

const gib = 1024 ** 3;
const mib = 1024 ** 2;
const base: MemoryReclaimResult = { operation: "cache", observationSeconds: 15, cacheBeforeBytes: 2 * gib, cacheAfterBytes: gib, hostBeforeBytes: 4 * gib, hostAfterBytes: 4 * gib };

describe("memory reclaim reporting", () => {
  it("keeps cache reduction separate from an unchanged Windows working set", () => {
    const text = memoryReclaimSummary(base);
    expect(text.startsWith("未观察到 VmmemWSL 占用下降")).toBe(true);
    expect(text).toContain("WSL 缓存净减少约 1.00 GiB");
    expect(text).toContain("VmmemWSL：4.00 GiB → 4.00 GiB（观察 15 秒）");
    expect(text).toContain("不等于 Windows 已收回同样多的内存");
    expect(memoryReclaimTone(base)).toBe("info");
  });

  it("reports a meaningful host decrease before the cache estimate", () => {
    const result = { ...base, hostAfterBytes: 3 * gib };
    expect(memoryReclaimSummary(result).startsWith("VmmemWSL 占用减少 1024.0 MiB（前后采样）")).toBe(true);
    expect(memoryReclaimTone(result)).toBe("success");
  });

  it("shows the small host decrease even when GiB readouts round to the same value", () => {
    const result = { ...base, hostBeforeBytes: 2858590208, hostAfterBytes: 2857082880 };
    const text = memoryReclaimSummary(result);
    expect(text.startsWith("VmmemWSL 占用仅减少 1.4 MiB，未观察到明显下降")).toBe(true);
    expect(memoryReclaimTone(result)).toBe("info");
  });

  it("requires both an 8 MiB decrease and a 1% decrease to use a success indication", () => {
    expect(memoryReclaimTone({ ...base, hostBeforeBytes: 100 * mib, hostAfterBytes: 94 * mib })).toBe("info");
    expect(memoryReclaimTone({ ...base, hostAfterBytes: 4 * gib - 20 * mib })).toBe("info");
    expect(memoryReclaimTone({ ...base, hostBeforeBytes: 100 * mib, hostAfterBytes: 92 * mib })).toBe("success");
    expect(memoryReclaimTone({ ...base, hostAfterBytes: 4 * gib * 0.99 })).toBe("success");
  });

  it("reports a growing host working set without a success indication", () => {
    const result = { ...base, hostAfterBytes: 4 * gib + 20 * mib };
    expect(memoryReclaimSummary(result).startsWith("未观察到 VmmemWSL 占用下降；采样期间增加 20.0 MiB")).toBe(true);
    expect(memoryReclaimTone(result)).toBe("info");
  });

  it("does not round a nonzero sub-MiB change to zero", () => {
    const result = { ...base, hostAfterBytes: 4 * gib - 4096 };
    expect(memoryReclaimSummary(result)).toContain("仅减少 小于 0.1 MiB");
    expect(memoryReclaimTone(result)).toBe("info");
  });

  it("does not claim released memory when concurrent work grows cache", () => {
    const text = memoryReclaimSummary({ ...base, cacheBeforeBytes: gib, cacheAfterBytes: 2 * gib, hostBeforeBytes: null, hostAfterBytes: null });
    expect(text).toContain("未观察到缓存净减少");
    expect(text).not.toContain("净减少约 -");
    expect(text).toContain("无法确认宿主内存是否下降");
  });

  it("preserves a successful operation when subsequent measurements are unavailable", () => {
    const text = memoryReclaimSummary({ ...base, cacheBeforeBytes: gib, cacheAfterBytes: null, hostBeforeBytes: gib, hostAfterBytes: null });
    expect(text).toContain("缓存回收操作已完成");
    expect(text).toContain("回收后的读数暂不可用");
    expect(text.startsWith("VmmemWSL 读数不完整，无法确认宿主内存是否下降")).toBe(true);
    expect(text).not.toContain("→");
    expect(memoryReclaimTone({ ...base, hostBeforeBytes: null })).toBe("info");
    expect(memoryReclaimTone({ ...base, hostAfterBytes: null })).toBe("info");
  });

  it("reports compaction without implying that caches were cleared", () => {
    const result: MemoryReclaimResult = { ...base, operation: "compact", observationSeconds: 30, hostAfterBytes: 3 * gib };
    const text = memoryReclaimSummary(result);
    expect(text.startsWith("VmmemWSL 占用减少 1024.0 MiB")).toBe(true);
    expect(text).toContain("观察 30 秒");
    expect(text).toContain("空闲页整理已完成");
    expect(text).not.toContain("缓存净减少");
    expect(text).not.toContain("缓存回收操作已完成");
    expect(memoryReclaimTone(result)).toBe("success");
    expect(memoryReclaimTone({ ...result, hostAfterBytes: result.hostBeforeBytes })).toBe("info");
  });
});
