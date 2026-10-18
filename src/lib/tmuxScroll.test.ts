import { describe, expect, it, vi } from "vitest";
import type { ScrollbackState } from "../api/types";
import { createHistoryScrollQueue, historyOffsetAt, historyScrollbarGeometry } from "./tmuxScroll";

const state = (offsetRows = 0): ScrollbackState => ({ historyRows: 300, offsetRows, viewportRows: 30, inCopyMode: offsetRows > 0, available: true, alternateScreen: false });
function deferred() {
  let resolve!: (state: ScrollbackState) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ScrollbackState>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("tmux scroll queue", () => {
  it("查询在途时合并拖动，只发送最新位置，旧查询不覆盖滑块", async () => {
    const read = deferred();
    const write = deferred();
    const load = vi.fn().mockReturnValueOnce(read.promise).mockReturnValueOnce(write.promise);
    const publish = vi.fn();
    const queue = createHistoryScrollQueue(load, publish, vi.fn());
    queue.refresh();
    queue.scroll(100);
    queue.scroll(150);
    queue.refresh();
    expect(load.mock.calls).toEqual([[undefined]]);
    read.resolve(state());
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
    expect(load.mock.calls).toEqual([[undefined], [150]]);
    write.resolve(state(150));
    await Promise.resolve();
    expect(publish).toHaveBeenCalledExactlyOnceWith(state(150));
  });

  it("松手的最终位置排在进行中的请求之后，0 也不会被丢弃", async () => {
    const first = deferred();
    const last = deferred();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    const publish = vi.fn();
    const queue = createHistoryScrollQueue(load, publish, vi.fn());
    queue.scroll(200);
    queue.scroll(100);
    queue.scroll(0);
    first.resolve(state(200));
    await Promise.resolve();
    expect(load.mock.calls).toEqual([[200], [0]]);
    expect(publish).not.toHaveBeenCalled();
    last.resolve(state());
    await Promise.resolve();
    expect(publish).toHaveBeenCalledExactlyOnceWith(state());
  });

  it("卸载后不会发布迟到结果或发送队列中的操作", async () => {
    const read = deferred();
    const load = vi.fn(() => read.promise);
    const publish = vi.fn();
    const queue = createHistoryScrollQueue(load, publish, vi.fn());
    queue.refresh();
    queue.scroll(100);
    queue.dispose();
    read.resolve(state());
    await Promise.resolve();
    queue.refresh();
    queue.scroll(200);
    expect(load).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it("失败会报告操作类型并允许下次重试，不用空历史覆盖已有数据", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(state(20));
    const publish = vi.fn();
    const error = vi.fn();
    const queue = createHistoryScrollQueue(load, publish, error);
    queue.scroll(20);
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith(expect.any(Error), true);
    expect(publish).not.toHaveBeenCalled();
    queue.scroll(20);
    await Promise.resolve();
    expect(publish).toHaveBeenCalledWith(state(20));
  });
});

describe("tmux scrollbar geometry", () => {
  it("上下端对应最旧历史与实时输出，往返定位一致", () => {
    for (const offset of [0, 1, 100, 300]) {
      const g = historyScrollbarGeometry(400, state(offset));
      expect(historyOffsetAt(g.top, g.travel, 300)).toBe(offset);
      expect(g.thumb).toBeGreaterThanOrEqual(24);
    }
    expect(historyOffsetAt(-200, 300, 300)).toBe(300);
    expect(historyOffsetAt(1000, 300, 300)).toBe(0);
  });
  it("空历史及极小窗格不产生负尺寸或无穷值", () => {
    expect(historyScrollbarGeometry(10, state()).thumb).toBe(10);
    expect(historyScrollbarGeometry(400, { ...state(), historyRows: 0 }).top).toBe(0);
    expect(historyOffsetAt(20, 0, 300)).toBe(0);
    expect(historyScrollbarGeometry(720, { ...state(), historyRows: 63, viewportRows: 37 }).thumb).toBe(64);
  });
});
