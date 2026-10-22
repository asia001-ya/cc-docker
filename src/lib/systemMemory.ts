import type { MemoryCleanupResult, ProcessTrimResult, SystemMemorySnapshot } from "../api/types";

const MIB = 1024 ** 2;

export function memorySize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "读数不可用";
  if (bytes === 0) return "0 MiB";
  if (bytes > 0 && bytes < MIB / 10) return "小于 0.1 MiB";
  return bytes >= 1024 * MIB ? `${(bytes / (1024 * MIB)).toFixed(2)} GiB` : `${(bytes / MIB).toFixed(1)} MiB`;
}

/** 自然波动不显示为明显的内存回收效果。 */
function noticeable(change: number, before: number): boolean {
  return change >= Math.max(8 * MIB, before * 0.01);
}

export function systemMemoryTone(before: SystemMemorySnapshot | null, after: SystemMemorySnapshot | null): "info" | "success" {
  if (!before || !after) return "info";
  return noticeable(after.availableBytes - before.availableBytes, before.usedBytes) ? "success" : "info";
}

/** 只报告整机可用量的前后变化，不将进程工作集或 WSL 缓存加到其中。 */
export function systemMemorySummary(before: SystemMemorySnapshot | null, after: SystemMemorySnapshot | null): string {
  if (!before || !after) return "整机可用内存读数不完整，无法确认整机内存变化。";
  const change = after.availableBytes - before.availableBytes;
  const reading = `整机可用内存：${memorySize(before.availableBytes)} → ${memorySize(after.availableBytes)}（前后采样）。`;
  if (change > 0) return `${systemMemoryTone(before, after) === "success" ? `整机可用内存增加 ${memorySize(change)}` : `整机可用内存仅增加 ${memorySize(change)}，未观察到明显变化`}。\n${reading}`;
  if (change < 0) return `未观察到整机可用内存增加；采样期间减少 ${memorySize(-change)}。\n${reading}`;
  return `未观察到整机可用内存增加，前后采样相同。\n${reading}`;
}

export function processMemorySummary(result: ProcessTrimResult): string {
  if (result.status === "skipped") return `已跳过：${result.reason ?? "无法确认该进程可以安全整理"}。`;
  if (result.beforeBytes === null || result.afterBytes === null) return `工作集整理已完成；读数不完整，无法确认工作集变化。${result.reason ? ` ${result.reason}` : ""}`;
  const change = result.beforeBytes - result.afterBytes;
  if (change > 0) return noticeable(change, result.beforeBytes)
    ? `工作集减少 ${memorySize(change)}（前后采样）。`
    : `工作集仅减少 ${memorySize(change)}，未观察到明显下降。`;
  if (change < 0) return `工作集整理已完成；采样期间工作集增加 ${memorySize(-change)}，未观察到下降。`;
  return "工作集整理已完成；前后采样相同，未观察到下降。";
}

export function cleanupSummary(result: MemoryCleanupResult): string {
  return `${systemMemorySummary(result.systemBefore, result.systemAfter)}\n观察 ${result.observationSeconds} 秒；采样变化也可能受到其他程序活动影响。`;
}

export function cleanupTone(result: MemoryCleanupResult): "info" | "success" | "warning" {
  if (result.errors.length > 0 || result.processes.some((process) => process.status === "skipped")) return "warning";
  return systemMemoryTone(result.systemBefore, result.systemAfter);
}
