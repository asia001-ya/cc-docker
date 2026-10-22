import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryAnalysis, MemoryCleanupResult, MemoryReclaimResult, SystemMemorySnapshot } from "../api/types";

const api = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  memoryAnalyze: vi.fn(),
  memoryCleanup: vi.fn(),
  memoryCompact: vi.fn(),
  memoryReclaim: vi.fn(),
}));
vi.mock("../api/commands", () => ({ ...api, errorText: (error: unknown) => error instanceof Error ? error.message : String(error) }));

import { MEMORY_COOLDOWN_MS, useMemoryStore } from "./memoryStore";

const system: SystemMemorySnapshot = { totalBytes: 8 * 1024 ** 3, availableBytes: 2 * 1024 ** 3,
  usedBytes: 6 * 1024 ** 3, commitBytes: 5 * 1024 ** 3, commitLimitBytes: 16 * 1024 ** 3, sampledAtMs: 1000 };
const target = { pid: 100, createdAt: "134059583021234567" };
const analysis: MemoryAnalysis = {
  system, supported: true, reason: null, wsl: { supported: true, reason: null }, running: false, cooldownRemainingMs: 0,
  processes: [{ ...target, name: "test-app.exe", workingSetBytes: 1024 ** 3, privateBytes: 1024 ** 3, eligible: true, reason: null },
    { pid: 200, createdAt: "134059583020000000", name: "explorer.exe", workingSetBytes: 200 * 1024 ** 2, privateBytes: 100 * 1024 ** 2, eligible: false, reason: "桌面 Shell" }],
};
const result: MemoryCleanupResult = {
  systemBefore: system, systemAfter: { ...system, availableBytes: system.availableBytes + 1024 ** 3 },
  processes: [{ ...target, name: "test-app.exe", status: "trimmed", beforeBytes: 1024 ** 3, afterBytes: 100 * 1024 ** 2, reason: null }],
  wsl: null, errors: [], observationSeconds: 5,
};
const wslResult: MemoryReclaimResult = { operation: "compact", cacheBeforeBytes: 1024 ** 3, cacheAfterBytes: 1024 ** 3,
  hostBeforeBytes: 2 * 1024 ** 3, hostAfterBytes: 1024 ** 3, observationSeconds: 30 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.isTauri.mockReturnValue(true);
  api.memoryAnalyze.mockResolvedValue(analysis);
  api.memoryCleanup.mockResolvedValue(result);
  api.memoryCompact.mockResolvedValue(wslResult);
  api.memoryReclaim.mockResolvedValue({ ...wslResult, operation: "cache", observationSeconds: 15 });
  useMemoryStore.setState({ analysis: null, pending: null, error: null, lastOperationError: null, result: null, wslResult: null, cooldownUntil: 0, revision: 0 });
});

describe("memory analysis lifecycle", () => {
  it("deduplicates opening and refreshing while an analysis is in progress", async () => {
    const response = deferred<MemoryAnalysis>();
    api.memoryAnalyze.mockReturnValue(response.promise);
    const first = useMemoryStore.getState().analyze();
    const second = useMemoryStore.getState().analyze();
    expect(second).toBe(first);
    expect(api.memoryAnalyze).toHaveBeenCalledOnce();
    response.resolve(analysis);
    await first;
    expect(useMemoryStore.getState().analysis).toEqual(analysis);
    expect(useMemoryStore.getState().pending).toBeNull();
  });

  it("discards an older analysis that finishes after cleanup starts", async () => {
    useMemoryStore.setState({ analysis });
    const snapshot = deferred<MemoryAnalysis>();
    const cleaning = deferred<MemoryCleanupResult>();
    api.memoryAnalyze.mockReturnValueOnce(snapshot.promise).mockResolvedValueOnce({ ...analysis, system: result.systemAfter });
    api.memoryCleanup.mockReturnValue(cleaning.promise);
    const oldAnalysis = useMemoryStore.getState().analyze();
    const cleanup = useMemoryStore.getState().cleanup({ targets: [target], includeWslCache: false });
    snapshot.resolve({ ...analysis, system: { ...system, availableBytes: 1 }, running: false, cooldownRemainingMs: 0 });
    await oldAnalysis;
    expect(useMemoryStore.getState().pending).toBe("clean");
    expect(useMemoryStore.getState().analysis?.system?.availableBytes).toBe(system.availableBytes);
    cleaning.resolve(result);
    await cleanup;
    expect(useMemoryStore.getState().result).toEqual(result);
    expect(useMemoryStore.getState().analysis?.system).toEqual(result.systemAfter);
    expect(api.memoryAnalyze).toHaveBeenCalledTimes(2);
  });

  it("keeps completed results and local cooldown when the panel reopens", async () => {
    useMemoryStore.setState({ analysis });
    await useMemoryStore.getState().cleanup({ targets: [target], includeWslCache: false });
    const until = useMemoryStore.getState().cooldownUntil;
    await useMemoryStore.getState().analyze();
    expect(useMemoryStore.getState().result).toEqual(result);
    expect(useMemoryStore.getState().cooldownUntil).toBeGreaterThanOrEqual(until);
  });

  it("does not invoke desktop commands in browser preview", async () => {
    api.isTauri.mockReturnValue(false);
    await useMemoryStore.getState().analyze();
    await useMemoryStore.getState().cleanup({ targets: [target], includeWslCache: true });
    await useMemoryStore.getState().reclaimWsl("cache");
    await useMemoryStore.getState().reclaimWsl("compact");
    expect(useMemoryStore.getState().analysis?.supported).toBe(false);
    expect(useMemoryStore.getState().analysis?.reason).toContain("Windows 桌面应用");
    expect(api.memoryAnalyze).not.toHaveBeenCalled();
    expect(api.memoryCleanup).not.toHaveBeenCalled();
    expect(api.memoryReclaim).not.toHaveBeenCalled();
    expect(api.memoryCompact).not.toHaveBeenCalled();
  });
});

