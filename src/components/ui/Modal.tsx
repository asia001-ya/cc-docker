/**
 * 模态框外壳（Acrylic 遮罩 + 12px 圆角 Fluent 面板），统一处理 Esc 关闭、Ctrl+Enter 主操作、焦点约束。
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./controls";

interface Props {
  /** 标题 */
  title: string;
  /** 标题图标 */
  icon: string;
  /** 标题徽标 */
  badge?: string;
  /** 宽度（px） */
  width?: number;
  /** 危险弹框：红色图标与描边 */
  danger?: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** Ctrl+Enter 主操作 */
  onSubmit?: () => void;
  /** 底部左侧（状态 / 预检） */
  footerLeft?: ReactNode;
  /** 底部右侧（按钮组） */
  footer?: ReactNode;
  /** 标题栏附加按钮 */
  headerExtra?: ReactNode;
  children: ReactNode;
}

/**
 * 模态框组件。
 * @param props 标题、图标、尺寸、回调与内容
 * @returns JSX
 */
export function Modal({ title, icon, badge, width = 640, danger = false, onClose, onSubmit, footerLeft, footer, headerExtra, children }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  // 回调放进 ref：调用方多为内联函数，若作为 effect 依赖会导致每次渲染都重新聚焦第一个输入框
  const closeRef = useRef(onClose);
  const submitRef = useRef(onSubmit);
  closeRef.current = onClose;
  submitRef.current = onSubmit;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>("[data-autofocus], input, select, textarea, button:not([data-close])");
    first?.focus();
    /**
     * 键盘处理：Esc 关闭、Ctrl+Enter 提交、Tab 焦点约束在弹框内。
     * @param e 键盘事件
     * @returns 无
     */
    const onKey = (e: KeyboardEvent) => {
      // 嵌套浮层通过 portal 挂在末尾，只有最上层处理快捷键和焦点约束。
      const dialogs = document.querySelectorAll("[data-tdc-modal]");
      if (dialogs[dialogs.length - 1] !== panel.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeRef.current();
      } else if (e.key === "Enter" && e.ctrlKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        submitRef.current?.();
      } else if (e.key === "Tab" && panel.current) {
        const items = Array.from(panel.current.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")).filter(
          (el) => !el.hasAttribute("disabled"),
        );
        if (items.length === 0) return;
        const i = items.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          items[items.length - 1].focus();
        } else if (!e.shiftKey && i === items.length - 1) {
          e.preventDefault();
          items[0].focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, []);

  return (
    <div
      className="wallpaper-modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6 backdrop-blur-md animate-[fadeIn_120ms_ease-out]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeRef.current();
      }}
    >
      <div
        ref={panel}
        data-tdc-modal
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width }}
        className={`wallpaper-panel flex max-h-[92vh] max-w-full flex-col overflow-hidden rounded-xl border bg-[rgba(36,36,36,0.92)] shadow-modal backdrop-blur-[30px] backdrop-saturate-125 animate-[popIn_160ms_cubic-bezier(0.1,0.9,0.2,1)] ${
          danger ? "border-st-bad/30" : "border-white/[0.12]"
        }`}
      >
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] bg-white/[0.03] px-4">
          <div className="flex min-w-0 items-center gap-2">
            <span className={`flex h-6 w-6 items-center justify-center rounded ${danger ? "bg-st-bad/20 text-st-bad" : "bg-accent text-on-primary-container"}`}>
              <Icon name={icon} size={16} />
            </span>
            <span className="truncate font-ui text-headline-sm text-on-surface">{title}</span>
            {badge && <span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-code-sm text-accent">{badge}</span>}
          </div>
          <div className="flex items-center gap-1">
            {headerExtra}
            <button
              type="button"
              data-close
              title="关闭（Esc）"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-caption-close hover:text-white"
            >
              <Icon name="close" size={18} />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        {(footer || footerLeft) && (
          <footer className="flex min-h-[56px] shrink-0 items-center justify-between gap-3 border-t border-white/[0.06] bg-black/25 px-5 py-2.5">
            <div className="min-w-0 flex-1">{footerLeft}</div>
            <div className="flex shrink-0 items-center gap-2">{footer}</div>
          </footer>
        )}
      </div>
    </div>
  );
}
