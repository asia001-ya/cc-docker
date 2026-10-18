/**
 * 分屏渲染：终端之间正常分屏，预览浮在终端上方；拖动边缘调整比例，双击复位。
 */
import { useEffect, useRef } from "react";
import { isPreview, leaves, type PaneNode } from "../../lib/splitTree";
import { themeById } from "../../lib/themes";
import { useTabStore } from "../../store/tabStore";
import { useUiStore } from "../../store/uiStore";
import { PreviewPane } from "./PreviewPane";
import { TerminalView } from "./TerminalView";
import { beginTerminalResize } from "./xtermPool";

interface Props {
  tabId: string;
  node: PaneNode;
  activeSessionId: string;
  visible: boolean;
  onCloseSession: (sessionId: string) => Promise<void>;
  /** 是否为根节点（根为叶子时不显示窗格标题条） */
  root?: boolean;
}

/**
 * 分屏节点组件。
 * @param props Tab ID、节点、聚焦会话、可见性
 * @returns JSX
 */
export function SplitView({ tabId, node, activeSessionId, visible, onCloseSession, root = true }: Props) {
  const resizeSplit = useTabStore((s) => s.resizeSplit);
  const terminalTheme = useUiStore((s) => s.settings.terminal.theme);
  const box = useRef<HTMLDivElement>(null);
  const finishDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => finishDrag.current?.(), []);

  if (node.type === "leaf") {
    if (isPreview(node.sessionId)) return <PreviewPane id={node.sessionId} />;
    return (
      <TerminalView
        sessionId={node.sessionId}
        focused={node.sessionId === activeSessionId}
        visible={visible}
        inSplit={!root}
        onCloseSession={onCloseSession}
      />
    );
  }

  const row = node.direction === "row";
  // 预览与终端共用连续底色；终端内容让出浮窗空间，不再增加独立的黑色底板。
  const previewOnly = node.children.map((child) => leaves(child).every((l) => isPreview(l.sessionId)));
  const overlaySide = previewOnly[0] !== previewOnly[1] ? (previewOnly[0] ? 0 : 1) : null;

  /**
   * 拖动分隔条。
   * @param e 指针按下事件
   * @returns 无
   */
  const onDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = box.current;
    if (!el) return;
    finishDrag.current?.();
    // 捕获指针：拖过预览窗格的 iframe 时事件不会被 iframe 吞掉
    const handle = e.currentTarget;
    const pointerId = e.pointerId;
    handle.setPointerCapture(pointerId);
    const releaseTerminals = beginTerminalResize(leaves(node).filter((l) => !isPreview(l.sessionId)).map((l) => l.sessionId));
    const rect = el.getBoundingClientRect();
    const start = row ? e.clientX : e.clientY;
    let ratio = node.ratio;
    let frame: number | null = null;
    let finished = false;
    const commit = () => {
      frame = null;
      resizeSplit(tabId, node.id, ratio);
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const delta = (row ? ev.clientX : ev.clientY) - start;
      ratio = node.ratio + delta / (row ? rect.width : rect.height);
      if (frame === null) frame = requestAnimationFrame(commit);
    };
    const up = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", endPointer);
      window.removeEventListener("pointercancel", endPointer);
      window.removeEventListener("blur", up);
      handle.removeEventListener("lostpointercapture", endPointer);
      if (frame !== null) cancelAnimationFrame(frame);
      if (box.current === el) commit();
      releaseTerminals();
      finishDrag.current = null;
    };
    const endPointer = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) up();
    };
    finishDrag.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", endPointer);
    window.addEventListener("pointercancel", endPointer);
    window.addEventListener("blur", up);
    handle.addEventListener("lostpointercapture", endPointer);
  };

  if (overlaySide !== null) {
    const extent = (overlaySide === 0 ? node.ratio : 1 - node.ratio) * 100;
    // 窄分屏时同步收缩预览与内容区域，始终保留终端可用空间。
    const reserved = `clamp(min(${row ? 284 : 184}px, 50%), ${extent}%, max(50%, calc(100% - ${row ? 160 : 120}px)))`;
    return (
      <div ref={box} className="terminal-underlay relative h-full w-full min-h-0 min-w-0" style={{ background: themeById(terminalTheme).theme.background }}>
        <div
          className="absolute inset-0 min-h-0 min-w-0"
          style={{ [row ? (overlaySide === 0 ? "left" : "right") : (overlaySide === 0 ? "top" : "bottom")]: reserved }}
        >
          <SplitView tabId={tabId} node={node.children[overlaySide === 0 ? 1 : 0]} activeSessionId={activeSessionId} visible={visible} onCloseSession={onCloseSession} root={root} />
        </div>
        <div
          className="absolute z-10 min-h-0 min-w-0"
          style={row
            ? { top: 12, bottom: 12, [overlaySide === 0 ? "left" : "right"]: 12, width: `calc(${reserved} - 24px)` }
            : { left: 12, right: 12, [overlaySide === 0 ? "top" : "bottom"]: 12, height: `calc(${reserved} - 24px)` }}
        >
          <div
            role="separator"
            aria-label="调整浏览器大小"
            aria-orientation={row ? "vertical" : "horizontal"}
            title="拖动调整浏览器大小，双击复位"
            onPointerDown={onDrag}
            onDoubleClick={() => resizeSplit(tabId, node.id, 0.5)}
            className={`absolute z-20 rounded-full transition-colors hover:bg-accent/40 ${row
              ? `bottom-3 top-3 w-1.5 cursor-col-resize ${overlaySide === 0 ? "-right-1.5" : "-left-1.5"}`
              : `left-3 right-3 h-1.5 cursor-row-resize ${overlaySide === 0 ? "-bottom-1.5" : "-top-1.5"}`}`}
          />
          <SplitView tabId={tabId} node={node.children[overlaySide]} activeSessionId={activeSessionId} visible={visible} onCloseSession={onCloseSession} root={false} />
        </div>
      </div>
    );
  }

  return (
    <div ref={box} className={`flex h-full w-full min-h-0 min-w-0 ${row ? "flex-row" : "flex-col"}`}>
      <div style={{ flexBasis: `${node.ratio * 100}%` }} className="min-h-0 min-w-0 shrink grow-0 overflow-hidden">
        <SplitView tabId={tabId} node={node.children[0]} activeSessionId={activeSessionId} visible={visible} onCloseSession={onCloseSession} root={false} />
      </div>
      <div
        role="separator"
        aria-orientation={row ? "vertical" : "horizontal"}
        title="拖动调整大小，双击复位"
        onPointerDown={onDrag}
        onDoubleClick={() => resizeSplit(tabId, node.id, 0.5)}
        className={`shrink-0 bg-white/5 transition-colors hover:bg-accent/60 ${row ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"}`}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <SplitView tabId={tabId} node={node.children[1]} activeSessionId={activeSessionId} visible={visible} onCloseSession={onCloseSession} root={false} />
      </div>
    </div>
  );
}
