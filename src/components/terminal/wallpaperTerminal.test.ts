import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ITerminalOptions } from "@xterm/xterm";
import { DEFAULT_SETTINGS } from "../../lib/demo";
import { useUiStore } from "../../store/uiStore";
import { acquire, applySettings, dispose, get, termOptions } from "./xtermPool";
import { colorWithOpacity } from "./wallpaperTheme";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: ITerminalOptions;
    unicode = { activeVersion: "" };
    written: string[] = [];
    rows = 24;
    refresh = vi.fn();
    dispose = vi.fn();
    constructor(options: ITerminalOptions) { this.options = options; }
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData() {}
    write(value: string) { this.written.push(value); }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} clearTextureAtlas() {} dispose() {} } }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@xterm/addon-clipboard", () => ({ ClipboardAddon: class {} }));
vi.mock("../../api/commands", () => ({ isTauri: () => false }));

const wallpaper = {
  ...DEFAULT_SETTINGS.wallpaper,
  asset: { fileName: "wallpaper.png", originalName: "wallpaper.png", kind: "image" as const },
};

beforeEach(() => {
  useUiStore.setState({ settings: DEFAULT_SETTINGS, wallpaperPreview: null, wallpaperReady: false });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("document", { createElement: () => ({ className: "", addEventListener() {}, remove() {} }) });
});
afterEach(() => { dispose("wallpaper-test"); vi.unstubAllGlobals(); });

describe("wallpaper terminal integration", () => {
  it("enables transparency at creation, and falls back to the original theme until media is ready", () => {
    const normal = termOptions(DEFAULT_SETTINGS.terminal);
    expect(normal.allowTransparency).toBe(true);
    useUiStore.setState({ wallpaperPreview: wallpaper });
    expect(termOptions(DEFAULT_SETTINGS.terminal).theme).toEqual(normal.theme);
    useUiStore.setState({ wallpaperReady: true });
    expect(termOptions(DEFAULT_SETTINGS.terminal).theme?.background).toBe("#00000000");
    expect(termOptions(DEFAULT_SETTINGS.terminal, null).theme).toEqual(normal.theme);
    useUiStore.setState({ wallpaperReady: false });
    expect(termOptions(DEFAULT_SETTINGS.terminal).theme).toEqual(normal.theme);
  });

  it("updates existing terminals without replacing them or clearing their output", () => {
    const terminal = { ...DEFAULT_SETTINGS.terminal, webgl: false };
    const pooled = acquire("wallpaper-test", terminal, { title: "历史会话", container: "demo" });
    pooled.term.write("history preserved\r\n");
    const written = [...(pooled.term as unknown as { written: string[] }).written];
    const originalTheme = pooled.term.options.theme;
    applySettings(terminal, wallpaper);
    expect(get("wallpaper-test")).toBe(pooled);
    expect(pooled.term.options.theme).toEqual({ ...originalTheme, background: "#00000000" });
    expect((pooled.term as unknown as { written: string[] }).written).toEqual(written);
    expect(pooled.term.dispose).not.toHaveBeenCalled();
    applySettings(terminal, null);
    expect(pooled.term.options.theme).toEqual(originalTheme);
    expect((pooled.term as unknown as { written: string[] }).written).toEqual(written);
  });

  it("uses the selected theme for the single pane tint, including both opacity endpoints", () => {
    expect(colorWithOpacity("#123456", 20)).toBe("rgba(18, 52, 86, 0.2)");
    expect(colorWithOpacity("#123456", 0)).toBe("rgba(18, 52, 86, 0)");
    expect(colorWithOpacity("#123456", 100)).toBe("rgba(18, 52, 86, 1)");
  });
});
