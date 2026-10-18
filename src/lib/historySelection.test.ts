import type { Terminal } from "@xterm/xterm";
import { expect, it, vi } from "vitest";
import { bindHistorySelection } from "./historySelection";

it("经典终端本地拖选；切到全屏程序/卸载后恢复程序鼠标行为", () => {
  let enabled = true;
  const original = vi.fn((e: MouseEvent) => e.shiftKey);
  const service = { shouldForceSelection: original };
  const term = { _core: { _selectionService: service } } as unknown as Terminal;
  const unbind = bindHistorySelection(term, () => enabled);
  const mouse = (button = 0, shiftKey = false) => ({ button, shiftKey } as MouseEvent);
  expect(service.shouldForceSelection(mouse())).toBe(true);
  expect(service.shouldForceSelection(mouse(2))).toBe(false);
  enabled = false;
  expect(service.shouldForceSelection(mouse())).toBe(false);
  expect(service.shouldForceSelection(mouse(0, true))).toBe(true);
  unbind();
  expect(service.shouldForceSelection).toBe(original);
});

it("底部松手后的 1003 悬停不会清空选区，拖动与无选区时不拦截", () => {
  const listeners = new Map<string, (event: MouseEvent) => void>();
  let selected = true;
  let enabled = true;
  const host = {
    addEventListener: (type: string, handler: (event: MouseEvent) => void) => listeners.set(type, handler),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const term = { element: host, hasSelection: () => selected, _core: { _selectionService: { shouldForceSelection: () => false } } } as unknown as Terminal;
  const unbind = bindHistorySelection(term, () => enabled);
  const fire = (buttons: number) => {
    const event = { buttons, stopPropagation: vi.fn() };
    listeners.get("mousemove")!(event as unknown as MouseEvent);
    return event.stopPropagation;
  };
  expect(fire(0)).toHaveBeenCalledOnce();
  expect(fire(1)).not.toHaveBeenCalled();
  selected = false;
  expect(fire(0)).not.toHaveBeenCalled();
  selected = true; enabled = false;
  expect(fire(0)).not.toHaveBeenCalled();
  unbind();
  expect(listeners.size).toBe(0);
});

it("不支持内部接口时安全降级", () => {
  expect(() => bindHistorySelection({} as Terminal, () => true)()).not.toThrow();
});
