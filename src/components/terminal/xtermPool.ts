/**
 * xterm 实例池：每个会话一个 Terminal，跨 Tab 切换 / 分屏重排复用，不随 React 组件卸载销毁。
 * 终端输出永不进入 React 状态，全部经 Channel 直写 xterm。
 */
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { TerminalSettings, WallpaperSettings } from "../../api/types";
import { errorText, isTauri, termAttach, termPasteImage, termResize, termWrite } from "../../api/commands";
import { fontStack, themeById } from "../../lib/themes";
import { demoBanner } from "../../lib/demo";
import { choosePaste, oscWritesClipboard, PASTE_IMAGE_TYPES } from "../../lib/clipboard";
import { useUiStore } from "../../store/uiStore";
import { createTerminalResizeScheduler, createTerminalSizeSync } from "../../lib/terminalResize";
import { terminalThemeWithWallpaper } from "./wallpaperTheme";

/** 池中条目 */
export interface PooledTerm {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  /** 承载 xterm 的 DOM（在组件间移动） */
  host: HTMLDivElement;
  webgl: WebglAddon | null;
  attached: boolean;
  sizeSync: ReturnType<typeof createTerminalSizeSync>;
}

const pool = new Map<string, PooledTerm>();
const resizeScheduler = createTerminalResizeScheduler(fitNow);
let keyHandler: ((e: KeyboardEvent, sessionId: string) => boolean) | null = null;

/**
 * 注册应用快捷键拦截器（返回 false 表示按键被应用消费，不送入终端）。
 * @param h 处理函数
 * @returns 无
 */
export function setKeyHandler(h: (e: KeyboardEvent, sessionId: string) => boolean): void {
  keyHandler = h;
}

let linkHandler: ((uri: string, container: string) => void) | null = null;

/**
 * 注册终端链接点击处理（用于把容器内 localhost 链接转到预览窗格）；未注册时用系统浏览器打开。
 * @param h 处理函数：uri 链接，container 终端所属容器
 * @returns 无
 */
export function setLinkHandler(h: (uri: string, container: string) => void): void {
  linkHandler = h;
}

/**
 * 由设置生成 xterm 选项。
 * @param s 终端设置
 * @returns xterm 选项
 */
export function termOptions(s: TerminalSettings, wallpaper?: WallpaperSettings | null): ITerminalOptions {
  if (wallpaper === undefined) {
    const state = useUiStore.getState();
    wallpaper = state.wallpaperReady ? state.wallpaperPreview ?? state.settings.wallpaper : null;
  }
  return {
    allowProposedApi: true,
    // This option must be enabled at creation, including terminals opened before a wallpaper is selected.
    allowTransparency: true,
    fontFamily: fontStack(s.fontFamily),
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    cursorStyle: s.cursorStyle,
    cursorBlink: s.cursorBlink,
    cursorInactiveStyle: "outline",
    scrollback: s.scrollback,
    theme: terminalThemeWithWallpaper(themeById(s.theme).theme, wallpaper),
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1,
    rightClickSelectsWord: false,
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    smoothScrollDuration: 0,
  };
}

/**
 * 打开链接：Tauri 中用系统浏览器，浏览器演示模式中用新窗口。
 * @param url 链接
 * @returns 无
 */
export function openExternal(url: string): void {
  if (isTauri()) void openUrl(url);
  else window.open(url, "_blank", "noopener");
}

/**
 * 加载 WebGL 渲染器（上下文丢失时自动回退到 DOM 渲染）。
 * @param p 池条目
 * @returns 无
 */
function loadWebgl(p: PooledTerm): void {
  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => {
      gl.dispose();
      p.webgl = null;
    });
    p.term.loadAddon(gl);
    p.webgl = gl;
  } catch {
    p.webgl = null;
  }
}

/**
 * OSC 52 剪贴板：tmux copy-mode 发出的空选区也写入系统剪贴板（默认实现只认 "c"，会把它丢掉）；
 * 读取一律返回空，防止容器内程序经 OSC 52 静默读取宿主剪贴板。
 */
const oscClipboard: IClipboardProvider = {
  readText: () => "",
  writeText: (selection, text) => {
    if (oscWritesClipboard(selection) && text) return navigator.clipboard.writeText(text).catch(() => undefined);
  },
};

/**
 * 粘贴图片：写入会话所在容器的 /tmp，再把容器内路径以括号粘贴送入终端，Claude Code 会把它识别为图片附件。
 * @param sessionId 会话 ID
 * @param image 图片数据
 * @param mime 图片 MIME 类型
 * @returns Promise（失败时提示，不抛出）
 */
