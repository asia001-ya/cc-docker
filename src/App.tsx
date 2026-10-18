/**
 * 应用根组件：组装标题栏 / 终端工作区 / 状态栏 / 侧栏 / 浮层 / 弹框，并编排
 * 会话打开与恢复、分屏、热切换、快捷键、后端事件订阅。
 *
 * 布局约束（终端至上）：标题栏 32px + 状态栏 24px，侧栏默认为浮层，其余全部给终端。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OpenRequest, SessionRecord } from "./api/types";
import {
  errorText,
  fleetGet,
  fleetRefresh,
  imageStatus,
  isTauri,
  onExhausted,
  onProxyAlert,
  onFleet,
  onSessionExit,
  settingsGet,
  settingsSet,
  switchCandidates,
  switchExecute,
  termClose,
  termOpen,
  termRecords,
} from "./api/commands";
import { useFleetStore } from "./store/fleetStore";
import { useTabStore, type Tab } from "./store/tabStore";
import { useUiStore } from "./store/uiStore";
import { DEMO_FLEET, DEMO_SESSIONS } from "./lib/demo";
import { buildShortcuts, isPlainPaste, matchShortcut, type Action } from "./lib/shortcuts";
import { isPreview, leaves } from "./lib/splitTree";
import { buildSessionCatalog, findOpenSessionForHistory, type SessionCatalogItem } from "./lib/sessionCatalog";
import { TitleBar } from "./components/shell/TitleBar";
import { StatusBar } from "./components/shell/StatusBar";
import { SidebarDrawer } from "./components/shell/SidebarDrawer";
import { QuotaFlyout } from "./components/shell/QuotaFlyout";
import { SearchBar, Toasts } from "./components/shell/Toasts";
import { SplitView } from "./components/terminal/SplitView";
import { ActiveOutputReader } from "./components/terminal/OutputReader";
import { applySettings, dispose, get, pasteClipboard, setKeyHandler, setLinkHandler, sizeOf } from "./components/terminal/xtermPool";
import { handleTerminalLink } from "./components/terminal/previewActions";
import { CreateContainerModal } from "./components/modals/CreateContainerModal";
import { AuthModal } from "./components/modals/AuthModal";
import { SessionModal, type NewSessionSpec } from "./components/modals/SessionModal";
import { SessionListModal } from "./components/modals/SessionListModal";
import { UsageModal } from "./components/modals/UsageModal";
import { HostConfigModal } from "./components/modals/HostConfigModal";
import { GitSharingModal } from "./components/modals/GitSharingModal";
import { QuotaSwitchModal } from "./components/modals/QuotaSwitchModal";
import { SharedVolumeModal } from "./components/modals/SharedVolumeModal";
import { DangerZoneModal } from "./components/modals/DangerZoneModal";
import { SettingsModal } from "./components/modals/SettingsModal";
import { ProxyModal, PROXY_STATE_META } from "./components/modals/ProxyModal";
import { ImageBuildPanel } from "./components/shell/ImageBuildPanel";
import { WallpaperLayer, wallpaperCssVars } from "./components/shell/WallpaperLayer";
import { useWallpaperSource } from "./lib/wallpaper";
import { themeById } from "./lib/themes";
import { Button, Icon, Kbd } from "./components/ui/controls";

/**
 * 空状态：没有打开的会话时引导用户。默认镜像不存在时，构建镜像是唯一的下一步（不提供新建容器入口）。
 * @param props 新建会话 / 新建容器回调
 * @returns JSX
 */
