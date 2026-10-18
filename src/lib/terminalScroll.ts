import type { Terminal } from "@xterm/xterm";

/**
 * 本地回滚与程序鼠标协议的边界。xterm 把 SGR 鼠标移动也视为用户输入，
 * Claude 的 1003 模式因此会在滑块松手后触发 scrollOnUserInput 并回到底部。
 * 查看历史时屏蔽无按键移动、就地处理滚轮；底部及备用屏幕仍由程序处理。
 */
export function bindTerminalHistoryScroll(host: HTMLElement, term: Terminal): () => void {
  let remainder = 0;
  const browsingHistory = () => {
    const buffer = term.buffer.active;
    return buffer.type === "normal" && buffer.viewportY < buffer.baseY && term.modes.mouseTrackingMode !== "none";
  };
  const onMouseMove = (event: MouseEvent) => {
    if (event.buttons === 0 && browsingHistory()) event.stopPropagation();
  };
  const onWheel = (event: WheelEvent) => {
    if (!browsingHistory()) {
      remainder = 0;
      return;
    }
    // 必须在 xterm 的 wheel 监听之前消费，否则程序和本地视口会同时滚动。
    event.preventDefault();
    event.stopPropagation();
    if (event.deltaY === 0) return;
    const screenHeight = host.querySelector(".xterm-screen")?.getBoundingClientRect().height ?? host.clientHeight;
    const cellHeight = screenHeight / term.rows;
    if (cellHeight <= 0) return;
    const unit = event.deltaMode === 1 ? 1 : event.deltaMode === 2 ? term.rows : 1 / cellHeight;
    const sensitivity = (term.options.scrollSensitivity ?? 1) * (event.altKey ? term.options.fastScrollSensitivity ?? 5 : 1);
    const delta = event.deltaY * unit * sensitivity;
    if (delta * remainder < 0) remainder = 0;
    remainder += delta;
    const lines = Math.trunc(remainder);
    remainder -= lines;
    if (lines !== 0) term.scrollLines(lines);
  };

  host.addEventListener("mousemove", onMouseMove, true);
  host.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => {
    host.removeEventListener("mousemove", onMouseMove, true);
    host.removeEventListener("wheel", onWheel, true);
  };
}
