import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../api/types";

const api = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  onUpdateState: vi.fn(),
  updateStatus: vi.fn(),
  updateCheck: vi.fn(),
  updateDownload: vi.fn(),
  updateInstall: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../api/commands", () => ({ ...api, errorText: (error: unknown) => error instanceof Error ? error.message : String(error) }));
vi.mock("./uiStore", () => ({ useUiStore: { getState: () => ({ toast: api.toast }) } }));

import { canDownloadUpdate, connectUpdates, useUpdateStore } from "./updateStore";

const release = { version: "1.0.3", notes: "更新说明", publishedAt: null, url: "https://github.com/example/project/releases/tag/v1.0.3" };
const status: UpdateStatus = { currentVersion: "1.0.2", phase: "idle", release: null, downloadedBytes: 0,
  totalBytes: null, checkedAt: null, error: null, installKind: "installer" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.isTauri.mockReturnValue(true);
  useUpdateStore.setState({ status: null, pending: null, commandError: null, revision: 0, notifiedVersion: null });
});

describe("update lifecycle", () => {
  it("subscribes before reading status and keeps events newer than the snapshot", async () => {
    const snapshot = deferred<UpdateStatus>();
    const unsubscribe = vi.fn();
    let listener!: (value: UpdateStatus) => void;
    api.onUpdateState.mockImplementation(async (callback: typeof listener) => { listener = callback; return unsubscribe; });
    api.updateStatus.mockImplementation(() => snapshot.promise);

    const disconnect = connectUpdates();
    expect(api.onUpdateState).toHaveBeenCalledOnce();
    expect(api.updateStatus).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(api.updateStatus).toHaveBeenCalledOnce();
    const downloading: UpdateStatus = { ...status, phase: "downloading", release, downloadedBytes: 100 };
    listener(downloading);
    snapshot.resolve({ ...status, phase: "available", release });
    await Promise.resolve();
    expect(useUpdateStore.getState().status).toEqual(downloading);
    disconnect();
    listener({ ...status, phase: "ready", release });
    expect(useUpdateStore.getState().status).toEqual(downloading);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("cleans up subscriptions that finish registering after the app effect unmounts", async () => {
    const registration = deferred<() => void>();
    const unsubscribe = vi.fn();
    api.onUpdateState.mockReturnValue(registration.promise);
    const disconnect = connectUpdates();
    disconnect();
    registration.resolve(unsubscribe);
    await Promise.resolve();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(api.updateStatus).not.toHaveBeenCalled();
  });

  it("notifies once for a downloaded version across duplicate events and retries", () => {
    const state = useUpdateStore.getState();
    state.receive({ ...status, phase: "ready", release });
    state.receive({ ...status, phase: "ready", release });
    state.receive({ ...status, phase: "checking", release });
    state.receive({ ...status, phase: "ready", release });
    expect(api.toast).toHaveBeenCalledOnce();
    state.receive({ ...status, phase: "ready", release: { ...release, version: "1.0.4" } });
    expect(api.toast).toHaveBeenCalledTimes(2);
  });

  it("does not invoke desktop commands from browser preview", async () => {
    api.isTauri.mockReturnValue(false);
    const disconnect = connectUpdates();
    await useUpdateStore.getState().check();
    await useUpdateStore.getState().download();
    await useUpdateStore.getState().install();
    expect(useUpdateStore.getState().status?.installKind).toBe("development");
    expect(api.onUpdateState).not.toHaveBeenCalled();
    expect(api.updateCheck).not.toHaveBeenCalled();
    expect(api.updateDownload).not.toHaveBeenCalled();
    expect(api.updateInstall).not.toHaveBeenCalled();
    disconnect();
  });
});

describe("update actions", () => {
  it("blocks duplicate commands and retains download events over an old command response", async () => {
    const response = deferred<UpdateStatus>();
    api.updateCheck.mockReturnValue(response.promise);
    const state = useUpdateStore.getState();
    const check = state.check();
    await state.check();
    expect(api.updateCheck).toHaveBeenCalledOnce();
    const downloading: UpdateStatus = { ...status, phase: "downloading", release, downloadedBytes: 50 };
    state.receive(downloading);
    response.resolve({ ...status, phase: "available", release });
    await check;
    expect(useUpdateStore.getState().status).toEqual(downloading);
    expect(useUpdateStore.getState().pending).toBeNull();
  });

  it("makes failed commands retryable while preserving the release status", async () => {
    api.updateDownload.mockRejectedValueOnce(new Error("下载连接中断"));
    const available: UpdateStatus = { ...status, phase: "available", release };
    useUpdateStore.getState().receive(available);
    await useUpdateStore.getState().download();
    expect(useUpdateStore.getState().commandError).toBe("下载连接中断");
    expect(useUpdateStore.getState().status).toEqual(available);
    expect(useUpdateStore.getState().pending).toBeNull();
    api.updateDownload.mockResolvedValueOnce({ ...available, phase: "ready" });
    await useUpdateStore.getState().download();
    expect(useUpdateStore.getState().status?.phase).toBe("ready");
    expect(useUpdateStore.getState().commandError).toBeNull();
  });

  it("downloads only supported packages and installs only ready releases", async () => {
    expect(canDownloadUpdate({ ...status, phase: "available", release, installKind: "development" })).toBe(false);
    expect(canDownloadUpdate({ ...status, phase: "available", release, installKind: "unsupported" })).toBe(false);
    expect(canDownloadUpdate({ ...status, phase: "error", release, installKind: "portable" })).toBe(true);
    useUpdateStore.getState().receive({ ...status, phase: "available", release, installKind: "development" });
    await useUpdateStore.getState().download();
    await useUpdateStore.getState().install();
    expect(api.updateDownload).not.toHaveBeenCalled();
    expect(api.updateInstall).not.toHaveBeenCalled();
    useUpdateStore.getState().receive({ ...status, phase: "ready", release });
    await useUpdateStore.getState().install();
    expect(api.updateInstall).toHaveBeenCalledOnce();
  });
});
