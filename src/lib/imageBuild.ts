/** 镜像构建输出的纯函数：日志截断与步骤进度解析（经典构建器输出 "Step N/M : ..."）。 */

/** 前端保留的构建输出行数（与后端一致） */
export const BUILD_LOG_KEEP = 300;

/**
 * 追加一行构建输出，超出上限时丢弃最旧的行。
 * @param log 现有日志
 * @param line 新行
 * @returns 新日志
 */
export function appendBuildLog(log: string[], line: string): string[] {
  const next = [...log, line];
  return next.length > BUILD_LOG_KEEP ? next.slice(next.length - BUILD_LOG_KEEP) : next;
}

/**
 * 从日志中取最近的构建步骤。
 * @param log 构建日志
 * @returns 当前步骤与总步数；尚未开始执行步骤时为 null
 */
export function buildProgress(log: string[]): { step: number; total: number } | null {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const m = /^Step (\d+)\/(\d+) :/.exec(log[i]);
    if (m) return { step: Number(m[1]), total: Number(m[2]) };
  }
  return null;
}
