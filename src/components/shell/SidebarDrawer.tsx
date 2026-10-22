/**
 * 可调宽侧栏（默认 380px Acrylic 浮层，可钉住为常驻）：搜索、容器列表（状态灯 / 剩余额度 / 模式）、
 * 容器右键菜单、"智能切至最高额度"、共享卷入口、新建容器。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { FleetEntry } from "../../api/types";
import { containerAction, errorText, isTauri } from "../../api/commands";
import { useFleetStore } from "../../store/fleetStore";
import { useActiveSession, useTabStore } from "../../store/tabStore";
import { useUiStore } from "../../store/uiStore";
import { colorForRemaining, HEALTH_LABEL, remainingLabel } from "../../lib/quota";
import { clampSidebarWidth, SIDEBAR_DEFAULT_WIDTH, sidebarWidthBounds } from "../../lib/sidebarWidth";
import { Icon, IconButton, StatusDot } from "../ui/controls";
import { QuotaDetails } from "./QuotaDetails";
import { useNow } from "./StatusBar";
import { beginTerminalResize } from "../terminal/xtermPool";

interface Props {
  /** 在容器中新开会话 */
  onOpenIn: (container: string) => void;
  /** 智能切换（当前会话 → 最高额度容器） */
  onSmartSwitch: () => void;
}

/**
 * 容器卡片。
 * @param props entry、active、回调
 * @returns JSX
 */
