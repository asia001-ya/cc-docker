/**
 * 单个终端窗格：把池中的 xterm DOM 挂到当前位置，监听尺寸变化，处理聚焦与已迁移 / 已结束状态。
 */
import { useEffect, useRef } from "react";
import { acquire, attach, cancelSessionFit, fitSession, get } from "./xtermPool";
import { useTabStore } from "../../store/tabStore";
import { useUiStore } from "../../store/uiStore";
import { errorText, isTauri } from "../../api/commands";
import { themeById } from "../../lib/themes";
import { Icon } from "../ui/controls";
import { bindTerminalHistoryScroll } from "../../lib/terminalScroll";
import { TmuxScrollbar } from "./TmuxScrollbar";

interface Props {
  sessionId: string;
  /** 是否为当前 Tab 中的聚焦窗格 */
  focused: boolean;
  /** 当前 Tab 是否可见 */
  visible: boolean;
  /** 是否处于分屏中（显示窗格标题条） */
  inSplit: boolean;
  /** 关闭指定会话，保留同一 Tab 中的其他窗格 */
  onCloseSession: (sessionId: string) => Promise<void>;
}

/**
 * 终端窗格组件。
 * @param props 会话 ID、聚焦与可见状态
 * @returns JSX
 */
export function TerminalView({ sessionId, focused, visible, inSplit, onCloseSession }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const rec = useTabStore((s) => s.sessions[sessionId]);
  const exitedCode = useTabStore((s) => s.exited[sessionId]);
  const exited = exitedCode !== undefined;
  const settings = useUiStore((s) => s.terminalPreview ?? s.settings.terminal);
  const focus = useTabStore((s) => s.focus);
  const markExited = useTabStore((s) => s.markExited);
  const toast = useUiStore((s) => s.toast);

  // 挂载池中 DOM；组件卸载时只移走 DOM，不销毁终端
  useEffect(() => {
    if (!ref.current || !rec) return;
    const container = ref.current;
    const p = acquire(sessionId, settings, { title: rec.title, container: rec.container });
    container.appendChild(p.host);
    const unbindHistoryScroll = bindTerminalHistoryScroll(p.host, p.term);
    // 包含复用的终端实例：有回滚内容时常驻细滑块，鼠标进入轨道后由 CSS 展开。
    const syncScrollbar = () => p.host.classList.toggle("terminal-has-scrollback", p.term.buffer.active.baseY > 0);
    const scrollbarEvents = [p.term.onRender(syncScrollbar), p.term.onScroll(syncScrollbar), p.term.onResize(syncScrollbar), p.term.buffer.onBufferChange(syncScrollbar)];
    syncScrollbar();
    attach(sessionId, (code) => markExited(sessionId, code)).catch((e) => toast("error", `附着终端失败：${errorText(e)}`));
    const ro = new ResizeObserver(() => fitSession(sessionId));
    ro.observe(container);
    fitSession(sessionId);
    return () => {
      ro.disconnect();
      unbindHistoryScroll();
      for (const event of scrollbarEvents) event.dispose();
      cancelSessionFit(sessionId);
      if (p.host.parentElement === container) container.removeChild(p.host);
    };
    // settings 仅用于首次创建，后续变更由 applySettings 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, rec?.id]);

  // 可见且聚焦时把键盘焦点交给 xterm
  useEffect(() => {
    if (visible && focused) {
      fitSession(sessionId);
      const frame = requestAnimationFrame(() => {
        get(sessionId)?.term.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [visible, focused, sessionId]);

  return (
    <div
      className={`terminal-surface relative flex h-full w-full flex-col ${inSplit && focused ? "ring-1 ring-inset ring-accent/40" : ""}`}
      style={{ background: themeById(settings.theme).theme.background }}
      // xterm 的本地强制选择会停止 mousedown 冒泡，捕获阶段先标记当前窗格。
      onMouseDownCapture={() => focus(sessionId)}
    >
      {inSplit && rec && (
        <div className="flex h-5 shrink-0 items-center gap-1.5 bg-black/30 px-2 font-ui text-label-sm text-on-surface-variant">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${focused ? "bg-accent" : "bg-st-off"}`} />
          <span className="truncate">{rec.title}</span>
          <span className="truncate text-outline">· {rec.container}</span>
          <button
            type="button"
            title="关闭此会话（Ctrl+Shift+W 关闭聚焦会话）"
            aria-label={`关闭会话：${rec.title}`}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={() => void onCloseSession(sessionId)}
            className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded text-on-surface-variant hover:bg-white/10 hover:text-st-bad focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div id={`terminal-${sessionId}`} ref={ref} className="h-full overflow-hidden pl-1.5 pt-1" />
        {visible && !exited && rec?.tmux && isTauri() && <TmuxScrollbar sessionId={sessionId} theme={settings.theme} containerRef={ref} />}
      </div>
      {exited && (
        <div className="pointer-events-none absolute bottom-3 right-4 rounded-md bg-surface-container-high/90 px-2.5 py-1 font-ui text-label-sm text-on-surface-variant shadow-flyout">
          会话已结束 · 按 Ctrl+Shift+W 关闭
        </div>
      )}
    </div>
  );
}
