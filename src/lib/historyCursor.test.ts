import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { bindHistoryCursor } from "./historyCursor";

function fixture(initiallyHidden = false) {
  const core = { isCursorHidden: initiallyHidden };
  const handlers = new Map<string, (params: (number | number[])[]) => boolean>();
  let parsed = () => {};
  const refresh = vi.fn();
  const dispose = vi.fn();
  const term = {
    _core: { coreService: core }, rows: 30, refresh,
    parser: { registerCsiHandler: (id: { final: string }, handler: (params: (number | number[])[]) => boolean) => { handlers.set(id.final, handler); return { dispose }; } },
    onWriteParsed: (handler: () => void) => { parsed = handler; return { dispose }; },
  } as unknown as Terminal;
  const guard = bindHistoryCursor(term);
  const output = (visible: boolean, params = [25]) => {
    expect(handlers.get(visible ? "h" : "l")!(params)).toBe(false);
    core.isCursorHidden = !visible; // xterm normally applies the complete sequence.
    parsed();
  };
  return { core, guard, output, refresh, dispose };
}

describe("history browsing cursor", () => {
  it("历史浏览期间隐藏 copy-mode 光标，不吞掉组合控制序列", () => {
    const f = fixture();
    f.guard.setHidden(true);
    f.output(true, [25, 1003]);
    expect(f.core.isCursorHidden).toBe(true);
    f.guard.setHidden(false);
    expect(f.core.isCursorHidden).toBe(false);
    expect(f.refresh).toHaveBeenCalledTimes(2);
  });
  it("程序本来隐藏光标时保持隐藏，释放历史保护不会强制显示", () => {
    const f = fixture(true);
    f.guard.setHidden(true);
    f.output(false);
    f.guard.setHidden(false);
    expect(f.core.isCursorHidden).toBe(true);
  });
  it("卸载后恢复当前请求状态并解除监听", () => {
    const f = fixture();
    f.guard.setHidden(true);
    f.output(true);
    f.guard.dispose();
    expect(f.core.isCursorHidden).toBe(false);
    expect(f.dispose).toHaveBeenCalledTimes(3);
  });
});
