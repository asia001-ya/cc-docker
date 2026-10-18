import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { errorText, termScrollback } from "../../api/commands";
import type { ScrollbackState } from "../../api/types";
import { createHistoryScrollQueue, historyOffsetAt, historyScrollbarGeometry } from "../../lib/tmuxScroll";
import { themeById } from "../../lib/themes";
import { useUiStore } from "../../store/uiStore";
import { useTabStore } from "../../store/tabStore";
import { get } from "./xtermPool";
import { bindHistoryCursor } from "../../lib/historyCursor";
import { bindHistorySelection } from "../../lib/historySelection";

const pooledTerminal = (sessionId: string) => get(sessionId)?.term;

interface Props {
  sessionId: string;
  theme: string;
  containerRef: RefObject<HTMLDivElement | null>;
  /** 可注入独立的回归夹具，产品中始终使用 Tauri 命令。 */
  load?: (sessionId: string, offset?: number) => Promise<ScrollbackState>;
  getTerminal?: (sessionId: string) => Terminal | undefined;
}

/** tmux 使用备用屏幕，本地 xterm 没有历史；此滑块直接反映容器的回滚位置。 */
export function TmuxScrollbar({ sessionId, theme, containerRef, load = termScrollback, getTerminal = pooledTerminal }: Props) {
  const [state, setState] = useState<ScrollbackState | null>(null);
  const [height, setHeight] = useState(0);
  const [dragging, setDragging] = useState(false);
  const rail = useRef<HTMLDivElement>(null);
  const current = useRef(state);
  const queue = useRef<ReturnType<typeof createHistoryScrollQueue> | null>(null);
  const drag = useRef<{ pointerId: number; grab: number; travel: number; historyRows: number } | null>(null);
  const wheelRemainder = useRef(0);
  const cursor = useRef<ReturnType<typeof bindHistoryCursor> | null>(null);
  const colors = themeById(theme).theme;

  useEffect(() => {
    const q = createHistoryScrollQueue(
      (offset) => load(sessionId, offset),
      (next) => {
        const old = current.current;
        if (old && Object.keys(next).every((key) => next[key as keyof ScrollbackState] === old[key as keyof ScrollbackState])) return;
        current.current = next; setState(next);
      },
      (error, writing) => {
        if (writing) useUiStore.getState().toast("error", `滚动历史失败：${errorText(error)}`);
      },
    );
    queue.current = q;
    q.refresh();
    const timer = window.setInterval(() => q.refresh(), 500);
    return () => { clearInterval(timer); q.dispose(); queue.current = null; };
  }, [sessionId, load]);

  const available = state?.available ?? false;
  const shown = available && (state?.historyRows ?? 0) > 0;
  useEffect(() => {
    const host = containerRef.current;
    host?.classList.toggle("terminal-remote-scrollback", available);
    return () => host?.classList.remove("terminal-remote-scrollback");
  }, [containerRef, available]);

  useEffect(() => {
    const term = getTerminal(sessionId);
    if (!term || !available) return;
    const guard = bindHistoryCursor(term);
    // 经典终端从底部开始拖选也走本地选择，否则 tmux 会在松手时 copy-and-cancel。
    const unbindSelection = bindHistorySelection(term, () => current.current?.available ?? false);
    cursor.current = guard;
    guard.setHidden((current.current?.offsetRows ?? 0) > 0 || !!current.current?.inCopyMode);
    return () => { unbindSelection(); guard.dispose(); cursor.current = null; };
  }, [sessionId, available, getTerminal]);
  useEffect(() => {
    cursor.current?.setHidden((state?.offsetRows ?? 0) > 0 || !!state?.inCopyMode);
  }, [state]);

  useEffect(() => {
    const element = rail.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    setHeight(element.clientHeight);
    return () => observer.disconnect();
  }, [shown]);

  const scroll = (offset: number) => {
    const previous = current.current;
    if (!previous) return;
    const offsetRows = Math.max(0, Math.min(previous.historyRows, Math.round(offset)));
    if (offsetRows === previous.offsetRows && (offsetRows > 0 || !previous.inCopyMode)) return;
    // 后端确认退出 copy-mode 前继续隐藏历史光标，避免拖到底部时闪到正文中。
    const next = { ...previous, offsetRows, inCopyMode: previous.inCopyMode || offsetRows > 0 };
    getTerminal(sessionId)?.clearSelection();
    current.current = next;
    setState(next);
    queue.current?.scroll(next.offsetRows);
  };

  // 轨道和整个终端内容区共用此处理器，捕获阶段先于 xterm 的鼠标协议。
  useEffect(() => {
    const element = rail.current;
    if (!element) return;
    const content = containerRef.current;
    const onMouseMove = (event: MouseEvent) => {
      if (event.buttons === 0 && ((current.current?.offsetRows ?? 0) > 0 || current.current?.inCopyMode)) event.stopPropagation();
    };
    const onWheel = (event: WheelEvent) => {
      const s = current.current;
      if (!s?.available || !s.historyRows || !event.deltaY) return;
      event.preventDefault();
      event.stopPropagation();
      const cell = element.clientHeight / s.viewportRows;
      const delta = event.deltaY * (event.deltaMode === 1 ? 1 : event.deltaMode === 2 ? s.viewportRows : 1 / Math.max(1, cell));
      if (delta * wheelRemainder.current < 0) wheelRemainder.current = 0;
      wheelRemainder.current += delta;
      const lines = Math.trunc(wheelRemainder.current);
      wheelRemainder.current -= lines;
      if (lines) scroll(s.offsetRows - lines);
    };
    element.addEventListener("wheel", onWheel, { capture: true, passive: false });
    content?.addEventListener("wheel", onWheel, { capture: true, passive: false });
    content?.addEventListener("mousemove", onMouseMove, true);
    return () => {
      element.removeEventListener("wheel", onWheel, true);
      content?.removeEventListener("wheel", onWheel, true);
      content?.removeEventListener("mousemove", onMouseMove, true);
    };
  }, [shown, containerRef, sessionId, getTerminal]);

  if (!shown || !state) return null;
  const geometry = historyScrollbarGeometry(height, state);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    const g = historyScrollbarGeometry(rect.height, current.current!);
    const y = event.clientY - rect.top;
    const onThumb = (event.target as HTMLElement).closest(".terminal-history-thumb");
    const grab = onThumb ? y - g.top : g.thumb / 2;
    drag.current = { pointerId: event.pointerId, grab, travel: g.travel, historyRows: current.current!.historyRows };
    element.setPointerCapture(event.pointerId);
    setDragging(true);
    useTabStore.getState().focus(sessionId);
    if (!onThumb) scroll(historyOffsetAt(y - grab, g.travel, state.historyRows));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const top = event.clientY - event.currentTarget.getBoundingClientRect().top - d.grab;
    scroll(historyOffsetAt(top, d.travel, d.historyRows));
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    queue.current?.refresh();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const s = current.current!;
    const offsets: Record<string, number> = {
      ArrowUp: s.offsetRows + 1, ArrowDown: s.offsetRows - 1,
      PageUp: s.offsetRows + s.viewportRows, PageDown: s.offsetRows - s.viewportRows,
      Home: s.historyRows, End: 0,
    };
    if (!(event.key in offsets)) return;
    event.preventDefault();
    event.stopPropagation();
    scroll(offsets[event.key]);
  };

  return (
    <div
      ref={rail}
      role="scrollbar"
      aria-label="终端历史滚动条"
      aria-controls={`terminal-${sessionId}`}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={state.historyRows}
      aria-valuenow={state.historyRows - state.offsetRows}
      aria-valuetext={state.offsetRows ? `距离底部 ${state.offsetRows} 行` : "实时输出"}
      tabIndex={0}
      title={state.offsetRows ? `距离底部 ${state.offsetRows} 行，按 End 返回实时输出` : "拖动查看终端历史"}
      className="terminal-history-rail"
      data-dragging={dragging}
      style={{
        "--history-thumb": colors.scrollbarSliderBackground ?? "rgba(255,255,255,0.3)",
        "--history-thumb-hover": colors.scrollbarSliderHoverBackground ?? "rgba(255,255,255,0.5)",
        "--history-thumb-active": colors.scrollbarSliderActiveBackground ?? "rgba(96,205,255,0.55)",
      } as CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <div className="terminal-history-thumb" style={{ top: geometry.top, height: geometry.thumb }} />
    </div>
  );
}
