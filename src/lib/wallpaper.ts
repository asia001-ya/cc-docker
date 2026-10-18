import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { WallpaperAsset, WallpaperSettings } from "../api/types";
import { errorText, isTauri, wallpaperDelete, wallpaperResolve } from "../api/commands";

export const DEFAULT_WALLPAPER: WallpaperSettings = {
  asset: null, fit: "cover", opacity: 75, blur: 0, dim: 25,
  terminalOpacity: 20, panelOpacity: 75, glassBlur: 0,
};
export const WALLPAPER_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
export const WALLPAPER_VIDEO_EXTENSIONS = ["mp4", "webm"];
const demoSources = new Map<string, string>();

export function importDemoWallpaper(file: File, kind: WallpaperAsset["kind"]): WallpaperAsset {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const allowed = kind === "image" ? WALLPAPER_IMAGE_EXTENSIONS : WALLPAPER_VIDEO_EXTENSIONS;
  const limit = (kind === "image" ? 40 : 500) * 1024 * 1024;
  if (!allowed.includes(ext)) throw new Error(`请选择支持的${kind === "image" ? "图片" : "视频"}格式`);
  if (!file.size || file.size > limit) throw new Error(`文件不能为空，${kind === "image" ? "图片最大 40 MB" : "视频最大 500 MB"}`);
  const asset = { fileName: `preview-${crypto.randomUUID()}.${ext}`, originalName: file.name, kind };
  demoSources.set(asset.fileName, URL.createObjectURL(file));
  return asset;
}

export async function resolveWallpaperUrl(asset: WallpaperAsset): Promise<string> {
  if (isTauri()) return convertFileSrc(await wallpaperResolve(asset.fileName));
  const url = demoSources.get(asset.fileName);
  if (!url) throw new Error("演示壁纸已失效，请重新选择文件");
  return url;
}

export async function discardWallpaper(fileName: string): Promise<void> {
  if (isTauri()) return wallpaperDelete(fileName);
  const url = demoSources.get(fileName);
  if (url) URL.revokeObjectURL(url);
  demoSources.delete(fileName);
}

/** 先验证 WebView 能解码，再改变当前壁纸，坏文件不会替换已有预览。 */
export async function validateWallpaperMedia(asset: WallpaperAsset): Promise<void> {
  const url = await resolveWallpaperUrl(asset);
  await new Promise<void>((resolve, reject) => {
    const media = asset.kind === "image" ? new Image() : document.createElement("video");
    const finish = (error?: string) => {
      clearTimeout(timer);
      media.onload = null;
      media.onerror = null;
      if (media instanceof HTMLVideoElement) {
        media.onloadeddata = null;
        media.pause();
        media.removeAttribute("src");
        media.load();
      }
      if (error) reject(new Error(error)); else resolve();
    };
    const timer = setTimeout(() => finish("媒体加载超时，请尝试其他文件"), 15000);
    media.onerror = () => finish("无法读取此媒体，文件可能损坏或编码不受支持；视频建议使用 H.264 MP4 / WebM");
    if (media instanceof HTMLVideoElement) {
      media.muted = true;
      media.preload = "auto";
      media.onloadeddata = () => finish();
    } else media.onload = () => finish();
    media.src = url;
  });
}

export function useWallpaperSource(asset: WallpaperAsset | null) {
  const [state, setState] = useState<{ key: string; url: string | null; error: string | null }>({ key: "", url: null, error: null });
  const key = asset?.fileName ?? "";
  useEffect(() => {
    let active = true;
    if (!asset) { setState({ key: "", url: null, error: null }); return; }
    resolveWallpaperUrl(asset).then((url) => {
      if (active) setState({ key, url, error: null });
    }).catch((error) => {
      if (active) setState({ key, url: null, error: errorText(error) });
    });
    return () => { active = false; };
  }, [key]); // 原名称变化不影响管理文件路径。
  return state.key === key ? { url: state.url, error: state.error } : { url: null, error: null };
}
