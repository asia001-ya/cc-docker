import "../assets/fonts/statusline.css";

/** Load the small meter face before xterm caches either glyph in its atlas. */
export const statuslineFontReady = typeof document === "undefined"
  ? Promise.resolve()
  : document.fonts.load('16px "TDC Statusline"', "■∖").then(() => undefined).catch(() => undefined);
