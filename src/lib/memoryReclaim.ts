import type { MemoryReclaimResult } from "../api/types";

function memorySize(bytes: number): string {
  const mib = bytes / 1024 ** 2;
  return mib >= 1024 ? `${(mib / 1024).toFixed(2)} GiB` : `${mib.toFixed(1)} MiB`;
}

function memoryChange(bytes: number): string {
  const mib = bytes / 1024 ** 2;
  return mib > 0 && mib < 0.1 ? "小于 0.1 MiB" : `${mib.toFixed(1)} MiB`;
}

/** 小幅波动不视为明显释放；始终独立于 Linux 缓存的变化判定。 */
export function memoryReclaimTone(result: MemoryReclaimResult): "info" | "success" {
  if (result.hostBeforeBytes === null || result.hostAfterBytes === null) return "info";
  const reduction = result.hostBeforeBytes - result.hostAfterBytes;
  return reduction >= Math.max(8 * 1024 ** 2, result.hostBeforeBytes * 0.01) ? "success" : "info";
}

/** 缓存与宿主工作集分别报告，避免把缓存估算当作已归还 Windows 的内存。 */
export function memoryReclaimSummary(result: MemoryReclaimResult): string {
  const lines: string[] = [];
  if (result.hostBeforeBytes !== null && result.hostAfterBytes !== null) {
    const reduction = result.hostBeforeBytes - result.hostAfterBytes;
    if (reduction > 0) {
      lines.push(memoryReclaimTone(result) === "success"
        ? `VmmemWSL 占用减少 ${memoryChange(reduction)}（前后采样）。`
        : `VmmemWSL 占用仅减少 ${memoryChange(reduction)}，未观察到明显下降。`);
    } else if (reduction < 0) {
      lines.push(`未观察到 VmmemWSL 占用下降；采样期间增加 ${memoryChange(-reduction)}。`);
    } else {
      lines.push("未观察到 VmmemWSL 占用下降，前后采样相同。");
    }
    lines.push(`VmmemWSL：${memorySize(result.hostBeforeBytes)} → ${memorySize(result.hostAfterBytes)}（观察 ${result.observationSeconds} 秒）。`);
  } else {
    lines.push("VmmemWSL 读数不完整，无法确认宿主内存是否下降。");
  }
  if (result.operation === "cache") {
    if (result.cacheAfterBytes === null) {
      lines.push("缓存回收后的读数暂不可用。");
    } else {
      const reduction = Math.max(0, result.cacheBeforeBytes - result.cacheAfterBytes);
      lines.push(reduction > 0 ? `WSL 缓存净减少约 ${memorySize(reduction)}，不等于 Windows 已收回同样多的内存。` : "本次采样未观察到缓存净减少，运行中的程序可能已重新使用缓存。");
    }
  }
  lines.push(`${result.operation === "compact" ? "空闲页整理" : "缓存回收操作"}已完成；运行中的容器、会话和进程内存会保留。Windows 占用可能稍后变化。`);
  return lines.join("\n");
}