describe("memory operations", () => {
  it("requires explicit targets or an explicitly enabled WSL option", async () => {
    useMemoryStore.setState({ analysis });
    await useMemoryStore.getState().cleanup({ targets: [], includeWslCache: false });
    expect(api.memoryCleanup).not.toHaveBeenCalled();
    await useMemoryStore.getState().cleanup({ targets: [], includeWslCache: true });
    expect(api.memoryCleanup).toHaveBeenCalledWith({ targets: [], includeWslCache: true });
  });

  it("passes only explicitly chosen, eligible identities and preserves FILETIME text", async () => {
    useMemoryStore.setState({ analysis });
    await useMemoryStore.getState().cleanup({ targets: [target, target, { ...target, createdAt: "old-identity" },
      { pid: 200, createdAt: "134059583020000000" }], includeWslCache: false });
    expect(api.memoryCleanup).toHaveBeenCalledWith({ targets: [target], includeWslCache: false });
  });

  it("keeps cleanup running across panel refresh and blocks Windows and WSL duplicates", async () => {
    useMemoryStore.setState({ analysis });
    const response = deferred<MemoryCleanupResult>();
    api.memoryCleanup.mockReturnValue(response.promise);
    const cleanup = useMemoryStore.getState().cleanup({ targets: [target], includeWslCache: false });
    await useMemoryStore.getState().analyze();
    await useMemoryStore.getState().cleanup({ targets: [target], includeWslCache: false });
    await useMemoryStore.getState().reclaimWsl("compact");
    expect(useMemoryStore.getState().pending).toBe("clean");
    expect(api.memoryAnalyze).not.toHaveBeenCalled();
    expect(api.memoryCleanup).toHaveBeenCalledOnce();
    expect(api.memoryCompact).not.toHaveBeenCalled();
    response.resolve(result);
    await cleanup;
    await useMemoryStore.getState().reclaimWsl("cache");
    expect(api.memoryReclaim).not.toHaveBeenCalled();
    expect(useMemoryStore.getState().result).toEqual(result);
    expect(useMemoryStore.getState().pending).toBeNull();
  });

  it("applies shared cooldown after failure and allows a later retry", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    useMemoryStore.setState({ analysis });
    api.memoryCompact.mockRejectedValueOnce(new Error("整理失败"));
    await useMemoryStore.getState().reclaimWsl("compact");
    expect(useMemoryStore.getState().error).toBe("整理失败");
    expect(useMemoryStore.getState().cooldownUntil).toBe(now + MEMORY_COOLDOWN_MS);
    await useMemoryStore.getState().cleanup({ targets: [target], includeWslCache: false });
    expect(api.memoryCleanup).not.toHaveBeenCalled();
    now += MEMORY_COOLDOWN_MS;
    await useMemoryStore.getState().cleanup({ targets: [target], includeWslCache: false });
    expect(api.memoryCleanup).toHaveBeenCalledOnce();
    expect(useMemoryStore.getState().error).toBeNull();
    vi.restoreAllMocks();
  });

  it("uses backend running and cooldown state to block a conflicting operation", async () => {
    api.memoryAnalyze.mockResolvedValue({ ...analysis, running: true, cooldownRemainingMs: 5_000 });
    await useMemoryStore.getState().analyze();
    await useMemoryStore.getState().cleanup({ targets: [target], includeWslCache: false });
    await useMemoryStore.getState().reclaimWsl("cache");
    expect(api.memoryCleanup).not.toHaveBeenCalled();
    expect(api.memoryReclaim).not.toHaveBeenCalled();
    expect(useMemoryStore.getState().cooldownUntil).toBeGreaterThan(Date.now());
  });

  it("keeps ordinary Windows cleanup available while WSL is unavailable", async () => {
    useMemoryStore.setState({ analysis: { ...analysis, wsl: { supported: false, reason: "未连接 WSL" } } });
    await useMemoryStore.getState().cleanup({ targets: [target], includeWslCache: true });
    await useMemoryStore.getState().reclaimWsl("cache");
    expect(api.memoryCleanup).not.toHaveBeenCalled();
    expect(api.memoryReclaim).not.toHaveBeenCalled();
    await useMemoryStore.getState().cleanup({ targets: [target], includeWslCache: false });
    expect(api.memoryCleanup).toHaveBeenCalledOnce();
  });

  it("refreshes after cleanup without dropping results or briefly clearing pending", async () => {
    useMemoryStore.setState({ analysis });
    const fresh = deferred<MemoryAnalysis>();
    api.memoryAnalyze.mockReturnValueOnce(fresh.promise);
    const phases: (string | null)[] = [];
    const unsubscribe = useMemoryStore.subscribe((state) => phases.push(state.pending));
    const cleanup = useMemoryStore.getState().cleanup({ targets: [target], includeWslCache: false });
    await Promise.resolve();
    expect(useMemoryStore.getState().pending).toBe("analysis");
    expect(useMemoryStore.getState().result).toEqual(result);
    expect(phases).not.toContain(null);
    fresh.resolve({ ...analysis, system: result.systemAfter });
    await cleanup;
    unsubscribe();
    expect(useMemoryStore.getState().pending).toBeNull();
    expect(useMemoryStore.getState().analysis?.system).toEqual(result.systemAfter);
  });

  it("keeps a missing final system reading null until refreshed instead of presenting a stale value", async () => {
    useMemoryStore.setState({ analysis });
    const fresh = deferred<MemoryAnalysis>();
    api.memoryCleanup.mockResolvedValueOnce({ ...result, systemAfter: null });
    api.memoryAnalyze.mockReturnValueOnce(fresh.promise);
    const cleanup = useMemoryStore.getState().cleanup({ targets: [target], includeWslCache: false });
    await Promise.resolve();
    expect(useMemoryStore.getState().analysis?.system).toBeNull();
    fresh.resolve(analysis);
    await cleanup;
    expect(useMemoryStore.getState().result?.systemAfter).toBeNull();
    expect(useMemoryStore.getState().analysis?.system).toEqual(system);
  });

  it("retains the operation error when the subsequent analysis also fails", async () => {
    useMemoryStore.setState({ analysis });
    api.memoryCleanup.mockRejectedValueOnce(new Error("工作集整理失败"));
    api.memoryAnalyze.mockRejectedValueOnce(new Error("后续采样失败"));
    await useMemoryStore.getState().cleanup({ targets: [target], includeWslCache: false });
    expect(useMemoryStore.getState().error).toBe("工作集整理失败");
    expect(useMemoryStore.getState().cooldownUntil).toBeGreaterThan(Date.now());
    expect(useMemoryStore.getState().pending).toBeNull();
  });

  it("keeps the last operation failure across manual refresh and reopening until the next operation", async () => {
    useMemoryStore.setState({ analysis });
    api.memoryCleanup.mockRejectedValueOnce(new Error("整理对象权限不足"));
    await useMemoryStore.getState().cleanup({ targets: [target], includeWslCache: false });
    await useMemoryStore.getState().analyze();
    expect(useMemoryStore.getState().error).toBe("整理对象权限不足");
    useMemoryStore.setState({ cooldownUntil: 0 });
    await useMemoryStore.getState().cleanup({ targets: [target], includeWslCache: false });
    expect(useMemoryStore.getState().error).toBeNull();
    expect(useMemoryStore.getState().lastOperationError).toBeNull();
    expect(useMemoryStore.getState().result).toEqual(result);
  });

  it("clears an analysis failure after a successful analysis retry", async () => {
    api.memoryAnalyze.mockRejectedValueOnce(new Error("无法枚举进程"));
    await useMemoryStore.getState().analyze();
    expect(useMemoryStore.getState().error).toBe("无法枚举进程");
    await useMemoryStore.getState().analyze();
    expect(useMemoryStore.getState().error).toBeNull();
    expect(useMemoryStore.getState().analysis).toEqual(analysis);
  });
});