function EmptyState({ onNewSession }: { onNewSession: () => void }) {
  const openModal = useUiStore((s) => s.openModal);
  const defaultImage = useUiStore((s) => s.settings.docker.defaultImage);
  const fleet = useFleetStore((s) => s.fleet);
  const running = fleet.entries.filter((e) => e.container.running).length;
  const [imageExists, setImageExists] = useState<boolean | null>(null);
  const checkImage = useCallback(() => {
    imageStatus().then((s) => setImageExists(s.exists)).catch(() => setImageExists(null));
  }, []);
  useEffect(() => {
    if (!isTauri() || !fleet.engineOk) return setImageExists(null);
    checkImage();
  }, [fleet.engineOk, defaultImage, checkImage]);
  // 演示模式视为已就绪；检测完成前不显示新建入口，避免闪现后又被引导页替换
  const imageKnown = !isTauri() || !fleet.engineOk || imageExists !== null;
  const needImage = isTauri() && fleet.engineOk && imageExists === false;

  if (needImage) {
    return (
      <div className="terminal-surface flex h-full flex-col items-center justify-center gap-4 bg-term-bg px-6 font-ui text-on-surface-variant">
        <Icon name="deployed_code" size={48} className="text-accent" />
        <div className="text-headline-md text-on-surface">第一步：构建标准镜像</div>
        <div className="max-w-lg text-center text-body-md">
          本地还没有默认镜像，构建完成后才能新建容器。镜像包含 Claude Code、tmux、Mihomo 与 Xray 内核，
          构建需要联网下载基础镜像与依赖，耗时取决于网络。
        </div>
        <div className="w-full max-w-2xl">
          <ImageBuildPanel onReady={checkImage} />
        </div>
        <div className="flex gap-2">
          {running > 0 && (
            <Button icon="add" onClick={onNewSession}>
              新建会话 <Kbd>Ctrl+Shift+T</Kbd>
            </Button>
          )}
          <Button variant="subtle" icon="settings" onClick={() => openModal({ kind: "settings", tab: "docker" })}>
            Docker 设置
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-surface flex h-full flex-col items-center justify-center gap-4 bg-term-bg font-ui text-on-surface-variant">
      <Icon name="terminal" size={48} className="text-outline" />
      <div className="text-headline-md text-on-surface">{fleet.engineOk ? (running ? "选择容器开始一个终端会话" : "还没有运行中的容器") : "Docker 引擎未连接"}</div>
      <div className="max-w-md text-center text-body-md">
        {fleet.engineOk
          ? running
            ? "每个会话运行在容器的 tmux 中，关闭应用后继续运行，下次启动自动重新附着。"
            : "新建一个容器开始使用。"
          : (fleet.engineError ?? "请安装并启动 Docker Desktop（WSL2 后端）。")}
      </div>
      <div className="flex gap-2">
        {running > 0 && (
          <Button variant="primary" icon="add" onClick={onNewSession}>
            新建会话 <Kbd>Ctrl+Shift+T</Kbd>
          </Button>
        )}
        {imageKnown && (
          <Button icon="add_box" onClick={() => openModal({ kind: "createContainer" })}>
            新建容器
          </Button>
        )}
        <Button icon="settings" onClick={() => openModal({ kind: "settings", tab: fleet.engineOk ? "appearance" : "docker" })}>
          设置
        </Button>
      </div>
    </div>
  );
}

/**
 * 根组件。
 * @returns JSX
 */
export default function App() {
  const wallpaper = useUiStore((s) => s.wallpaperPreview ?? s.settings.wallpaper);
  const terminalAppearance = useUiStore((s) => s.terminalPreview ?? s.settings.terminal);
  const wallpaperSource = useWallpaperSource(wallpaper.asset);
  const [loadedWallpaper, setLoadedWallpaper] = useState<string | null>(null);
  const [failedWallpaper, setFailedWallpaper] = useState<string | null>(null);
  const wallpaperEnabled = !!wallpaperSource.url && loadedWallpaper === wallpaperSource.url && failedWallpaper !== wallpaperSource.url;
  useEffect(() => {
    useUiStore.getState().setWallpaperReady(wallpaperEnabled);
    applySettings(terminalAppearance);
  }, [wallpaperEnabled, terminalAppearance, wallpaper.asset?.fileName]);
  useEffect(() => {
    if (wallpaperSource.error) useUiStore.getState().toast("warning", `壁纸未加载，已使用原有背景：${wallpaperSource.error}`);
  }, [wallpaperSource.error]);
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const sessions = useTabStore((s) => s.sessions);
  const exited = useTabStore((s) => s.exited);
  const entries = useFleetStore((s) => s.fleet.entries);
  const modal = useUiStore((s) => s.modal);
  const sidebarPinned = useUiStore((s) => s.sidebarPinned);
  const restored = useRef(false);
  const catalogActionPending = useRef(false);
  const sessionCatalog = useMemo(() => modal?.kind === "sessionList" ? buildSessionCatalog({
    entries, sessions, exited,
    openSessionIds: tabs.flatMap((tab) => leaves(tab.root).map((l) => l.sessionId).filter((id) => !isPreview(id))),
    activeSessionId: tabs.find((tab) => tab.id === activeTabId)?.activeSessionId ?? null,
  }) : [], [modal?.kind, entries, sessions, exited, tabs, activeTabId]);

  // ---------- 会话编排 ----------

  /**
   * 打开会话并放入 Tab 或分屏。
   * @param spec 会话参数
   * @param placement 放置方式：新 Tab / 分屏 / 不放置（由调用方处理）
   * @returns 会话元数据
   */
  const openSession = useCallback(
    async (spec: Omit<OpenRequest, "cols" | "rows">, placement: "tab" | "row" | "column" | "none" = "tab"): Promise<SessionRecord> => {
      const st = useTabStore.getState();
      const activeTab = st.tabs.find((t) => t.id === st.activeTabId);
      const { cols, rows } = sizeOf(activeTab?.activeSessionId);
      const rec: SessionRecord = isTauri()
        ? await termOpen({ ...spec, cols, rows })
        : { id: Math.random().toString(16).slice(2, 10), container: spec.container, title: spec.title, cwd: spec.cwd, mode: spec.mode, args: spec.args, env: spec.env, tmux: spec.tmux, createdAt: Date.now() / 1000 };
      if (placement === "tab") st.openTab(rec);
      else if (placement !== "none") st.splitActive(rec, placement);
      return rec;
    },
    [],
  );

  /**
   * 弹框回调：按规格新建会话。
   * @param spec 新建会话规格
   * @returns Promise
   */
  const createFromModal = useCallback(
    async (spec: NewSessionSpec) => {
      await openSession({ container: spec.container, title: spec.title, cwd: spec.cwd, mode: spec.mode, args: spec.args, env: spec.env, tmux: spec.tmux }, spec.split ?? "tab");
    },
    [openSession],
  );

  /** 列表中的已打开项只切换焦点；历史项以原容器、原目录创建新的终端。 */
  const activateCatalogItem = useCallback(async (item: SessionCatalogItem) => {
    if (catalogActionPending.current) return;
    catalogActionPending.current = true;
    try {
      const st = useTabStore.getState();
      const currentEntries = useFleetStore.getState().fleet.entries;
      const openSessionIds = st.tabs.flatMap((tab) => leaves(tab.root).map((l) => l.sessionId).filter((id) => !isPreview(id)));
      let sessionId: string;
      if (item.kind === "open") {
        if (!item.openSessionId || !openSessionIds.includes(item.openSessionId) || !st.sessions[item.openSessionId]) {
          throw new Error("该终端已关闭，请在列表中重新选择会话。");
        }
        sessionId = item.openSessionId;
      } else {
        if (!item.claudeSessionId) throw new Error("缺少 Claude 会话记录，无法恢复。");
        const existing = findOpenSessionForHistory(item.container, item.claudeSessionId, st.sessions, currentEntries, openSessionIds, st.exited);
        if (existing) {
          sessionId = existing;
        } else {
          const latest = buildSessionCatalog({ entries: currentEntries, sessions: st.sessions, openSessionIds, exited: st.exited, activeSessionId: null })
            .find((row) => row.key === item.key);
          if (!latest) throw new Error("该会话已不在历史列表中，请刷新后重试。");
          if (!latest.containerRunning) throw new Error(`请先启动容器 ${latest.container}，再恢复会话。`);
          if (!latest.cwd) throw new Error("历史未记录工作目录，请通过新建会话中的恢复入口指定目录。");
          const rec = await openSession({
            container: latest.container, title: latest.title, cwd: latest.cwd,
            mode: "claude", args: ["--resume", item.claudeSessionId], env: [], tmux: true,
          }, "tab");
          sessionId = rec.id;
        }
      }
      useTabStore.getState().focus(sessionId);
      useUiStore.getState().closeModal();
      requestAnimationFrame(() => {
        if (!useUiStore.getState().modal) get(sessionId)?.term.focus();
      });
    } finally {
      catalogActionPending.current = false;
    }
  }, [openSession]);

  /** 等待采集结果推送到 store 后再结束刷新状态。 */
  const refreshSessionList = useCallback(async () => {
    if (!isTauri()) return;
    await new Promise<void>((resolve, reject) => {
      const previous = useFleetStore.getState().fleet;
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        unsubscribe();
        if (error) reject(error);
        else resolve();
      };
      const unsubscribe = useFleetStore.subscribe((state) => {
        if (state.fleet !== previous) finish();
      });
      const timer = setTimeout(() => finish(new Error("刷新超时，请稍后重试。")), 20_000);
      void fleetRefresh().catch(finish);
    });
  }, []);

  /**
   * 关闭会话：结束容器内 tmux 会话、销毁 xterm、从布局移除。
   * @param id 会话 ID
   * @returns Promise
   */
  const closeSession = useCallback(async (id: string) => {
    try {
      if (isTauri()) await termClose(id);
    } catch (e) {
      useUiStore.getState().toast("warning", `关闭会话时出错：${errorText(e)}`);
    }
    dispose(id);
    useTabStore.getState().removeSession(id);
    // 关闭未聚焦的嵌套窗格时，剩余终端可能不会重新挂载；布局更新后主动归还键盘焦点。
    requestAnimationFrame(() => {
      if (useUiStore.getState().modal) return;
      const st = useTabStore.getState();
      const activeTab = st.tabs.find((t) => t.id === st.activeTabId);
      if (activeTab) get(activeTab.activeSessionId)?.term.focus();
    });
  }, []);

  /**
   * 关闭 Tab（逐个关闭其中终端会话；预览窗格随最后一个终端一并移除）。
   * @param tab 标签页
   * @returns 无
   */
  const closeTab = useCallback(
    (tab: Tab) => {
      for (const l of leaves(tab.root)) if (!isPreview(l.sessionId)) void closeSession(l.sessionId);
    },
    [closeSession],
  );

  /**
   * 打开"新建会话"弹框（默认当前容器）。
   * @param split 分屏方向
   * @returns 无
   */
  const newSession = useCallback((split?: "row" | "column") => {
    const st = useTabStore.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    const container = tab ? st.sessions[tab.activeSessionId]?.container : undefined;
    useUiStore.getState().openModal({ kind: "session", mode: "new", container, split });
  }, []);

  /**
   * 在指定容器中快速新开 claude 会话（侧栏点击）。
   * @param container 容器名
   * @returns 无
   */
  const quickOpen = useCallback(
    (container: string) => {
      const entry = useFleetStore.getState().fleet.entries.find((e) => e.container.name === container);
      const cwd = entry?.container.mounts.find((m) => m.kind === "bind" && m.destination.startsWith("/workspace"))?.destination ?? "/workspace";
      const n = Object.values(useTabStore.getState().sessions).filter((s) => s.container === container).length + 1;
      openSession({ container, title: `会话 #${n}`, cwd, mode: "claude", args: [], env: [], tmux: true })
        .then(() => {
          if (!useUiStore.getState().sidebarPinned) useUiStore.getState().setSidebar(false);
        })
        .catch((e) => useUiStore.getState().toast("error", `打开会话失败：${errorText(e)}`));
    },
    [openSession],
  );

  /**
   * 执行热切换：后端完成"源退出 → 目标 --resume"，前端原位替换窗格。
   * @param sessionId 源会话
   * @param target 目标容器
   * @returns Promise
   */
  const doSwitch = useCallback(async (sessionId: string, target: string) => {
    const ui = useUiStore.getState();
    const st = useTabStore.getState();
    if (!isTauri()) {
      const src = st.sessions[sessionId];
      const rec: SessionRecord = { ...src, id: Math.random().toString(16).slice(2, 10), container: target, title: `${src.title}（自 ${src.container} 切换）` };
      st.replace(sessionId, rec);
      dispose(sessionId);
      ui.toast("success", `演示：已切换至 ${target}`);
      return;
    }
    const { cols, rows } = sizeOf(sessionId);
    const res = await switchExecute(sessionId, target, cols, rows);
    st.replace(sessionId, res.session);
    dispose(sessionId);
    ui.toast(
      res.resumed ? "success" : "warning",
      `${res.resumed ? `已切换至 ${target} 并恢复对话（${res.resumed.slice(0, 8)}）` : `已切换至 ${target}（未能继承对话）`}\n${res.notes.join("\n")}`,
    );
  }, []);

  /**
   * 打开热切换弹框（智能切换入口）。
   * @param target 指定目标；null 表示弹框推荐
   * @returns 无
   */
  const smartSwitch = useCallback(
    (target: string | null) => {
      const st = useTabStore.getState();
      const tab = st.tabs.find((t) => t.id === st.activeTabId);
      const rec = tab ? st.sessions[tab.activeSessionId] : undefined;
      const ui = useUiStore.getState();
      ui.setQuotaFlyout(false);
      if (!rec) return ui.toast("info", "请先打开一个会话");
      if (target) {
        doSwitch(rec.id, target).catch((e) => ui.toast("error", `切换失败：${errorText(e)}`));
        return;
      }
      ui.openModal({ kind: "quotaSwitch", source: rec.container, sessionId: rec.id, payload: null });
    },
    [doSwitch],
  );

  // ---------- 快捷键 ----------

  const runAction = useCallback(
    (a: Action) => {
      const ui = useUiStore.getState();
      const st = useTabStore.getState();
      const tab = st.tabs.find((t) => t.id === st.activeTabId);
      const sid = tab?.activeSessionId;
      switch (a) {
        case "toggleSidebar":
          return ui.toggleSidebar();
        case "newSession":
          return newSession();
        case "closeSession":
          return sid && void closeSession(sid);
        case "splitRight":
          return newSession("row");
        case "splitDown":
          return newSession("column");
        case "nextTab":
          return st.cycleTab(1);
        case "prevTab":
          return st.cycleTab(-1);
        case "focusNext":
          return st.focusNeighbor(1);
        case "focusPrev":
          return st.focusNeighbor(-1);
        case "copy": {
          const sel = sid ? get(sid)?.term.getSelection() : "";
          if (sel) void navigator.clipboard.writeText(sel);
          return;
        }
        case "paste":
          if (sid) void pasteClipboard(sid);
          return;
        case "newContainer":
          return ui.openModal({ kind: "createContainer" });
        case "settings":
          return ui.openModal({ kind: "settings" });
        case "quotaFlyout":
          return ui.setQuotaFlyout(!ui.quotaFlyout);
        case "find":
          return ui.setSearch(true);
        case "fontUp":
        case "fontDown": {
          const s = ui.settings;
          const size = Math.min(28, Math.max(9, s.terminal.fontSize + (a === "fontUp" ? 1 : -1)));
          const next = { ...s, terminal: { ...s.terminal, fontSize: size } };
          ui.setSettings(next);
          applySettings(next.terminal);
          if (isTauri()) void settingsSet(next).catch(() => undefined);
          return;
        }
      }
    },
    [closeSession, newSession],
  );

  useEffect(() => {
    // 终端链接：容器内 localhost 链接按端口映射在预览窗格打开，其余交给系统浏览器
    setLinkHandler(handleTerminalLink);
    // 终端内：xterm 的 customKeyEventHandler；返回 false 表示被应用消费
    setKeyHandler((e) => {
      if (useUiStore.getState().modal) return true;
      const a = matchShortcut(buildShortcuts(useUiStore.getState().settings.sidebarShortcut), e);
      if (!a) {
        // Ctrl+V：不让 xterm 发 ^V，也不 preventDefault，由浏览器触发原生 paste 事件（文本走 xterm 括号粘贴，图片见 xtermPool）
        if (isPlainPaste(e)) return false;
        // Ctrl+C 有选区时复制（无选区时发送 SIGINT）
        if (e.type === "keydown" && e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "c") {
          const st = useTabStore.getState();
          const tab = st.tabs.find((t) => t.id === st.activeTabId);
          const term = tab ? get(tab.activeSessionId)?.term : undefined;
          if (term?.hasSelection()) {
            void navigator.clipboard.writeText(term.getSelection());
            term.clearSelection();
            return false;
          }
        }
        return true;
      }
      e.preventDefault();
      // 关闭会话会销毁事件源 DOM，阻止同一按键再冒泡到 window 后误关下一个会话。
      e.stopPropagation();
      runAction(a);
      return false;
    });
    // 终端外（焦点在 UI 上）
    const onKey = (e: KeyboardEvent) => {
      if (useUiStore.getState().modal) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest(".xterm")) return;
      const a = matchShortcut(buildShortcuts(useUiStore.getState().settings.sidebarShortcut), e);
      if (a && !(target && /INPUT|TEXTAREA|SELECT/.test(target.tagName) && (a === "copy" || a === "paste"))) {
        e.preventDefault();
        runAction(a);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runAction]);

  // ---------- 启动：设置、汇总、恢复会话、事件 ----------

  useEffect(() => {
    if (!isTauri()) {
      useFleetStore.getState().setDemo(import.meta.env.DEV);
      useFleetStore.getState().setFleet(DEMO_FLEET);
      if (import.meta.env.DEV && !restored.current) {
        restored.current = true;
        const st = useTabStore.getState();
        const [first, second] = DEMO_SESSIONS;
        if (first) {
          st.openTab(first);
          if (second) st.splitActive(second, "row");
          st.focus(first.id);
        }
      }
      return;
    }
    const unsubs: Promise<() => void>[] = [];
    settingsGet()
      .then((s) => {
        useUiStore.getState().setSettings(s);
        applySettings(s.terminal);
      })
      .catch(() => undefined);
    fleetGet().then((f) => useFleetStore.getState().setFleet(f)).catch(() => undefined);
    unsubs.push(onFleet((f) => useFleetStore.getState().setFleet(f)));
    unsubs.push(
      onSessionExit((p) => {
        useTabStore.getState().markExited(p.sessionId, p.code);
      }),
    );
    unsubs.push(
      onExhausted((p) => {
        const ui = useUiStore.getState();
        if (!ui.settings.quota.autoPrompt || ui.snoozed[p.container] || ui.modal) {
          ui.toast("warning", `${p.container} 额度已用尽`);
          return;
        }
        const st = useTabStore.getState();
        const tab = st.tabs.find((t) => t.id === st.activeTabId);
        const active = tab ? st.sessions[tab.activeSessionId] : undefined;
        const sid = active?.container === p.container ? active.id : (Object.values(st.sessions).find((r) => r.container === p.container)?.id ?? null);
        if (!sid) return ui.toast("warning", `${p.container} 额度已用尽（无打开的会话）`);
        // 有候选才弹框，否则提示
        switchCandidates(p.container)
          .then((c) => {
            const currentUi = useUiStore.getState();
            if (currentUi.modal) return currentUi.toast("warning", `${p.container} 额度已用尽，可稍后从底部切换`);
            if (c.length) currentUi.openModal({ kind: "quotaSwitch", source: p.container, sessionId: sid, payload: p });
            else currentUi.toast("warning", `${p.container} 额度已用尽，且没有可切换的容器`);
          })
          .catch(() => undefined);
      }),
    );

    unsubs.push(
      onProxyAlert((p) => {
        const meta = PROXY_STATE_META[p.state];
        useUiStore.getState().toast("error", `${p.container} 代理${meta?.label ?? p.state}：${meta?.desc ?? ""}${p.lastError ? `（${p.lastError}）` : ""}`);
      }),
    );

    // 恢复上次的会话：按容器分组，每个容器一个 Tab，组内分屏
    if (!restored.current) {
      restored.current = true;
      termRecords()
        .then(async (records) => {
          for (const r of records) {
            try {
              const rec = await openSession({ id: r.id, container: r.container, title: r.title, cwd: r.cwd, mode: r.mode, args: r.args, env: r.env, tmux: r.tmux }, "none");
              const st = useTabStore.getState();
              const sameTab = st.tabs.find((t) => leaves(t.root).some((l) => st.sessions[l.sessionId]?.container === rec.container));
              if (sameTab && leaves(sameTab.root).length < 4) {
                st.activateTab(sameTab.id);
                st.splitActive(rec, leaves(sameTab.root).length % 2 === 1 ? "row" : "column");
              } else st.openTab(rec);
            } catch {
              // 容器已删除 / 未运行：保留记录，下次容器启动后可再次恢复
            }
          }
        })
        .catch(() => undefined);
    }
    return () => {
      for (const u of unsubs) void u.then((f) => f());
    };
  }, [openSession]);

  const renderModal = () => {
    if (!modal) return null;
    switch (modal.kind) {
      case "createContainer":
        return <CreateContainerModal />;
      case "auth":
        return (
          <AuthModal
            container={modal.container}
            onRunInTerminal={(container, title, mode, args) =>
              void openSession({ container, title, cwd: "/workspace", mode, args, env: [], tmux: true }).catch((e) => useUiStore.getState().toast("error", errorText(e)))
            }
          />
        );
      case "session":
        return <SessionModal mode={modal.mode} container={modal.container} sessionId={modal.sessionId} split={modal.split} onCreate={createFromModal} />;
      case "sessionList":
        return <SessionListModal items={sessionCatalog} onActivate={activateCatalogItem} onRefresh={refreshSessionList} onClose={() => useUiStore.getState().closeModal()} />;
      case "usage":
        return <UsageModal initialContainer={modal.container} onClose={() => useUiStore.getState().closeModal()} />;
      case "quotaSwitch":
        return <QuotaSwitchModal source={modal.source} sessionId={modal.sessionId} payload={modal.payload} onSwitch={doSwitch} />;
      case "sharedVolume":
        return <SharedVolumeModal />;
      case "danger":
        return <DangerZoneModal container={modal.container} action={modal.action} />;
      case "proxy":
        return <ProxyModal container={modal.container} />;
      case "hostConfig":
        return <HostConfigModal container={modal.container} />;
      case "gitSharing":
        return <GitSharingModal container={modal.container} />;
      case "settings":
        return <SettingsModal tab={modal.tab} />;
    }
  };

  return (
    <div className={`relative isolate flex h-screen w-screen flex-col overflow-hidden bg-term-bg text-on-surface ${wallpaperEnabled ? "wallpaper-enabled" : ""}`}
      style={wallpaperCssVars(wallpaper, themeById(terminalAppearance.theme).theme.background)}>
      <WallpaperLayer settings={wallpaper} url={failedWallpaper === wallpaperSource.url ? null : wallpaperSource.url}
        onReady={() => { setLoadedWallpaper(wallpaperSource.url); setFailedWallpaper(null); }}
        onError={() => { setFailedWallpaper(wallpaperSource.url); useUiStore.getState().toast("warning", "壁纸媒体无法播放，已使用原有背景，请重新选择文件"); }} />
      <TitleBar onNewSession={() => newSession()} onSplit={(d) => newSession(d)} onCloseTab={closeTab} />
      <div className="relative flex min-h-0 flex-1">
        {sidebarPinned && <SidebarDrawer onOpenIn={quickOpen} onSmartSwitch={() => smartSwitch(null)} />}
        <main className="relative min-h-0 min-w-0 flex-1">
          {tabs.length === 0 ? (
            <EmptyState onNewSession={() => newSession()} />
          ) : (
            tabs.map((t) => (
              <div key={t.id} className={`absolute inset-0 ${t.id === activeTabId ? "visible" : "invisible"}`} onDoubleClick={(e) => e.stopPropagation()}>
                <SplitView tabId={t.id} node={t.root} activeSessionId={t.activeSessionId} visible={t.id === activeTabId} onCloseSession={closeSession} />
              </div>
            ))
          )}
          <SearchBar />
          <ActiveOutputReader />
        </main>
      </div>
      {!sidebarPinned && <SidebarDrawer onOpenIn={quickOpen} onSmartSwitch={() => smartSwitch(null)} />}
      <StatusBar />
      <QuotaFlyout onSwitch={smartSwitch} />
      {renderModal()}
      <Toasts />
    </div>
  );
}