async function pasteImage(sessionId: string, image: Blob, mime: string): Promise<void> {
  const p = pool.get(sessionId);
  if (!p) return;
  if (!isTauri()) {
    useUiStore.getState().toast("info", "演示模式不支持粘贴图片");
    return;
  }
  try {
    const path = await termPasteImage(sessionId, mime, new Uint8Array(await image.arrayBuffer()));
    p.term.paste(path);
  } catch (e) {
    useUiStore.getState().toast("error", `粘贴图片失败：${errorText(e)}`);
  }
}

/**
 * 原生粘贴事件（Ctrl+V / 右键菜单）的捕获阶段处理：剪贴板只有图片时接管，文本交给 xterm 自身的粘贴（含括号粘贴）。
 * @param e 粘贴事件
 * @param sessionId 会话 ID
 * @returns 无
 */
function onNativePaste(e: ClipboardEvent, sessionId: string): void {
  const data = e.clipboardData;
  if (!data) return;
  const items = Array.from(data.items);
  const pick = choosePaste(data.getData("text/plain"), items.map((i) => i.type));
  if (pick?.kind !== "image") return;
  e.preventDefault();
  e.stopPropagation();
  const file = items.find((i) => i.kind === "file" && i.type === pick.mime)?.getAsFile();
  if (file) void pasteImage(sessionId, file, pick.mime);
}

/**
 * 从系统剪贴板粘贴到会话（Ctrl+Shift+V 与 UI 焦点下的粘贴快捷键）：优先文本，没有文本时粘贴图片。
 * @param sessionId 会话 ID
 * @returns Promise（失败时提示，不抛出）
 */
export async function pasteClipboard(sessionId: string): Promise<void> {
  const p = pool.get(sessionId);
  if (!p) return;
  try {
    const items = await navigator.clipboard.read();
    const textItem = items.find((i) => i.types.includes("text/plain"));
    const text = textItem ? await (await textItem.getType("text/plain")).text() : "";
    const pick = choosePaste(text, items.flatMap((i) => i.types));
    if (pick?.kind === "text") p.term.paste(text);
    else if (pick?.kind === "image") {
      const item = items.find((i) => i.types.includes(pick.mime));
      if (item) await pasteImage(sessionId, await item.getType(pick.mime), pick.mime);
    } else if (items.length > 0) {
      useUiStore.getState().toast("info", `剪贴板中没有可粘贴的内容（支持文本与 ${PASTE_IMAGE_TYPES.map((t) => t.slice(6)).join(" / ")} 图片）`);
    }
  } catch (e) {
    useUiStore.getState().toast("error", `读取剪贴板失败：${errorText(e)}`);
  }
}

/**
 * 获取或创建会话的终端实例。
 * @param sessionId 会话 ID
 * @param settings 终端设置
 * @param meta 会话标题与容器（演示模式欢迎文本用）
 * @returns 池条目
 */
export function acquire(sessionId: string, settings: TerminalSettings, meta: { title: string; container: string }): PooledTerm {
  const existing = pool.get(sessionId);
  if (existing) return existing;

  const host = document.createElement("div");
  host.className = "h-full w-full";
  const term = new Terminal(termOptions(settings));
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(new WebLinksAddon((_e, uri) => (linkHandler ? linkHandler(uri, meta.container) : openExternal(uri))));
  // OSC 52：tmux copy-mode / 容器内程序写剪贴板
  term.loadAddon(new ClipboardAddon(undefined, oscClipboard));
  term.open(host);
  // 捕获阶段先于 xterm 自身的 paste 监听，用于接管图片粘贴
  host.addEventListener("paste", (e) => onNativePaste(e, sessionId), true);

  const sizeSync = createTerminalSizeSync(
    (cols, rows) => termResize(sessionId, cols, rows),
    (error) => useUiStore.getState().toast("error", `终端尺寸同步失败：${errorText(error)}`),
  );
  const p: PooledTerm = { term, fit, search, host, webgl: null, attached: false, sizeSync };
  if (settings.webgl) loadWebgl(p);

  term.attachCustomKeyEventHandler((e) => (keyHandler ? keyHandler(e, sessionId) : true));

  if (isTauri()) {
    term.onData((d) => void termWrite(sessionId, d).catch(() => undefined));
    term.onBinary((d) => void termWrite(sessionId, d).catch(() => undefined));
  } else {
    term.write(demoBanner(meta.title, meta.container));
    term.write("\x1b[38;2;86;182;194mnode@" + meta.container + "\x1b[0m:\x1b[38;2;97;175;239m/workspace/app\x1b[0m $ ");
    term.onData((d) => term.write(d === "\r" ? "\r\n$ " : d === "\x7f" ? "\b \b" : d));
  }
  pool.set(sessionId, p);
  return p;
}

