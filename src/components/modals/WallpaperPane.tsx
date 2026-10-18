import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { WallpaperAsset, WallpaperSettings } from "../../api/types";
import { errorText, isTauri, wallpaperImport } from "../../api/commands";
import { DEFAULT_WALLPAPER, discardWallpaper, importDemoWallpaper, useWallpaperSource, validateWallpaperMedia, WALLPAPER_IMAGE_EXTENSIONS, WALLPAPER_VIDEO_EXTENSIONS } from "../../lib/wallpaper";
import { WallpaperLayer } from "../shell/WallpaperLayer";
import { Button, Callout, Icon, Select } from "../ui/controls";

const ADJUSTMENTS = [
  { key: "opacity", label: "壁纸不透明度", max: 100, unit: "%", hint: "调低后壁纸变淡，露出背景色；100% 显示原图浓度。" },
  { key: "blur", label: "壁纸模糊", max: 40, unit: "px", hint: "只模糊壁纸，终端文字保持清晰。" },
  { key: "dim", label: "壁纸压暗", max: 100, unit: "%", hint: "压暗高亮区域，让文字更容易阅读。" },
  { key: "terminalOpacity", label: "终端底色不透明度", max: 100, unit: "%", hint: "0% 时文字直接浮在壁纸上，100% 时终端底色遮住壁纸。" },
  { key: "panelOpacity", label: "面板不透明度", max: 100, unit: "%", hint: "控制标题栏、侧栏和弹窗的底色浓度。" },
  { key: "glassBlur", label: "面板玻璃模糊", max: 40, unit: "px", hint: "模糊面板背后的画面，面板文字保持清晰。" },
] as const;

