/**
 * UI store：侧栏、弹框、浮层、通知、设置。
 */
import { create } from "zustand";
import type { ExhaustedPayload, Settings, TerminalSettings, WallpaperSettings } from "../api/types";
import { DEFAULT_SETTINGS } from "../lib/demo";

/** 业务弹框类型 */
export type ModalKind =
  | { kind: "createContainer" }
  | { kind: "auth"; container: string }
  | { kind: "session"; mode: "new" | "rename"; container?: string; sessionId?: string; split?: "row" | "column" }
  | { kind: "sessionList" }
  | { kind: "usage"; container?: string }
  | { kind: "quotaSwitch"; source: string; sessionId: string | null; payload: ExhaustedPayload | null }
  | { kind: "sharedVolume" }
  | { kind: "danger"; container: string; action: "stop" | "remove" }
  | { kind: "proxy"; container: string }
  | { kind: "hostConfig"; container: string }
  | { kind: "gitSharing"; container: string }
  | { kind: "settings"; tab?: "appearance" | "wallpaper" | "docker" | "quota" | "providers" | "proxy" | "shortcuts" };

/** 通知 */
export interface Toast {
  id: number;
  tone: "info" | "success" | "warning" | "error";
  text: string;
}

interface UiStore {
  sidebarOpen: boolean;
  sidebarPinned: boolean;
  modal: ModalKind | null;
  quotaFlyout: boolean;
  searchOpen: boolean;
  toasts: Toast[];
  settings: Settings;
  wallpaperPreview: WallpaperSettings | null;
  terminalPreview: TerminalSettings | null;
  wallpaperReady: boolean;
  setWallpaperPreview: (value: WallpaperSettings | null) => void;
  setWallpaperReady: (ready: boolean) => void;
  /** 用户选择"稍后"后，该容器本轮不再自动弹出切换框 */
  snoozed: Record<string, boolean>;

  toggleSidebar: () => void;
  setSidebar: (open: boolean) => void;
  togglePin: () => void;
  openModal: (m: ModalKind) => void;
  closeModal: () => void;
  setQuotaFlyout: (v: boolean) => void;
  setSearch: (v: boolean) => void;
  toast: (tone: Toast["tone"], text: string) => void;
  dismiss: (id: number) => void;
  setSettings: (s: Settings) => void;
  snooze: (container: string, v: boolean) => void;
}

let toastSeq = 0;

export const useUiStore = create<UiStore>((set) => ({
  sidebarOpen: false,
  sidebarPinned: false,
  modal: null,
  quotaFlyout: false,
  searchOpen: false,
  toasts: [],
  settings: DEFAULT_SETTINGS,
  wallpaperPreview: null,
  terminalPreview: null,
  wallpaperReady: false,
  setWallpaperPreview: (wallpaperPreview) => set({ wallpaperPreview }),
  setWallpaperReady: (wallpaperReady) => set({ wallpaperReady }),
  snoozed: {},

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebar: (sidebarOpen) => set({ sidebarOpen }),
  togglePin: () => set((s) => ({ sidebarPinned: !s.sidebarPinned, sidebarOpen: true })),
  openModal: (modal) => set((s) => ({ modal, quotaFlyout: false, sidebarOpen: s.sidebarPinned ? s.sidebarOpen : false })),
  closeModal: () => set({ modal: null }),
  setQuotaFlyout: (quotaFlyout) => set({ quotaFlyout }),
  setSearch: (searchOpen) => set({ searchOpen }),
  toast: (tone, text) => {
    toastSeq += 1;
    const id = toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, tone, text }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === "error" ? 8000 : 4500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setSettings: (settings) => set({ settings: { ...settings, wallpaper: { ...DEFAULT_SETTINGS.wallpaper, ...settings.wallpaper } } }),
  snooze: (container, v) => set((s) => ({ snoozed: { ...s.snoozed, [container]: v } })),
}));
