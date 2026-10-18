/**
 * 标题栏 + 标签条（合并为 32px 一行）：侧栏开关、当前容器、会话 Tab、新建 / 分屏、窗口控制。
 * 空白区域可拖动窗口（data-tauri-drag-region）。
 */
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../../api/commands";
import { useTabStore, type Tab } from "../../store/tabStore";
import { useUiStore } from "../../store/uiStore";
import { useEntry } from "../../store/fleetStore";
import { leaves } from "../../lib/splitTree";
import { Icon, IconButton, StatusDot } from "../ui/controls";

interface Props {
  /** 新建会话（在当前容器） */
  onNewSession: () => void;
  /** 分屏 */
  onSplit: (direction: "row" | "column") => void;
  /** 关闭 Tab（关闭其中全部会话） */
  onCloseTab: (tab: Tab) => void;
}

/**
 * 窗口控制按钮（最小化 / 最大化 / 关闭）。
 * @returns JSX
 */
function CaptionButtons() {
  const [max, setMax] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    const w = getCurrentWindow();
    void w.isMaximized().then(setMax);
    const un = w.onResized(() => void w.isMaximized().then(setMax));
    return () => {
      void un.then((f) => f());
    };
  }, []);
  const w = isTauri() ? getCurrentWindow() : null;
  const cls = "flex h-8 w-[46px] items-center justify-center text-on-surface-variant transition-colors hover:bg-white/[0.08] hover:text-on-surface";
  return (
    <div className="flex h-full items-stretch">
      <button type="button" title="最小化" className={cls} onClick={() => void w?.minimize()}>
        <Icon name="remove" size={16} />
      </button>
      <button type="button" title={max ? "向下还原" : "最大化"} className={cls} onClick={() => void w?.toggleMaximize()}>
        <Icon name={max ? "filter_none" : "crop_square"} size={max ? 13 : 15} />
      </button>
      <button type="button" title="关闭" className={`${cls} hover:!bg-caption-close hover:!text-white`} onClick={() => void w?.close()}>
        <Icon name="close" size={17} />
      </button>
    </div>
  );
}

/**
 * 单个标签。
 * @param props tab、active、onClose
 * @returns JSX
 */
function TabItem({ tab, active, onClose }: { tab: Tab; active: boolean; onClose: () => void }) {
  const sessions = useTabStore((s) => s.sessions);
  const activate = useTabStore((s) => s.activateTab);
  const rec = sessions[tab.activeSessionId];
  const count = leaves(tab.root).length;
  const entry = useEntry(rec?.container);
  return (
    <div
      role="tab"
      aria-selected={active}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        } else activate(tab.id);
      }}
      title={rec ? `${rec.title} · ${rec.container} · ${rec.cwd}` : ""}
      className={`group relative flex h-[28px] min-w-[120px] max-w-[240px] cursor-default items-center gap-1.5 self-end rounded-t-lg px-2.5 font-ui text-body-sm ${
        active ? "wallpaper-tab-active border border-b-0 border-white/[0.08] bg-term-bg text-on-surface" : "text-[#8A8886] hover:bg-white/[0.04] hover:text-on-surface"
      }`}
    >
      {entry && <StatusDot health={entry.health} size={6} />}
      <span className="truncate">
        <span className="text-on-surface-variant">[{rec?.container ?? "?"}]</span> {rec?.title ?? "终端"}
      </span>
      {count > 1 && <span className="rounded bg-white/[0.08] px-1 font-mono text-code-sm text-on-surface-variant">{count}</span>}
      <button
        type="button"
        title="关闭标签页（关闭其中全部会话）"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={onClose}
        className={`ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-white/10 ${active ? "opacity-70" : "opacity-0 group-hover:opacity-70"}`}
      >
        <Icon name="close" size={13} />
      </button>
      {active && <span className="absolute bottom-0 left-3 right-3 h-[3px] rounded-full bg-accent" />}
    </div>
  );
}

/**
 * 标题栏组件。
 * @param props 新建 / 分屏 / 关闭 Tab 回调
 * @returns JSX
 */
export function TitleBar({ onNewSession, onSplit, onCloseTab }: Props) {
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const sessions = useTabStore((s) => s.sessions);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const openModal = useUiStore((s) => s.openModal);
  const shortcut = useUiStore((s) => (s.settings.sidebarShortcut === "ctrl+b" ? "Ctrl+B" : "Ctrl+Shift+B"));
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const container = activeTab ? sessions[activeTab.activeSessionId]?.container : undefined;
  const entry = useEntry(container);

  return (
    <header data-tauri-drag-region className="wallpaper-panel flex h-8 shrink-0 select-none items-stretch bg-mica-alt">
      <div className="flex items-center gap-1 pl-1.5 pr-2">
        <IconButton icon={sidebarOpen ? "left_panel_close" : "left_panel_open"} title={`容器侧栏（${shortcut}）`} active={sidebarOpen} onClick={toggleSidebar} />
        <button
          type="button"
          onClick={toggleSidebar}
          title="当前容器（点击展开侧栏切换）"
          className="flex h-6 items-center gap-1.5 rounded px-1.5 font-ui text-label-md text-on-surface hover:bg-white/[0.06]"
        >
          {entry ? <StatusDot health={entry.health} size={7} /> : <Icon name="deployed_code" size={14} className="text-outline" />}
          <span className="max-w-[140px] truncate">{container ?? "未选择容器"}</span>
          <Icon name="expand_more" size={14} className="text-outline" />
        </button>
      </div>

      <nav role="tablist" data-tauri-drag-region className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto pt-1 [scrollbar-width:none]">
        {tabs.map((t) => (
          <TabItem key={t.id} tab={t} active={t.id === activeTabId} onClose={() => onCloseTab(t)} />
        ))}
        <div className="flex items-center gap-0.5 pl-1">
          <IconButton icon="add" title="新建会话（Ctrl+Shift+T）" onClick={onNewSession} />
          <IconButton icon="splitscreen_right" title="左右分屏（Ctrl+Shift+\）" onClick={() => onSplit("row")} disabled={!activeTab} />
          <IconButton icon="splitscreen_bottom" title="上下分屏（Ctrl+Shift+-）" onClick={() => onSplit("column")} disabled={!activeTab} />
        </div>
        <div data-tauri-drag-region className="min-w-[24px] flex-1" />
      </nav>

      <div className="flex items-center gap-0.5 pr-1">
        <IconButton icon="add_box" title="新建容器（Ctrl+Shift+N）" onClick={() => openModal({ kind: "createContainer" })} />
        <IconButton icon="settings" title="设置（Ctrl+,）" onClick={() => openModal({ kind: "settings" })} />
      </div>
      <CaptionButtons />
    </header>
  );
}
