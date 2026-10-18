import type { ScrollbackState } from "../api/types";

/** 固定命中宽度、最小滑块高度；offset 从底部向上计数。 */
export function historyScrollbarGeometry(height: number, state: ScrollbackState) {
  if (state.historyRows <= 0) return { thumb: height, travel: 0, top: 0 };
  const thumb = Math.min(height, Math.max(24, Math.min(64, height * state.viewportRows / (state.historyRows + state.viewportRows))));
  const travel = Math.max(0, height - thumb);
  const top = state.historyRows > 0 ? travel * (1 - state.offsetRows / state.historyRows) : 0;
  return { thumb, travel, top };
}

export function historyOffsetAt(top: number, travel: number, historyRows: number): number {
  return travel <= 0 ? 0 : Math.round(historyRows * (1 - Math.max(0, Math.min(1, top / travel))));
}

/** 合并拖动中的历史请求；每个会话最多一个请求在途，旧查询不覆盖较新的拖动位置。 */
export function createHistoryScrollQueue(
  load: (offset?: number) => Promise<ScrollbackState>,
  onState: (state: ScrollbackState) => void,
  onError: (error: unknown, writing: boolean) => void,
) {
  let pending: number | undefined;
  let reading = false;
  let running = false;
  let disposed = false;

  const flush = async () => {
    if (running || disposed) return;
    running = true;
    try {
      while (!disposed && (pending !== undefined || reading)) {
        const offset = pending;
        pending = undefined;
        reading = false;
        try {
          const state = await load(offset);
          if (!disposed && pending === undefined) onState(state);
        } catch (error) {
          if (!disposed) onError(error, offset !== undefined);
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    scroll(offset: number) {
      if (disposed) return;
      pending = Math.max(0, Math.round(offset));
      void flush();
    },
    refresh() {
      if (disposed || running) return;
      reading = true;
      void flush();
    },
    dispose() { disposed = true; pending = undefined; },
  };
}
