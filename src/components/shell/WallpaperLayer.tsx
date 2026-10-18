import { useEffect, useRef, type CSSProperties } from "react";
import type { WallpaperSettings } from "../../api/types";
import { colorWithOpacity } from "../terminal/wallpaperTheme";

interface Props {
  settings: WallpaperSettings;
  url: string | null;
  onReady?: () => void;
  onError?: () => void;
}

/** Shared variables for the application and the settings preview. */
export function wallpaperCssVars(settings: WallpaperSettings, terminalBackground = "#121317"): CSSProperties {
  return {
    "--wallpaper-panel-opacity": settings.panelOpacity / 100,
    "--wallpaper-glass-blur": `${settings.glassBlur}px`,
    "--wallpaper-terminal-background": colorWithOpacity(terminalBackground, settings.terminalOpacity),
  } as CSSProperties;
}

/** Decorative media stays behind the UI; filters never touch terminal glyphs. */
export function WallpaperLayer({ settings, url, onReady, onError }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const isVideo = settings.asset?.kind === "video";

  useEffect(() => {
    const element = video.current;
    if (!element || !isVideo || !url) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePlayback = () => {
      if (document.hidden || reducedMotion.matches) element.pause();
      else void element.play().catch(() => undefined);
    };
    updatePlayback();
    document.addEventListener("visibilitychange", updatePlayback);
    reducedMotion.addEventListener("change", updatePlayback);
    return () => {
      element.pause();
      document.removeEventListener("visibilitychange", updatePlayback);
      reducedMotion.removeEventListener("change", updatePlayback);
    };
  }, [url, isVideo]);

  if (!url || !settings.asset) return null;
  const mediaStyle: CSSProperties = {
    filter: settings.blur > 0 ? `blur(${settings.blur}px)` : undefined,
    inset: -settings.blur * 2,
    width: `calc(100% + ${settings.blur * 4}px)`,
    height: `calc(100% + ${settings.blur * 4}px)`,
    objectFit: settings.fit === "center" || settings.fit === "tile" ? "none" : settings.fit,
  };

  return (
    <div className="wallpaper-layer" aria-hidden="true" style={{ opacity: settings.opacity / 100 }}>
      {isVideo ? (
        <video
          key={url}
          ref={video}
          className="wallpaper-media"
          style={mediaStyle}
          src={url}
          muted
          loop
          playsInline
          preload="auto"
          tabIndex={-1}
          disablePictureInPicture
          onLoadedData={onReady}
          onError={onError}
        />
      ) : settings.fit === "tile" ? (
        <>
          <div className="wallpaper-media" style={{ ...mediaStyle, backgroundImage: `url(${JSON.stringify(url)})`, backgroundRepeat: "repeat", backgroundPosition: "center" }} />
          <img key={url} src={url} alt="" className="wallpaper-load-probe" onLoad={onReady} onError={onError} />
        </>
      ) : (
        <img key={url} className="wallpaper-media" style={mediaStyle} src={url} alt="" draggable={false} onLoad={onReady} onError={onError} />
      )}
      <div className="wallpaper-dim" style={{ opacity: settings.dim / 100 }} />
    </div>
  );
}
