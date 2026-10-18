import type { ITheme } from "@xterm/xterm";
import type { WallpaperSettings } from "../../api/types";

/** Only the pane paints the terminal tint, so transparent xterm canvases never double it. */
export function terminalThemeWithWallpaper(theme: ITheme, wallpaper?: WallpaperSettings | null): ITheme {
  return wallpaper?.asset ? { ...theme, background: "#00000000" } : theme;
}

export function colorWithOpacity(color: string | undefined, opacity: number): string {
  const source = /^#[0-9a-f]{6}$/i.test(color ?? "") ? color!.slice(1) : "121317";
  const alpha = Math.max(0, Math.min(100, Number.isFinite(opacity) ? opacity : 100)) / 100;
  return `rgba(${parseInt(source.slice(0, 2), 16)}, ${parseInt(source.slice(2, 4), 16)}, ${parseInt(source.slice(4, 6), 16)}, ${alpha})`;
}