function ContainerCard({ entry, active, onOpen, onMenu }: { entry: FleetEntry; active: boolean; onOpen: () => void; onMenu: (x: number, y: number) => void }) {
  const q = useUiStore((s) => s.settings.quota);
  const sessionCount = useTabStore((s) => Object.values(s.sessions).filter((r) => r.container === entry.container.name).length);
  const rem = entry.remaining?.remaining ?? 0;
  const color = entry.health === "api" ? "#60CDFF" : colorForRemaining(rem, q.warnThreshold, q.criticalThreshold);
  const off = entry.health === "stopped";
  const now = useNow();
  const isApi = (entry.provider?.mode ?? entry.container.authMode) === "api";
  const proxyState = entry.proxy?.state;
  // 代理开启时在容器名旁显示盾牌：绿色正常、红色断网或兜底缺失
  const proxyBadge =
    !proxyState || proxyState === "off"
      ? null
      : proxyState === "ok"
        ? { icon: "shield", color: "text-st-ok" }
        : proxyState === "starting"
          ? { icon: "shield", color: "text-st-warn" }
          : { icon: "gpp_bad", color: "text-st-bad" };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      title={entry.error ?? (proxyState && proxyState !== "off" ? `${HEALTH_LABEL[entry.health]} · 代理：${proxyState}` : HEALTH_LABEL[entry.health])}
      className={`group flex cursor-pointer flex-col gap-1.5 rounded-lg border p-2.5 transition-colors ${
        active ? "border-accent/40 bg-accent/[0.10]" : "border-transparent bg-white/[0.04] hover:bg-white/[0.07]"
      } ${off ? "opacity-60" : ""}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <StatusDot health={entry.health} pulse={entry.health === "exhausted"} />
          <span className={`truncate font-ui text-headline-sm ${entry.health === "exhausted" ? "text-on-surface-variant" : "text-on-surface"}`}>
            {entry.container.name}
          </span>
          {proxyBadge && <Icon name={proxyBadge.icon} size={14} className={proxyBadge.color} />}
        </span>
        <span className="shrink-0 whitespace-nowrap font-mono text-code-sm font-bold" style={{ color: off ? "#8A8886" : color }}>
          {remainingLabel(entry)}
          {entry.health === "warning" && " 预警"}
          {entry.health === "exhausted" && " 耗尽"}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 font-ui text-label-sm text-on-surface-variant">
        <span className="truncate">
          {isApi ? "API 按量" : "订阅账号"}
        </span>
        <span className="shrink-0">{off ? "已停止" : entry.health === "exhausted" && entry.blockedUntil ? "冷却中" : `${sessionCount} 会话`}</span>
      </div>
      {!isApi && (off
        ? <span className="font-ui text-body-sm text-outline">容器未运行</span>
        : <QuotaDetails quota={entry.quota} now={now} account={entry.account?.email} />)}
      {entry.error && (
        <span className="flex items-center gap-1 font-ui text-label-sm text-st-warn">
          <Icon name="warning" size={12} />
          <span className="truncate">{entry.error}</span>
        </span>
      )}
    </div>
  );
}

/**
 * 容器右键菜单。
 * @param props entry、坐标、关闭回调、新开会话回调
 * @returns JSX
 */
function ContainerMenu({ entry, x, y, onClose, onOpenIn }: { entry: FleetEntry; x: number; y: number; onClose: () => void; onOpenIn: (c: string) => void }) {
  const openModal = useUiStore((s) => s.openModal);
  const toast = useUiStore((s) => s.toast);
  const name = entry.container.name;
  /**
   * 执行生命周期动作。
   * @param a 动作
   * @returns 无
   */
  const act = (a: "start" | "restart") => {
    onClose();
    if (!isTauri()) return toast("info", "演示模式：未连接后端");
    containerAction(name, a)
      .then(() => toast("success", `${name} 已${a === "start" ? "启动" : "重启"}`))
      .catch((e) => toast("error", errorText(e)));
  };
  const item = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-ui text-body-md text-on-surface hover:bg-white/[0.08]";
  return (
    <div className="fixed inset-0 z-[60]" onMouseDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        className="wallpaper-panel acrylic-surface absolute w-52 rounded-lg border border-white/[0.14] p-1"
        style={{ left: Math.min(x, window.innerWidth - 216), top: Math.max(8, Math.min(y, window.innerHeight - 370)) }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button type="button" className={item} disabled={!entry.container.running} onClick={() => (onClose(), onOpenIn(name))}>
          <Icon name="terminal" size={16} /> 新建终端会话
        </button>
        <button type="button" className={item} onClick={() => (onClose(), openModal({ kind: "auth", container: name }))}>
          <Icon name="key" size={16} /> 账号授权 / 切换 API
        </button>
        <button type="button" className={item} onClick={() => (onClose(), openModal({ kind: "editContainer", container: name }))}>
          <Icon name="edit" size={16} /> 编辑容器 / 挂载…
        </button>
        <button type="button" className={item} onClick={() => (onClose(), openModal({ kind: "proxy", container: name }))}>
          <Icon name="vpn_lock" size={16} /> 代理…
        </button>
        <button type="button" className={item} onClick={() => (onClose(), openModal({ kind: "hostConfig", container: name }))}>
          <Icon name="folder_shared" size={16} /> 宿主 Claude 配置…
        </button>
        <button type="button" className={item} onClick={() => (onClose(), openModal({ kind: "gitSharing", container: name }))}>
          <Icon name="key" size={16} /> Git 凭据…
        </button>
        <div className="my-1 h-px bg-white/[0.08]" />
        {entry.container.running ? (
          <button type="button" className={item} onClick={() => act("restart")}>
            <Icon name="restart_alt" size={16} /> 重启容器
          </button>
        ) : (
          <button type="button" className={item} onClick={() => act("start")}>
            <Icon name="play_arrow" size={16} /> 启动容器
          </button>
        )}
        {entry.container.running && (
          <button type="button" className={item} onClick={() => (onClose(), openModal({ kind: "danger", container: name, action: "stop" }))}>
            <Icon name="stop_circle" size={16} /> 停止 / 强制停止…
          </button>
        )}
        <button type="button" className={`${item} !text-st-bad`} onClick={() => (onClose(), openModal({ kind: "danger", container: name, action: "remove" }))}>
          <Icon name="delete" size={16} /> 删除容器…
        </button>
      </div>
    </div>
  );
}

/**
 * 侧栏组件。
 * @param props 新开会话与智能切换回调
 * @returns JSX
 */
export function SidebarDrawer({ onOpenIn, onSmartSwitch }: Props) {
  const open = useUiStore((s) => s.sidebarOpen);
  const pinned = useUiStore((s) => s.sidebarPinned);
  const preferredWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const setSidebar = useUiStore((s) => s.setSidebar);
  const togglePin = useUiStore((s) => s.togglePin);
  const openModal = useUiStore((s) => s.openModal);
  const entries = useFleetStore((s) => s.fleet.entries);
  const engineOk = useFleetStore((s) => s.fleet.engineOk);
  const engineError = useFleetStore((s) => s.fleet.engineError);
  const active = useActiveSession();
  const [filter, setFilter] = useState("");
  const [sortByQuota, setSortByQuota] = useState(false);
  const [menu, setMenu] = useState<{ entry: FleetEntry; x: number; y: number } | null>(null);
  const aside = useRef<HTMLElement>(null);
  const finishDrag = useRef<(() => void) | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const bounds = sidebarWidthBounds(viewportWidth, pinned);
  const width = clampSidebarWidth(dragWidth ?? preferredWidth, bounds);

  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => () => finishDrag.current?.(), [open, pinned]);

  const onResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !aside.current) return;
    event.preventDefault();
    event.stopPropagation();
    finishDrag.current?.();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = aside.current.getBoundingClientRect().width;
    let nextWidth = startWidth;
    let frame: number | null = null;
    let finished = false;
    const oldCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = "col-resize";
    handle.setPointerCapture(pointerId);
    handle.focus();
    setDragWidth(startWidth);
    const releaseTerminals = pinned ? beginTerminalResize(Object.keys(useTabStore.getState().sessions)) : () => {};
    const commit = () => {
      frame = null;
      setDragWidth(nextWidth);
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      ev.preventDefault();
      nextWidth = clampSidebarWidth(startWidth + ev.clientX - startX, sidebarWidthBounds(window.innerWidth, pinned));
      if (frame === null) frame = requestAnimationFrame(commit);
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", endPointer);
      window.removeEventListener("pointercancel", endPointer);
      window.removeEventListener("blur", finish);
      handle.removeEventListener("lostpointercapture", endPointer);
      if (frame !== null) cancelAnimationFrame(frame);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      document.documentElement.style.cursor = oldCursor;
      setSidebarWidth(nextWidth);
      setDragWidth(null);
      releaseTerminals();
      finishDrag.current = null;
    };
    const endPointer = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish();
    };
    finishDrag.current = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", endPointer);
    window.addEventListener("pointercancel", endPointer);
    window.addEventListener("blur", finish);
    handle.addEventListener("lostpointercapture", endPointer);
  };

  const onResizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const values: Record<string, number> = {
      ArrowLeft: width - (event.shiftKey ? 40 : 10), ArrowRight: width + (event.shiftKey ? 40 : 10),
      Home: bounds.min, End: bounds.max, Enter: SIDEBAR_DEFAULT_WIDTH,
    };
    if (!(event.key in values)) return;
    event.preventDefault();
    event.stopPropagation();
    setSidebarWidth(clampSidebarWidth(values[event.key], bounds));
  };

  const list = useMemo(() => {
    const f = entries.filter((e) => e.container.name.includes(filter.trim().toLowerCase()));
    if (!sortByQuota) return f;
    return [...f].sort((a, b) => (b.remaining?.remaining ?? -1) - (a.remaining?.remaining ?? -1));
  }, [entries, filter, sortByQuota]);
  const running = entries.filter((e) => e.container.running).length;
  const shared = new Set(entries.map((e) => e.container.sharedGroup).filter(Boolean)).size;

  if (!open) return null;
  return (
    <>
      {!pinned && <div className="fixed inset-0 top-8 z-30" onMouseDown={() => setSidebar(false)} />}
      <aside
        ref={aside}
        id="container-sidebar"
        aria-label="容器列表"
        style={{ width }}
        className={`wallpaper-panel z-40 flex min-h-0 min-w-0 shrink-0 flex-col gap-2 p-2.5 ${
          pinned
            ? "relative border-r border-white/[0.08] bg-mica-alt"
            : "acrylic-surface fixed bottom-8 left-2 top-10 rounded-xl border border-white/[0.14] animate-[slideIn_160ms_cubic-bezier(0.1,0.9,0.2,1)]"
        }`}
      >
        <div
          role="separator"
          aria-label="调整侧栏宽度"
          aria-orientation="vertical"
          aria-controls="container-sidebar"
          aria-valuemin={bounds.min}
          aria-valuemax={bounds.max}
          aria-valuenow={width}
          aria-valuetext={`${width} 像素`}
          tabIndex={0}
          title="拖动调整侧栏宽度，双击复位；方向键微调"
          onPointerDown={onResize}
          onKeyDown={onResizeKey}
          onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
          onMouseDown={(event) => event.stopPropagation()}
          className={`absolute bottom-0 right-0 top-0 z-10 w-1.5 touch-none cursor-col-resize rounded-r-lg outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 ${dragWidth !== null ? "bg-accent/50" : "bg-transparent"}`}
        />
        <div className="flex items-center gap-1">
          <div className="relative min-w-0 flex-1">
            <Icon name="search" size={15} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-outline" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="筛选容器…"
              className="h-7 w-full rounded border border-white/[0.08] bg-white/[0.04] pl-7 pr-2 font-ui text-body-sm text-on-surface outline-none placeholder:text-outline focus:border-b-accent"
            />
          </div>
          <IconButton icon="sort" title={sortByQuota ? "按名称排序" : "按剩余额度排序"} active={sortByQuota} onClick={() => setSortByQuota(!sortByQuota)} />
          <IconButton icon={pinned ? "keep" : "keep_off"} title={pinned ? "取消钉住（浮层模式）" : "钉住侧栏"} active={pinned} onClick={togglePin} />
        </div>

        <div className="flex items-center justify-between px-1 font-ui text-label-sm text-on-surface-variant">
          <span>容器（运行 {running}/{entries.length}）</span>
          <button type="button" className="flex items-center gap-0.5 text-accent hover:underline" onClick={() => openModal({ kind: "createContainer" })}>
            <Icon name="add" size={14} /> 新建
          </button>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5 overflow-y-auto overflow-x-hidden pr-0.5">
          {!engineOk && (
            <div className="rounded-lg border border-st-bad/30 bg-st-bad-bg/60 p-2.5 font-ui text-body-sm text-on-surface">
              <div className="mb-1 flex items-center gap-1 text-st-bad">
                <Icon name="cloud_off" size={15} /> Docker 引擎不可用
              </div>
              <div className="text-on-surface-variant">{engineError ?? "正在连接…"}</div>
              <div className="mt-1 text-on-surface-variant">请安装并启动 Docker Desktop（WSL2 后端）。</div>
            </div>
          )}
          {engineOk && list.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-8 text-center font-ui text-body-sm text-on-surface-variant">
              <Icon name="deployed_code" size={32} className="text-outline" />
              {filter ? "没有匹配的容器" : "还没有 tdc 容器"}
              {!filter && (
                <button type="button" className="text-accent hover:underline" onClick={() => openModal({ kind: "createContainer" })}>
                  新建第一个容器
                </button>
              )}
            </div>
          )}
          {list.map((e) => (
            <ContainerCard
              key={e.container.name}
              entry={e}
              active={e.container.name === active?.container}
              onOpen={() => (e.container.running ? onOpenIn(e.container.name) : setMenu({ entry: e, x: (aside.current?.getBoundingClientRect().right ?? width) + 10, y: 120 }))}
              onMenu={(x, y) => setMenu({ entry: e, x, y })}
            />
          ))}
        </div>

        <div className="flex flex-col gap-1 border-t border-white/[0.06] pt-2">
          <button
            type="button"
            onClick={onSmartSwitch}
            disabled={!active}
            className="flex h-8 items-center justify-center gap-1.5 rounded bg-white/[0.07] font-ui text-headline-sm text-accent transition-colors hover:bg-white/[0.11] disabled:opacity-40"
            title="把当前会话切换到剩余额度最高的容器"
          >
            <Icon name="bolt" size={16} /> 智能切至最高额度
          </button>
          <button
            type="button"
            onClick={() => openModal({ kind: "sharedVolume" })}
            className="flex h-7 items-center justify-between rounded px-2 font-ui text-label-md text-on-surface-variant hover:bg-white/[0.05] hover:text-on-surface"
          >
            <span className="flex items-center gap-1.5">
              <Icon name="folder_shared" size={15} /> 共享会话卷
            </span>
            <span className="font-mono text-code-sm text-outline">{shared} 组</span>
          </button>
        </div>
      </aside>
      {menu && <ContainerMenu entry={menu.entry} x={menu.x} y={menu.y} onClose={() => setMenu(null)} onOpenIn={onOpenIn} />}
    </>
  );
}
