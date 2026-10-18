/**
 * 标签页 / 分屏 store。每个 Tab 持有一棵分屏树，叶子指向会话 ID；会话元数据单独存放。
 * PTY（exec）生命周期在后端：关闭 Tab 不等于结束会话，除非显式 closeSession。
 * 预览窗格也是树中的叶子（ID 以 pv: 开头），记录在 previews 中；它不会成为聚焦会话。
 */
import { create } from "zustand";
import type { SessionRecord } from "../api/types";
import { isPreview, leaf, leaves, neighbor, PREVIEW_PREFIX, remove, replaceSession, setRatio, split, type PaneNode } from "../lib/splitTree";

/** 标签页 */
export interface Tab {
  id: string;
  /** 分屏树 */
  root: PaneNode;
  /** 当前聚焦的会话（始终是终端会话，不会是预览） */
  activeSessionId: string;
}

/** 预览窗格 */
export interface PreviewRecord {
  /** 预览所属容器（标题显示用） */
  container: string;
  /** 当前地址 */
  url: string;
  /** 刷新计数：变化时重新加载 iframe */
  nonce: number;
}

interface TabStore {
  tabs: Tab[];
  activeTabId: string | null;
  /** 会话元数据 */
  sessions: Record<string, SessionRecord>;
  /** 已退出的会话 */
  exited: Record<string, number | null>;
  /** 已迁移（热切换）的会话 → 目标会话 */
  migrated: Record<string, string>;
  /** 预览窗格 */
  previews: Record<string, PreviewRecord>;

  /** 新开 Tab 放入会话 */
  openTab: (rec: SessionRecord) => void;
  /** 在当前聚焦会话处分屏 */
  splitActive: (rec: SessionRecord, direction: "row" | "column") => void;
  /** 移除会话（从所在 Tab 的树中删除；树空则删 Tab） */
  removeSession: (sessionId: string) => void;
  /** 原位替换会话（热切换） */
  replace: (from: string, to: SessionRecord) => void;
  /** 聚焦会话 */
  focus: (sessionId: string) => void;
  /** 焦点在分屏间移动 */
  focusNeighbor: (delta: 1 | -1) => void;
  /** 切换 Tab */
  activateTab: (tabId: string) => void;
  /** 相对切换 Tab */
  cycleTab: (delta: 1 | -1) => void;
  /** 设置分屏比例 */
  resizeSplit: (tabId: string, splitId: string, ratio: number) => void;
  /** 更新会话元数据 */
  upsertSession: (rec: SessionRecord) => void;
  /** 标记会话退出 */
  markExited: (sessionId: string, code: number | null) => void;
  /** 在当前 Tab 打开预览（同容器已有预览时复用）；返回预览 ID，没有 Tab 时返回 null */
  openPreview: (container: string, url: string) => string | null;
  /** 刷新预览 */
  reloadPreview: (id: string) => void;
  /** 预览跳转到新地址 */
  navigatePreview: (id: string, url: string) => void;
  /** 关闭预览 */
  closePreview: (id: string) => void;
}

let tabSeq = 0;
let previewSeq = 0;

/**
 * 生成 Tab ID。
 * @returns ID
 */
function tabId(): string {
  tabSeq += 1;
  return `t${Date.now().toString(36)}${tabSeq}`;
}

