import { create } from "zustand";
import { errorText, isTauri, memoryAnalyze, memoryCleanup, memoryCompact, memoryReclaim } from "../api/commands";
import type { MemoryAnalysis, MemoryCleanupRequest, MemoryCleanupResult, MemoryReclaimResult } from "../api/types";

export const MEMORY_COOLDOWN_MS = 30_000;
export type MemoryPending = "analysis" | "clean" | "wsl-cache" | "wsl-compact";

interface MemoryStore {
  analysis: MemoryAnalysis | null;
  pending: MemoryPending | null;
  error: string | null;
  /** 分析刷新不能抹除最近一次操作失败；下次主动清理时重置。 */
  lastOperationError: string | null;
  result: MemoryCleanupResult | null;
  wslResult: MemoryReclaimResult | null;
  cooldownUntil: number;
  revision: number;
  analyze: () => Promise<void>;
  cleanup: (request: MemoryCleanupRequest) => Promise<void>;
  reclaimWsl: (operation: MemoryReclaimResult["operation"]) => Promise<void>;
}

/** 状态由应用持有，面板关闭不取消分析或清理，也不会丢失最近结果。 */
export const useMemoryStore = create<MemoryStore>((set, get) => {
  let analysisInFlight: { revision: number; promise: Promise<void> } | null = null;

  const analyze = (operationRevision?: number): Promise<void> => {
    if (operationRevision === undefined) {
      if (get().pending === "analysis" && analysisInFlight) return analysisInFlight.promise;
      if (get().pending) return Promise.resolve();
    } else if (get().revision !== operationRevision) return Promise.resolve();
    const previousError = get().lastOperationError;
    const revision = get().revision + 1;
    set({ pending: "analysis", revision, error: previousError });
    const request = { revision, promise: Promise.resolve() };
    request.promise = (async () => {
      try {
        const analysis: MemoryAnalysis = isTauri() ? await memoryAnalyze() : {
          system: null, processes: [], supported: false, reason: "请在 Windows 桌面应用中分析和整理内存。",
          wsl: { supported: false, reason: "浏览器预览不连接 WSL。" }, running: false, cooldownRemainingMs: 0,
        };
        if (get().revision !== revision) return;
        set({ analysis, cooldownUntil: Math.max(get().cooldownUntil, Date.now() + Math.max(0, analysis.cooldownRemainingMs)) });
      } catch (error) {
        if (get().revision === revision && !previousError) set({ error: errorText(error) });
      } finally {
        if (get().revision === revision) set({ pending: null });
        if (analysisInFlight === request) analysisInFlight = null;
      }
    })();
    // 浏览器分析无异步等待，可以在赋值前完成；只有仍处于分析阶段时才记为在途。
    if (get().pending === "analysis") analysisInFlight = request;
    return request.promise;
  };

  const canRun = () => {
    const state = get();
    return isTauri() && (!state.pending || state.pending === "analysis")
      && !state.analysis?.running && Date.now() >= state.cooldownUntil;
  };

  const run = async (pending: Exclude<MemoryPending, "analysis">, action: () => Promise<MemoryCleanupResult | MemoryReclaimResult>) => {
    if (!canRun()) return;
    const revision = get().revision + 1;
    // 使仍在飞行中的分析失效，避免旧快照覆盖清理结果、运行状态或冷却。
    set({ pending, revision, error: null, lastOperationError: null, result: null, wslResult: null });
    try {
      const response = await action();
      if (get().revision !== revision) return;
      if (pending === "clean") {
        const result = response as MemoryCleanupResult;
        const analysis = get().analysis;
        set({ result, analysis: analysis ? {
          ...analysis,
          system: result.systemAfter,
          processes: analysis.processes.map((process) => {
            const sampled = result.processes.find((item) => item.pid === process.pid && item.createdAt === process.createdAt);
            return sampled?.status === "trimmed" && sampled.afterBytes !== null
              ? { ...process, workingSetBytes: sampled.afterBytes } : process;
          }),
        } : null });
      } else set({ wslResult: response as MemoryReclaimResult });
    } catch (error) {
      if (get().revision === revision) {
        const message = errorText(error);
        set({ error: message, lastOperationError: message });
      }
    } finally {
      if (get().revision === revision) {
        const analysis = get().analysis;
        set({ cooldownUntil: Date.now() + MEMORY_COOLDOWN_MS,
          analysis: analysis ? { ...analysis, running: false, cooldownRemainingMs: MEMORY_COOLDOWN_MS } : null });
        // 直接转入重新分析，面板关闭时仍刷新；失败后的刷新不覆盖操作错误。
        await analyze(revision);
      }
    }
  };

  return {
    analysis: null,
    pending: null,
    error: null,
    lastOperationError: null,
    result: null,
    wslResult: null,
    cooldownUntil: 0,
    revision: 0,
    analyze: () => analyze(),
    cleanup: (request) => {
      const analysis = get().analysis;
      if (!analysis?.supported || (!request.targets.length && !request.includeWslCache)) return Promise.resolve();
      if (request.includeWslCache && !analysis.wsl.supported) return Promise.resolve();
      // 后端仍会重新核对身份和资格；这里防止 UI 误传未选择或分析中禁止整理的目标。
      const targets = request.targets.filter((target, index) => request.targets.findIndex((item) => item.pid === target.pid && item.createdAt === target.createdAt) === index
        && analysis.processes.some((process) => process.eligible && process.pid === target.pid && process.createdAt === target.createdAt));
      if (!targets.length && !request.includeWslCache) return Promise.resolve();
      return run("clean", () => memoryCleanup({ targets, includeWslCache: request.includeWslCache }));
    },
    reclaimWsl: (operation) => {
      if (!get().analysis?.wsl.supported) return Promise.resolve();
      return run(operation === "compact" ? "wsl-compact" : "wsl-cache", operation === "compact" ? memoryCompact : memoryReclaim);
    },
  };
});
