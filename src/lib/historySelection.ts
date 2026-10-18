import type { Terminal } from "@xterm/xterm";

/**
 * xterm 6 的鼠标协议会关闭本地拖选。经典 tmux 终端（含实时底部）走原生强制选择，
 * 保留双击/跨行/宽字符选择，且不发送 tmux MouseDragEnd（会退出 copy-mode）。
 * 私有接口只封装在这里；不改变程序请求的鼠标模式，卸载时恢复。
 */
export function bindHistorySelection(term: Terminal, enabled: () => boolean): () => void {
  const service = (term as unknown as {
    _core?: { _selectionService?: { shouldForceSelection(event: MouseEvent): boolean } };
  })._core?._selectionService;
  if (!service?.shouldForceSelection) return () => {};
  const original = service.shouldForceSelection;
  const force = function (this: typeof service, event: MouseEvent) {
    return (event.button === 0 && enabled()) || original.call(this, event);
  };
  service.shouldForceSelection = force;
  // 1003 模式把悬停也当作输入，会在松手后的轻微移动时清空刚完成的本地选区。
  // 按住鼠标的移动继续交给 xterm 的 document 选择监听，键盘/粘贴仍正常清理选区。
  const host = term.element;
  const onHover = (event: MouseEvent) => {
    if (!event.buttons && enabled() && term.hasSelection()) event.stopPropagation();
  };
  host?.addEventListener("mousemove", onHover, true);
  return () => {
    host?.removeEventListener("mousemove", onHover, true);
    if (service.shouldForceSelection === force) service.shouldForceSelection = original;
  };
}