/**
 * 附着后端输出（每个会话只附着一次；切 Tab 不解除）。
 * @param sessionId 会话 ID
 * @param onExit 会话结束回调
 * @returns Promise
 */
export async function attach(sessionId: string, onExit: (code: number | null) => void): Promise<void> {
  const p = pool.get(sessionId);
  if (!p || p.attached || !isTauri()) return;
  // 新终端先按挂载位置适配，避免以 xterm 默认 80x24 回放其他尺寸的输出。
  fitNow(sessionId);
  p.attached = true;
  let first = true;
  try {
    await termAttach(sessionId, (m) => {
      if (m.kind === "snapshot") {
        if (first) p.term.reset();
        first = false;
        p.term.write(m.data);
      } else if (m.kind === "data") {
        p.term.write(m.data);
      } else {
        p.term.write(`\r\n\x1b[38;2;110;118;129m[会话已结束${m.code === null ? "" : `，退出码 ${m.code}`}]\x1b[0m\r\n`);
        onExit(m.code);
      }
    });
  } catch (e) {
    p.attached = false;
    throw e;
  }
}

/**
 * 按容器尺寸重新计算行列并同步后端。
 * @param sessionId 会话 ID
 * @returns 无
 */
function fitNow(sessionId: string): void {
  const p = pool.get(sessionId);
  if (!p || !p.host.isConnected || p.host.clientWidth < 20 || p.host.clientHeight < 20) return;
  try {
    p.fit.fit();
  } catch {
    return;
  }
  if (isTauri()) p.sizeSync.request(p.term.cols, p.term.rows);
}

/** 合并连续尺寸变化，布局稳定后适配。 */
export function fitSession(sessionId: string): void {
  resizeScheduler.request(sessionId);
}

/** 暂停分屏内终端重排；调用返回函数后按最终尺寸适配。 */
export function beginTerminalResize(sessionIds: string[]): () => void {
  return resizeScheduler.hold(sessionIds);
}

/** 取消组件卸载前尚未执行的尺寸更新。 */
export function cancelSessionFit(sessionId: string): void {
  resizeScheduler.cancel(sessionId);
}

/**
 * 读取会话当前尺寸（新开会话时作为初始尺寸）。
 * @param sessionId 会话 ID
 * @returns 行列；不存在时返回默认 120x32
 */
export function sizeOf(sessionId: string | null | undefined): { cols: number; rows: number } {
  const p = sessionId ? pool.get(sessionId) : undefined;
  return p ? { cols: p.term.cols, rows: p.term.rows } : { cols: 120, rows: 32 };
}

/**
 * 取池条目。
 * @param sessionId 会话 ID
 * @returns 条目或 undefined
 */
export function get(sessionId: string): PooledTerm | undefined {
  return pool.get(sessionId);
}

/**
 * 销毁会话终端。
 * @param sessionId 会话 ID
 * @returns 无
 */
export function dispose(sessionId: string): void {
  cancelSessionFit(sessionId);
  const p = pool.get(sessionId);
  if (!p) return;
  p.sizeSync.dispose();
  p.webgl?.dispose();
  p.term.dispose();
  p.host.remove();
  pool.delete(sessionId);
}

/**
 * 把新设置应用到全部终端（设置弹框实时预览 / 保存后调用）。
 * @param s 终端设置
 * @returns 无
 */
export function applySettings(s: TerminalSettings, wallpaper?: WallpaperSettings | null): void {
  const opts = termOptions(s, wallpaper);
  for (const [id, p] of pool) {
    p.term.options.fontFamily = opts.fontFamily;
    p.term.options.fontSize = opts.fontSize;
    p.term.options.lineHeight = opts.lineHeight;
    p.term.options.cursorStyle = opts.cursorStyle;
    p.term.options.cursorBlink = opts.cursorBlink;
    p.term.options.theme = opts.theme;
    if (s.webgl && !p.webgl) loadWebgl(p);
    if (!s.webgl && p.webgl) {
      p.webgl.dispose();
      p.webgl = null;
    }
    fitSession(id);
  }
}
