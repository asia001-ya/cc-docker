export const SIDEBAR_DEFAULT_WIDTH = 380;
export const SIDEBAR_MIN_WIDTH = 260;
export const SIDEBAR_MAX_WIDTH = 640;

/** 窗口缩小时压缩侧栏，钉住时为终端保留空间。 */
export function sidebarWidthBounds(viewportWidth: number, pinned: boolean): { min: number; max: number } {
  const viewport = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 1440;
  const reserved = pinned ? Math.min(480, viewport / 2) : Math.min(24, viewport);
  const max = Math.min(SIDEBAR_MAX_WIDTH, Math.floor(viewport - reserved));
  return { min: Math.min(SIDEBAR_MIN_WIDTH, max), max };
}

export function clampSidebarWidth(width: number, bounds = { min: SIDEBAR_MIN_WIDTH, max: SIDEBAR_MAX_WIDTH }): number {
  const value = Number.isFinite(width) ? width : SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.max(bounds.min, Math.min(bounds.max, value)));
}
