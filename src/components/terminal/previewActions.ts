/**
 * 预览窗格的打开动作：端口按钮与终端链接共用（依赖 store，不放在纯逻辑的 lib/preview.ts 中）。
 */
import { useFleetStore } from "../../store/fleetStore";
import { useTabStore } from "../../store/tabStore";
import { useUiStore } from "../../store/uiStore";
import { previewUrlOf, resolveContainerLink } from "../../lib/preview";
import { openExternal } from "./xtermPool";

/**
 * 在当前 Tab 的悬浮预览打开地址；没有任何标签页时退回系统浏览器。
 * @param container 预览所属容器
 * @param url 宿主可访问的地址
 * @returns 无
 */
export function openInPreview(container: string, url: string): void {
  if (!useTabStore.getState().openPreview(container, previewUrlOf(url))) openExternal(url);
}

/**
 * 终端链接点击：容器内本机链接按端口映射转到预览，其余交给系统浏览器。
 * @param uri 链接
 * @param container 终端所属容器
 * @returns 无
 */
export function handleTerminalLink(uri: string, container: string): void {
  const ports = useFleetStore.getState().fleet.entries.find((e) => e.container.name === container)?.ports ?? [];
  const target = resolveContainerLink(uri, ports);
  if (target.kind === "external") return openExternal(uri);
  if (target.kind === "unavailable") {
    return useUiStore.getState().toast("warning", `容器端口 ${target.port} 无法从宿主访问：${target.reason}`);
  }
  openInPreview(container, target.url);
}
