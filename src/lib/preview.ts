/**
 * 预览窗格的纯逻辑：把容器内的本机链接换成宿主可访问的地址、规范化地址栏输入。
 */
import type { PortLink } from "../api/types";

/** 容器内表示"本机"的主机名（URL 解析后的形式） */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"]);

/** 链接转换结果 */
export type LinkTarget =
  /** 可访问：在预览中打开宿主地址 */
  | { kind: "mapped"; url: string }
  /** 本机端口无法从宿主访问（未映射 / 仅监听回环 / 未在监听） */
  | { kind: "unavailable"; port: number; reason: string }
  /** 非本机链接：交给系统浏览器 */
  | { kind: "external" };

/**
 * 把终端里出现的链接按容器端口映射转换。容器内的 localhost:3000 在宿主上对应 127.0.0.1:<宿主端口>。
 * @param uri 终端中的链接
 * @param ports 该容器正在监听的端口（来自 fleet 轮询，与后端 ports::build_links 一致）
 * @returns 转换结果
 */
export function resolveContainerLink(uri: string, ports: PortLink[]): LinkTarget {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return { kind: "external" };
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !LOCAL_HOSTS.has(u.hostname)) return { kind: "external" };
  const containerPort = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  const link = ports.find((p) => p.containerPort === containerPort);
  if (!link) return { kind: "unavailable", port: containerPort, reason: "容器内暂未检测到该端口在监听（每 3 秒刷新）" };
  if (!link.url || !link.hostPort) return { kind: "unavailable", port: containerPort, reason: link.hint ?? "无法从宿主访问" };
  u.hostname = "127.0.0.1";
  u.port = String(link.hostPort);
  return { kind: "mapped", url: u.toString() };
}

/**
 * 规范化地址栏输入：省略协议时补 http://，只接受 http / https。
 * @param input 用户输入
 * @returns 规范化后的地址；不合法返回 null
 */
export function normalizePreviewUrl(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/]+:\d/.test(s) ? s : `http://${s}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * 把端口列表中的 localhost 地址统一为 127.0.0.1（避免宿主解析 localhost 时优先走 IPv6 而映射只绑定了 IPv4）。
 * @param url 端口链接中的地址
 * @returns 预览使用的地址
 */
export function previewUrlOf(url: string): string {
  return url.replace(/^http:\/\/localhost(?=[:/]|$)/, "http://127.0.0.1");
}
