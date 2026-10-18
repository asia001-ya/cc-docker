/** 等布局稳定后再更新行列；包括原生窗口缩放和侧栏动画，不只分屏拖动。 */
export function createTerminalResizeScheduler(fit: (sessionId: string) => void, settleMs = 120) {
  const pending = new Set<string>();
  const holds = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let frame: number | null = null;
  const ready = (id: string) => !holds.has(id) && !timers.has(id);

  const schedule = () => {
    if (frame !== null || !Array.from(pending).some(ready)) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const ids = Array.from(pending).filter(ready);
      for (const id of ids) pending.delete(id);
      for (const id of ids) fit(id);
    });
  };

  const request = (sessionId: string) => {
    pending.add(sessionId);
    clearTimeout(timers.get(sessionId));
    timers.delete(sessionId);
    if (holds.has(sessionId)) return;
    if (settleMs === 0) { schedule(); return; }
    timers.set(sessionId, setTimeout(() => {
      timers.delete(sessionId);
      schedule();
    }, settleMs));
  };

  return {
    request,
    /** 暂停指定终端的重排，返回可重复调用的释放函数。 */
    hold(sessionIds: string[]) {
      const ids = Array.from(new Set(sessionIds));
      for (const id of ids) {
        holds.set(id, (holds.get(id) ?? 0) + 1);
        request(id);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const id of ids) {
          const count = (holds.get(id) ?? 1) - 1;
          if (count > 0) holds.set(id, count);
          else holds.delete(id);
        }
        for (const id of ids) if (pending.has(id)) request(id);
      };
    },
    /** 组件卸载 / 会话销毁时移除待处理尺寸，避免使用过期 DOM。 */
    cancel(sessionId: string) {
      pending.delete(sessionId);
      clearTimeout(timers.get(sessionId));
      timers.delete(sessionId);
      if (frame !== null && !Array.from(pending).some(ready)) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    },
  };
}

type Size = { cols: number; rows: number };
const sameSize = (a: Size | null, b: Size | null) => a?.cols === b?.cols && a?.rows === b?.rows;

/** 同一会话只允许一个 resize 在途；确认成功才去重，失败重试，期间仅保留最新尺寸。 */
export function createTerminalSizeSync(send: (cols: number, rows: number) => Promise<void>, onError: (error: unknown) => void) {
  let wanted: Size | null = null;
  let confirmed: Size | null = null;
  let inFlight = false;
  let disposed = false;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const flush = async () => {
    if (disposed || inFlight || retry !== undefined || !wanted || sameSize(wanted, confirmed)) return;
    const size = wanted;
    inFlight = true;
    try {
      await send(size.cols, size.rows);
      confirmed = size;
      failures = 0;
    } catch (error) {
      if (!disposed && sameSize(wanted, size)) {
        failures++;
        if (failures <= 2) {
          retry = setTimeout(() => { retry = undefined; void flush(); }, failures * 150);
        } else {
          onError(error);
        }
      }
    } finally {
      inFlight = false;
    }
    if (!disposed && failures < 3) void flush();
  };

  return {
    request(cols: number, rows: number) {
      if (disposed || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) return;
      const next = { cols, rows };
      if (!sameSize(wanted, next) || failures >= 3) {
        failures = 0;
        clearTimeout(retry);
        retry = undefined;
      }
      wanted = next;
      void flush();
    },
    dispose() {
      disposed = true;
      clearTimeout(retry);
      retry = undefined;
    },
  };
}
