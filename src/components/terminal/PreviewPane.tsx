/**
 * 悬浮预览：在终端上方用 iframe 显示容器内 Web 服务（经端口映射后的宿主地址）。
 * 跨源 iframe 的历史不能由外层控制，因此只提供刷新、地址栏、系统浏览器打开与关闭。
 */
import { useEffect, useState } from "react";
import { useTabStore } from "../../store/tabStore";
import { useUiStore } from "../../store/uiStore";
import { normalizePreviewUrl } from "../../lib/preview";
import { Icon } from "../ui/controls";
import { openExternal } from "./xtermPool";

interface Props {
  /** 预览 ID（分屏树叶子中的 pv:<n>） */
  id: string;
}

/**
 * 预览窗格组件。
 * @param props id 预览 ID
 * @returns JSX
 */
export function PreviewPane({ id }: Props) {
  const rec = useTabStore((s) => s.previews[id]);
  const reload = useTabStore((s) => s.reloadPreview);
  const navigate = useTabStore((s) => s.navigatePreview);
  const close = useTabStore((s) => s.closePreview);
  const toast = useUiStore((s) => s.toast);
  const [draft, setDraft] = useState(rec?.url ?? "");

  // 地址被外部更新（再次点击端口、终端链接）时同步到地址栏
  useEffect(() => setDraft(rec?.url ?? ""), [rec?.url]);

  if (!rec) return null;

  /**
   * 地址栏回车：规范化后跳转。
   * @returns 无
   */
  const go = () => {
    const url = normalizePreviewUrl(draft);
    if (!url) return toast("warning", "只支持 http / https 地址");
    navigate(id, url);
  };

  /** 标题条按钮样式 */
  const btn = "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-on-surface-variant transition-colors hover:bg-white/[0.10] hover:text-on-surface focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent";

  return (
    <div className="preview-pane-frame flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-xl border">
      <div className="preview-pane-toolbar flex h-9 shrink-0 items-center gap-1.5 border-b border-white/[0.08] px-2 font-ui text-label-sm text-on-surface-variant">
        <Icon name="travel_explore" size={14} className="text-accent" />
        <span className="max-w-[26%] truncate text-on-surface-variant" title={rec.container}>{rec.container}</span>
        <button type="button" className={btn} title="刷新" onClick={() => reload(id)}>
          <Icon name="refresh" size={14} />
        </button>
        <input
          aria-label="预览地址"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go();
            if (e.key === "Escape") setDraft(rec.url);
          }}
          spellCheck={false}
          className="h-6 min-w-0 flex-1 rounded-md border border-white/10 bg-black/20 px-2 font-mono text-code-sm text-on-surface outline-none transition-colors hover:border-white/20 focus:border-accent/60 focus:bg-black/30"
        />
        <button type="button" className={btn} title="在系统浏览器打开" onClick={() => openExternal(rec.url)}>
          <Icon name="open_in_new" size={14} />
        </button>
        <button type="button" className={`${btn} hover:!text-st-bad`} title="关闭预览" onClick={() => close(id)}>
          <Icon name="close" size={14} />
        </button>
      </div>
      {/* nonce 变化时重建 iframe：跨源页面无法从外层调用 reload */}
      <iframe key={rec.nonce} src={rec.url} title={`预览 ${rec.url}`} className="block min-h-0 w-full flex-1 border-0 bg-white" />
    </div>
  );
}
