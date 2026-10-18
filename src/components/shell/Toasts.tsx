/**
 * 右下角通知与终端搜索条。
 */
import { useEffect, useRef, useState } from "react";
import { useUiStore } from "../../store/uiStore";
import { useActiveSession } from "../../store/tabStore";
import { get } from "../terminal/xtermPool";
import { Icon, IconButton } from "../ui/controls";

/**
 * 通知列表。
 * @returns JSX
 */
export function Toasts() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismiss);
  const icon = { info: "info", success: "check_circle", warning: "warning", error: "error" } as const;
  const color = { info: "text-accent", success: "text-st-ok", warning: "text-st-warn", error: "text-st-bad" } as const;
  return (
    <div className="pointer-events-none fixed bottom-9 right-3 z-[70] flex w-[360px] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="wallpaper-panel pointer-events-auto flex items-start gap-2 rounded-lg border border-white/[0.12] bg-[rgba(32,32,32,0.94)] px-3 py-2 font-ui text-body-md text-on-surface shadow-flyout backdrop-blur-[30px] animate-[popIn_140ms_ease-out]"
        >
          <Icon name={icon[t.tone]} size={17} className={`mt-px ${color[t.tone]}`} />
          <span className="flex-1 whitespace-pre-wrap break-words">{t.text}</span>
          <button type="button" onClick={() => dismiss(t.id)} className="text-outline hover:text-on-surface" title="关闭">
            <Icon name="close" size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * 终端搜索浮条（Ctrl+Shift+F）。
 * @returns JSX
 */
export function SearchBar() {
  const open = useUiStore((s) => s.searchOpen);
  const setOpen = useUiStore((s) => s.setSearch);
  const active = useActiveSession();
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  if (!open || !active) return null;
  const search = get(active.id)?.search;
  const opts = { decorations: { matchOverviewRuler: "#FCE100", activeMatchColorOverviewRuler: "#60CDFF", matchBackground: "#3D3700", activeMatchBackground: "#004d67" } };
  /**
   * 关闭并清除高亮。
   * @returns 无
   */
  const close = () => {
    search?.clearDecorations();
    setOpen(false);
    get(active.id)?.term.focus();
  };
  return (
    <div className="wallpaper-panel absolute right-4 top-10 z-30 flex items-center gap-1 rounded-lg border border-white/[0.12] bg-[rgba(32,32,32,0.94)] p-1 shadow-flyout backdrop-blur-[30px]">
      <Icon name="search" size={16} className="ml-1 text-outline" />
      <input
        ref={input}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          search?.findNext(e.target.value, { ...opts, incremental: true });
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          if (e.key === "Enter") (e.shiftKey ? search?.findPrevious(q, opts) : search?.findNext(q, opts));
        }}
        placeholder="在终端中搜索"
        className="h-7 w-56 bg-transparent px-1 font-ui text-body-md text-on-surface outline-none placeholder:text-outline"
      />
      <IconButton icon="keyboard_arrow_up" title="上一个（Shift+Enter）" onClick={() => search?.findPrevious(q, opts)} />
      <IconButton icon="keyboard_arrow_down" title="下一个（Enter）" onClick={() => search?.findNext(q, opts)} />
      <IconButton icon="close" title="关闭（Esc）" onClick={close} />
    </div>
  );
}
