import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalResizeScheduler, createTerminalSizeSync } from "./terminalResize";

describe("terminal resize scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("合并观察器、挂载与聚焦产生的重复请求，只读取最终尺寸", () => {
    let width = 800;
    const fit = vi.fn(() => width);
    const scheduler = createTerminalResizeScheduler(fit, 0);
    scheduler.request("a");
    width = 600;
    scheduler.request("a");
    scheduler.request("b");
    width = 500;
    expect(fit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16);
    expect(fit.mock.calls).toEqual([["a"], ["b"]]);
    expect(fit.mock.results.map((r) => r.value)).toEqual([500, 500]);
  });

  it("拖动时保留画布，松手后只重排一次；未参与拖动的终端仍可适配", () => {
    const fit = vi.fn();
    const scheduler = createTerminalResizeScheduler(fit, 0);
    scheduler.request("a");
    const release = scheduler.hold(["a", "a"]);
    for (let i = 0; i < 20; i++) {
      scheduler.request("a");
      vi.advanceTimersByTime(16);
    }
    expect(fit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    scheduler.request("b");
    vi.advanceTimersByTime(16);
    expect(fit.mock.calls).toEqual([["b"]]);
    release();
    release();
    vi.advanceTimersByTime(16);
    expect(fit.mock.calls).toEqual([["b"], ["a"]]);
  });

  it("交叠拖动全部结束后才适配，取消或失去指针捕获的释放可以重复调用", () => {
    const fit = vi.fn();
    const scheduler = createTerminalResizeScheduler(fit, 0);
    const outer = scheduler.hold(["a", "b"]);
    const inner = scheduler.hold(["a"]);
    inner();
    vi.advanceTimersByTime(16);
    expect(fit).not.toHaveBeenCalled();
    outer();
    vi.advanceTimersByTime(16);
    expect(fit.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("卸载或销毁后不再适配旧 DOM，重新挂载可重新请求", () => {
    const fit = vi.fn();
    const scheduler = createTerminalResizeScheduler(fit, 0);
    const release = scheduler.hold(["a"]);
    scheduler.cancel("a");
    release();
    vi.advanceTimersByTime(16);
    expect(fit).not.toHaveBeenCalled();
    scheduler.request("a");
    scheduler.cancel("a");
    expect(vi.getTimerCount()).toBe(0);
    scheduler.request("a");
    vi.advanceTimersByTime(16);
    expect(fit).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("原生窗口连续缩放不逐帧触发重绘，其他会话独立等待布局稳定", () => {
    let width = 163;
    const fit = vi.fn(() => width);
    const scheduler = createTerminalResizeScheduler(fit);
    scheduler.request("b");
    for (let i = 0; i < 20; i++) {
      width--;
      scheduler.request("a");
      vi.advanceTimersByTime(16);
    }
    expect(fit.mock.calls).toEqual([["b"]]);
    width = 100;
    scheduler.request("a");
    vi.advanceTimersByTime(135);
    expect(fit.mock.calls).toEqual([["b"]]);
    vi.advanceTimersByTime(1);
    expect(fit.mock.calls).toEqual([["b"], ["a"]]);
    expect(fit.mock.results[1].value).toBe(100);
    scheduler.request("a");
    scheduler.cancel("a");
    vi.advanceTimersByTime(200);
    expect(fit).toHaveBeenCalledTimes(2);
  });
});

describe("terminal size synchronization", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };

  it("慢请求期间只保留最终尺寸，不能让旧请求最后完成并覆盖新尺寸", async () => {
    const first = deferred();
    const send = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const sync = createTerminalSizeSync(send, vi.fn());
    sync.request(163, 37);
    sync.request(90, 30);
    sync.request(110, 32);
    expect(send.mock.calls).toEqual([[163, 37]]);
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls).toEqual([[163, 37], [110, 32]]);
    sync.request(110, 32);
    expect(send).toHaveBeenCalledTimes(2);
    sync.dispose();
  });

  it("失败尺寸不能被误认为已同步；自动重试并在成功后去重", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValue(undefined);
    const error = vi.fn();
    const sync = createTerminalSizeSync(send, error);
    sync.request(120, 40);
    await vi.advanceTimersByTimeAsync(150);
    expect(send.mock.calls).toEqual([[120, 40], [120, 40]]);
    sync.request(120, 40);
    expect(send).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
    sync.dispose();
  });

  it("新尺寸替代失败尺寸的待重试请求，已在途的过期失败也不会重试旧值", async () => {
    const first = deferred();
    const send = vi.fn().mockReturnValueOnce(first.promise).mockRejectedValueOnce(new Error("retry")).mockResolvedValue(undefined);
    const error = vi.fn();
    const sync = createTerminalSizeSync(send, error);
    sync.request(80, 24);
    sync.request(100, 30);
    first.reject(new Error("obsolete"));
    await vi.advanceTimersByTimeAsync(0);
    sync.request(163, 37);
    await vi.advanceTimersByTimeAsync(500);
    expect(send.mock.calls).toEqual([[80, 24], [100, 30], [163, 37]]);
    expect(error).not.toHaveBeenCalled();
    sync.dispose();
  });

  it("持续失败只报一次错误，下一次显式请求可恢复；销毁后取消重试", async () => {
    const send = vi.fn().mockRejectedValue(new Error("offline"));
    const error = vi.fn();
    const sync = createTerminalSizeSync(send, error);
    sync.request(120, 40);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(1);
    send.mockResolvedValue(undefined);
    sync.request(120, 40);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(4);
    send.mockRejectedValue(new Error("offline"));
    sync.request(90, 30);
    await vi.advanceTimersByTimeAsync(0);
    sync.dispose();
    sync.request(100, 30);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(5);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("销毁时仍在途的请求结束后不发送排队尺寸", async () => {
    const first = deferred();
    const send = vi.fn(() => first.promise);
    const sync = createTerminalSizeSync(send, vi.fn());
    sync.request(80, 24);
    sync.request(163, 37);
    sync.dispose();
    first.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(send.mock.calls).toEqual([[80, 24]]);
  });
});
