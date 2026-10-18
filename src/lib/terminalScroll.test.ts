import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { bindTerminalHistoryScroll } from "./terminalScroll";

function fixture() {
  const listeners = new Map<string, EventListener>();
  const host = {
    clientHeight: 400,
    querySelector: () => ({ getBoundingClientRect: () => ({ height: 400 }) }),
    addEventListener: (type: string, fn: EventListener) => listeners.set(type, fn),
    removeEventListener: (type: string, fn: EventListener) => { if (listeners.get(type) === fn) listeners.delete(type); },
  } as unknown as HTMLElement;
  const active = { type: "normal", viewportY: 80, baseY: 280 };
  const modes = { mouseTrackingMode: "any" };
  const options = { scrollSensitivity: 1, fastScrollSensitivity: 5 };
  const scrollLines = vi.fn((n: number) => { active.viewportY = Math.max(0, Math.min(active.baseY, active.viewportY + n)); });
  const term = { buffer: { active }, modes, rows: 20, options, scrollLines } as unknown as Terminal;
  const dispose = bindTerminalHistoryScroll(host, term);
  const fire = (type: string, values = {}) => {
    const event = { buttons: 0, deltaY: 0, deltaMode: 0, altKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...values };
    listeners.get(type)?.(event as unknown as Event);
    return event;
  };
  return { active, modes, options, scrollLines, fire, dispose, listeners };
}

describe("terminal history / application mouse routing", () => {
  it("1003 模式下拖动结束后的鼠标移动不再作为输入发送，持续输出也不夺走历史位置", () => {
    const f = fixture();
    expect(f.fire("mousemove").stopPropagation).toHaveBeenCalledOnce();
    f.active.baseY += 10;
    expect(f.fire("mousemove").stopPropagation).toHaveBeenCalledOnce();
    expect(f.active.viewportY).toBe(80);
  });

  it("历史区滚轮只移动本地视口，覆盖像素、行、页与快速滚动", () => {
    const f = fixture();
    const event = f.fire("wheel", { deltaY: -120 });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    f.fire("wheel", { deltaY: -3, deltaMode: 1 });
    f.fire("wheel", { deltaY: 1, deltaMode: 2 });
    f.fire("wheel", { deltaY: -20, altKey: true });
    expect(f.scrollLines.mock.calls).toEqual([[-6], [-3], [20], [-5]]);
  });

  it("累积触控板的小幅位移，反向时丢弃旧方向余量", () => {
    const f = fixture();
    f.fire("wheel", { deltaY: -8 });
    f.fire("wheel", { deltaY: -8 });
    expect(f.scrollLines).not.toHaveBeenCalled();
    f.fire("wheel", { deltaY: -8 });
    f.fire("wheel", { deltaY: 20 });
    expect(f.scrollLines.mock.calls).toEqual([[-1], [1]]);
  });

  it.each(["bottom", "alternate", "no mouse protocol"])("%s 保留 xterm / tmux 的原有鼠标与滚轮行为", (scenario) => {
    const f = fixture();
    if (scenario === "bottom") f.active.viewportY = f.active.baseY;
    if (scenario === "alternate") f.active.type = "alternate";
    if (scenario === "no mouse protocol") f.modes.mouseTrackingMode = "none";
    expect(f.fire("mousemove").stopPropagation).not.toHaveBeenCalled();
    expect(f.fire("wheel", { deltaY: -120 }).preventDefault).not.toHaveBeenCalled();
    expect(f.scrollLines).not.toHaveBeenCalled();
  });

  it("到达底部后恢复程序滚轮，鼠标按住拖动和键盘输入不被拦截", () => {
    const f = fixture();
    expect(f.fire("mousemove", { buttons: 1 }).stopPropagation).not.toHaveBeenCalled();
    expect(f.listeners.has("keydown")).toBe(false);
    f.fire("wheel", { deltaY: 1000, deltaMode: 1 });
    expect(f.active.viewportY).toBe(280);
    expect(f.fire("wheel", { deltaY: 3, deltaMode: 1 }).stopPropagation).not.toHaveBeenCalled();
  });

  it("卸载时移除捕获监听，复用终端不会累积处理器", () => {
    const f = fixture();
    f.dispose();
    expect(f.listeners.size).toBe(0);
  });
});
