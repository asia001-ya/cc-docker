import type { Terminal } from "@xterm/xterm";

/**
 * tmux copy-mode 会把终端光标放到历史正文中。浏览历史时只隐藏显示光标，
 * 保留键盘焦点、输入和程序请求的可见状态，回到底部恢复。
 * xterm 6 没有公开的 cursorVisible setter；把这个版本依赖集中在此处。
 * 不向终端写入额外控制序列，避免与真实输出及光标查询响应交错。
 */
export function bindHistoryCursor(term: Terminal) {
  const core = (term as unknown as { _core?: { coreService?: { isCursorHidden: boolean } } })._core?.coreService;
  if (!core) return { setHidden: (_hidden: boolean) => {}, dispose: () => {} };
  let hidden = false;
  let requestedHidden = core.isCursorHidden;
  const show = term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
    if (params.includes(25)) requestedHidden = false;
    return false;
  });
  const hide = term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    if (params.includes(25)) requestedHidden = true;
    return false;
  });
  // 在输出解析结束、下一帧绘制之前覆盖 copy-mode 的光标显示，不改缓冲或光标坐标。
  const parsed = term.onWriteParsed(() => {
    if (hidden) core.isCursorHidden = true;
  });
  const setHidden = (next: boolean) => {
    if (hidden === next) return;
    if (next) requestedHidden = core.isCursorHidden;
    hidden = next;
    core.isCursorHidden = next || requestedHidden;
    term.refresh(0, term.rows - 1);
  };
  return {
    setHidden,
    dispose() {
      setHidden(false);
      show.dispose(); hide.dispose(); parsed.dispose();
    },
  };
}
