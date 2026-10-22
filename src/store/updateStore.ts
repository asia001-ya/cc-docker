import { create } from "zustand";
import { version } from "../../package.json";
import type { UpdateStatus } from "../api/types";
import { errorText, isTauri, onUpdateState, updateCheck, updateDownload, updateInstall, updateStatus } from "../api/commands";
import { useUiStore } from "./uiStore";

type UpdateAction = "check" | "download" | "install";

interface UpdateStore {
  status: UpdateStatus | null;
  pending: UpdateAction | null;
  commandError: string | null;
  revision: number;
  notifiedVersion: string | null;
  receive: (status: UpdateStatus) => void;
  refresh: () => Promise<void>;
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
}

export const useUpdateStore = create<UpdateStore>((set, get) => {
  const run = async (action: UpdateAction) => {
    const before = get();
    if (!isTauri() || before.pending || isUpdateBusy(before.status)) return;
    if (action === "install" && (before.status?.phase !== "ready"
      || (before.status.installKind !== "installer" && before.status.installKind !== "portable"))) return;
    if (action === "download" && !canDownloadUpdate(before.status)) return;
    const revision = before.revision;
    set({ pending: action, commandError: null });
    try {
      if (action === "install") await updateInstall();
      else {
        const status = await (action === "check" ? updateCheck() : updateDownload());
        // 已收到事件时以事件为准，避免较慢的命令响应覆盖下载进度。
        if (get().revision === revision) get().receive(status);
      }
    } catch (error) {
      set({ commandError: errorText(error) });
    } finally {
      set({ pending: null });
    }
  };
  return {
    status: null,
    pending: null,
    commandError: null,
    revision: 0,
    notifiedVersion: null,
    receive: (status) => {
      const previous = get();
      const readyVersion = status.phase === "ready" ? status.release?.version : null;
      const notify = readyVersion && readyVersion !== previous.notifiedVersion;
      set({
        status,
        revision: previous.revision + 1,
        commandError: null,
        ...(notify ? { notifiedVersion: readyVersion } : {}),
      });
      if (notify) useUiStore.getState().toast("success", `v${readyVersion} 更新已下载，可在「设置 → 应用更新」中更新并重启`);
    },
    refresh: async () => {
      const revision = get().revision;
      try {
        const status = await updateStatus();
        if (get().revision === revision) get().receive(status);
      } catch (error) {
        if (get().revision === revision) set({ commandError: errorText(error) });
      }
    },
    check: () => run("check"),
    download: () => run("download"),
    install: () => run("install"),
  };
});

export function isUpdateBusy(status: UpdateStatus | null): boolean {
  return status?.phase === "checking" || status?.phase === "downloading" || status?.phase === "installing";
}

export function canDownloadUpdate(status: UpdateStatus | null): boolean {
  return Boolean(status?.release && (status.installKind === "installer" || status.installKind === "portable")
    && (status.phase === "available" || status.phase === "error"));
}

/** 先订阅再获取快照。清理期间完成的订阅也会被取消。 */
export function connectUpdates(): () => void {
  if (!isTauri()) {
    useUpdateStore.getState().receive({ currentVersion: version, phase: "idle", release: null, downloadedBytes: 0,
      totalBytes: null, checkedAt: null, error: null, installKind: "development" });
    return () => undefined;
  }
  let active = true;
  let unlisten: (() => void) | undefined;
  void onUpdateState((status) => {
    if (active) useUpdateStore.getState().receive(status);
  }).then((unsubscribe) => {
    if (!active) return unsubscribe();
    unlisten = unsubscribe;
    return useUpdateStore.getState().refresh();
  }).catch((error) => {
    if (active) useUpdateStore.setState({ commandError: errorText(error) });
  });
  return () => {
    active = false;
    unlisten?.();
  };
}