export function WallpaperPane({ value, onChange, onImported, onBusyChange, disabled = false }: {
  value: WallpaperSettings;
  onChange: (value: WallpaperSettings) => void;
  onImported: (asset: WallpaperAsset) => void;
  onBusyChange: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const imageInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = useWallpaperSource(value.asset);
  const locked = busy || disabled;
  const setPending = (next: boolean) => { pending.current = next; setBusy(next); onBusyChange(next); };

  const accept = async (create: () => Promise<WallpaperAsset | null>) => {
    if (pending.current || disabled) return;
    setPending(true);
    setError(null);
    let imported: WallpaperAsset | null = null;
    try {
      imported = await create();
      if (!imported) return;
      if (!mounted.current) { await discardWallpaper(imported.fileName); return; }
      await validateWallpaperMedia(imported);
      if (!mounted.current) { await discardWallpaper(imported.fileName); return; }
      onImported(imported);
      onChange({ ...value, asset: imported, fit: imported.kind === "video" && value.fit === "tile" ? "cover" : value.fit });
    } catch (cause) {
      if (mounted.current) setError(errorText(cause));
      if (imported) void discardWallpaper(imported.fileName).catch(() => undefined);
    } finally { if (mounted.current) setPending(false); }
  };

  const choose = (kind: WallpaperAsset["kind"]) => {
    if (!isTauri()) { (kind === "image" ? imageInput : videoInput).current?.click(); return; }
    void accept(async () => {
      const path = await open({ multiple: false, directory: false, title: `选择壁纸${kind === "image" ? "图片" : "视频"}`,
        filters: [{ name: kind === "image" ? "图片" : "视频", extensions: kind === "image" ? WALLPAPER_IMAGE_EXTENSIONS : WALLPAPER_VIDEO_EXTENSIONS }] });
      return typeof path === "string" ? wallpaperImport(path, kind) : null;
    });
  };
  const demoSelected = (event: ChangeEvent<HTMLInputElement>, kind: WallpaperAsset["kind"]) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void accept(async () => importDemoWallpaper(file, kind));
  };

  return <div className="flex flex-col gap-3">
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-ui text-headline-sm text-on-surface">壁纸图片 / 视频</h3>
          <p className="mt-1 font-ui text-body-sm text-on-surface-variant">导入后复制到应用数据目录，源文件可自由移动。</p>
          <p className="mt-2 break-all font-ui text-body-sm text-outline">{value.asset?.originalName ?? "未设置壁纸，使用原有背景"}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button icon="image" disabled={locked} onClick={() => choose("image")}>选择图片…</Button>
            <Button icon="movie" disabled={locked} onClick={() => choose("video")}>选择视频…</Button>
            <Button variant="subtle" disabled={locked || !value.asset} onClick={() => { setError(null); onChange({ ...value, asset: null }); }}>清除</Button>
          </div>
        </div>
        <div aria-label="壁纸效果预览" className="relative isolate h-[126px] w-[205px] shrink-0 overflow-hidden rounded-lg border border-white/10 bg-[#121317]">
          <WallpaperLayer settings={value} url={source.url} />
          {value.asset && source.url ? <div className="absolute inset-0 flex flex-col">
            <div className="px-2 py-1 font-ui text-[10px] text-white" style={{ background: `rgba(28,32,39,${value.panelOpacity / 100})`, backdropFilter: `blur(${value.glassBlur}px)` }}>终端预览</div>
            <div className="flex-1 p-2 font-mono text-[10px] leading-5 text-[#c9d1d9]" style={{ background: `rgba(18,19,23,${value.terminalOpacity / 100})` }}>
              <span className="text-[#60cdff]">~/workspace</span> $ claude<br /><span className="text-[#8fdb9b]">✓ Ready</span><br />保持文字清晰可读<span className="ml-1 inline-block h-3 w-1.5 bg-white/70 align-middle" />
            </div>
          </div> : <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-outline"><Icon name="wallpaper" size={30} /><span className="font-ui text-body-sm">壁纸预览</span></div>}
        </div>
      </div>
      <p className="mt-3 font-ui text-label-sm text-outline">图片：PNG、JPG、WebP、GIF、BMP（最大 40 MB）；视频：MP4、WebM（最大 500 MB），静音循环播放。</p>
      {!isTauri() && <p className="mt-1 font-ui text-label-sm text-outline">演示模式：文件仅在当前页面中预览，桌面端会复制并持久保存。</p>}
      <input ref={imageInput} type="file" accept={WALLPAPER_IMAGE_EXTENSIONS.map((ext) => `.${ext}`).join(",")} className="hidden" aria-label="选择壁纸图片文件" onChange={(event) => demoSelected(event, "image")} />
      <input ref={videoInput} type="file" accept=".mp4,.webm" className="hidden" aria-label="选择壁纸视频文件" onChange={(event) => demoSelected(event, "video")} />
    </div>
    {(error || source.error) && <div role="alert"><Callout tone="danger">{error ?? source.error}</Callout></div>}
    {busy && <p role="status" className="font-ui text-body-sm text-accent">正在导入并检查媒体…</p>}
    <div className="flex items-center justify-between gap-4 rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3">
      <label htmlFor="wallpaper-fit" className="font-ui text-body-md text-on-surface">铺放方式</label>
      <Select id="wallpaper-fit" className="!w-44" value={value.fit} disabled={locked} onChange={(event) => onChange({ ...value, fit: event.target.value as WallpaperSettings["fit"] })}>
        <option value="cover">填充（保持比例）</option><option value="contain">适应（显示完整）</option><option value="fill">拉伸</option><option value="center">居中</option>
        <option value="tile" disabled={value.asset?.kind === "video"}>平铺（仅图片）</option>
      </Select>
    </div>
    <div className="flex flex-col gap-4 rounded-xl border border-white/[0.08] bg-white/[0.03] p-4">
      {ADJUSTMENTS.map(({ key, label, max, unit, hint }) => <div key={key}>
        <div className="flex items-center justify-between gap-4">
          <label htmlFor={`wallpaper-${key}`} className="font-ui text-body-md text-on-surface">{label}</label>
          <div className="flex w-[48%] min-w-[180px] items-center gap-3">
            <input id={`wallpaper-${key}`} type="range" min={0} max={max} step={1} value={value[key]} disabled={locked}
              onChange={(event) => onChange({ ...value, [key]: Number(event.target.value) })}
              className="min-w-0 flex-1 accent-[#60cdff]" />
            <output htmlFor={`wallpaper-${key}`} className="w-12 shrink-0 text-right font-mono text-code-sm text-on-surface-variant">{value[key]}{unit}</output>
          </div>
        </div>
        <p className="mt-1 font-ui text-label-sm text-outline">{hint}</p>
      </div>)}
    </div>
    <div className="flex items-center justify-between gap-3">
      <span className="font-ui text-label-sm text-outline">调整实时预览，保存后生效；取消恢复原设置。</span>
      <Button variant="subtle" disabled={locked} onClick={() => onChange({ ...DEFAULT_WALLPAPER, asset: value.asset })}>恢复默认效果</Button>
    </div>
  </div>;
}