export const useTabStore = create<TabStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  sessions: {},
  exited: {},
  migrated: {},
  previews: {},

  openTab: (rec) =>
    set((s) => {
      const tab: Tab = { id: tabId(), root: leaf(rec.id), activeSessionId: rec.id };
      return { tabs: [...s.tabs, tab], activeTabId: tab.id, sessions: { ...s.sessions, [rec.id]: rec } };
    }),

  splitActive: (rec, direction) =>
    set((s) => {
      const active = s.tabs.find((t) => t.id === s.activeTabId);
      if (!active) {
        const tab: Tab = { id: tabId(), root: leaf(rec.id), activeSessionId: rec.id };
        return { tabs: [...s.tabs, tab], activeTabId: tab.id, sessions: { ...s.sessions, [rec.id]: rec } };
      }
      const tabs = s.tabs.map((t) =>
        t.id === active.id ? { ...t, root: split(t.root, t.activeSessionId, rec.id, direction), activeSessionId: rec.id } : t,
      );
      return { tabs, sessions: { ...s.sessions, [rec.id]: rec } };
    }),

  removeSession: (sessionId) =>
    set((s) => {
      const tabs: Tab[] = [];
      const previews = { ...s.previews };
      delete previews[sessionId];
      for (const t of s.tabs) {
        const root = remove(t.root, sessionId);
        const ids = root ? leaves(root).map((l) => l.sessionId) : [];
        const terminals = ids.filter((id) => !isPreview(id));
        // 没有终端的 Tab 一并关闭（预览不能单独存在：它不能成为聚焦会话）
        if (root === null || terminals.length === 0) {
          for (const id of ids) delete previews[id];
          continue;
        }
        tabs.push({ ...t, root, activeSessionId: terminals.includes(t.activeSessionId) ? t.activeSessionId : terminals[0] });
      }
      const activeTabId = tabs.some((t) => t.id === s.activeTabId)
        ? s.activeTabId
        : (tabs[Math.max(0, s.tabs.findIndex((t) => t.id === s.activeTabId) - 1)]?.id ?? null);
      const sessions = { ...s.sessions };
      delete sessions[sessionId];
      return { tabs, activeTabId, sessions, previews };
    }),

  replace: (from, to) =>
    set((s) => {
      const sessions = { ...s.sessions, [to.id]: to };
      delete sessions[from];
      return {
        tabs: s.tabs.map((t) => ({
          ...t,
          root: replaceSession(t.root, from, to.id),
          activeSessionId: t.activeSessionId === from ? to.id : t.activeSessionId,
        })),
        sessions,
        migrated: { ...s.migrated, [from]: to.id },
      };
    }),

  focus: (sessionId) =>
    set((s) => {
      const tab = s.tabs.find((t) => leaves(t.root).some((l) => l.sessionId === sessionId));
      if (!tab) return s;
      return {
        activeTabId: tab.id,
        tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, activeSessionId: sessionId } : t)),
      };
    }),

  focusNeighbor: (delta) => {
    const s = get();
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    if (tab) get().focus(neighbor(tab.root, tab.activeSessionId, delta));
  },

  activateTab: (id) => set({ activeTabId: id }),

  cycleTab: (delta) =>
    set((s) => {
      if (s.tabs.length === 0) return s;
      const i = s.tabs.findIndex((t) => t.id === s.activeTabId);
      return { activeTabId: s.tabs[(i + delta + s.tabs.length) % s.tabs.length].id };
    }),

  resizeSplit: (tid, splitId, ratio) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tid ? { ...t, root: setRatio(t.root, splitId, ratio) } : t)) })),

  upsertSession: (rec) => set((s) => ({ sessions: { ...s.sessions, [rec.id]: rec } })),

  markExited: (sessionId, code) => set((s) => ({ exited: { ...s.exited, [sessionId]: code } })),

  openPreview: (container, url) => {
    const s = get();
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    if (!tab) return null;
    const existing = leaves(tab.root)
      .map((l) => l.sessionId)
      .find((id) => isPreview(id) && s.previews[id]?.container === container);
    if (existing) {
      get().navigatePreview(existing, url);
      return existing;
    }
    previewSeq += 1;
    const id = `${PREVIEW_PREFIX}${previewSeq}`;
    set({
      tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, root: split(t.root, t.activeSessionId, id, "row") } : t)),
      previews: { ...s.previews, [id]: { container, url, nonce: 0 } },
    });
    return id;
  },

  reloadPreview: (id) =>
    set((s) => (s.previews[id] ? { previews: { ...s.previews, [id]: { ...s.previews[id], nonce: s.previews[id].nonce + 1 } } } : s)),

  navigatePreview: (id, url) =>
    set((s) => (s.previews[id] ? { previews: { ...s.previews, [id]: { ...s.previews[id], url, nonce: s.previews[id].nonce + 1 } } } : s)),

  closePreview: (id) => get().removeSession(id),
}));

/**
 * 当前聚焦的会话。
 * @returns 会话元数据或 undefined
 */
export function useActiveSession(): SessionRecord | undefined {
  return useTabStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab ? s.sessions[tab.activeSessionId] : undefined;
  });
}
