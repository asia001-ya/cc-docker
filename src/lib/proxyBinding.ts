import type { ProxyBinding, ProxyEngine, ProxyNodeView } from "../api/types";

export const EMPTY_PROXY_BINDING: ProxyBinding = {
  enabled: false, nodeId: null, staticId: null, exitId: null, allowLan: false, selected: null,
};

/**
 * 链路使用的内核：由主节点决定，静态中转与出口跟随主节点。
 * @param binding 绑定
 * @param nodes 节点库
 * @returns 内核；未选节点时为 mihomo
 */
export function proxyBindingEngine(binding: ProxyBinding, nodes: ProxyNodeView[]): ProxyEngine {
  return nodes.find((n) => n.id === binding.nodeId)?.engine ?? "mihomo";
}

/** 切换主节点时，清掉重复跳点和旧订阅的选中项。 */
export function patchProxyBinding(binding: ProxyBinding, patch: Partial<ProxyBinding>): ProxyBinding {
  const next = { ...binding, ...patch };
  if (patch.nodeId !== undefined) {
    if (next.staticId === next.nodeId) next.staticId = null;
    if (next.exitId === next.nodeId) next.exitId = null;
    if (next.nodeId !== binding.nodeId) next.selected = null;
  }
  return next;
}

export function proxyBindingError(binding: ProxyBinding, nodes: ProxyNodeView[]): string | null {
  if (!binding.enabled) return null;
  if (!binding.nodeId) return "开启代理必须选择节点";
  const node = nodes.find((n) => n.id === binding.nodeId);
  if (!node) return "所选代理节点已不存在，请重新选择";
  const relay = nodes.find((n) => n.id === binding.staticId);
  const exit = nodes.find((n) => n.id === binding.exitId);
  if (binding.staticId && (!relay || relay.kind !== "vless" || relay.id === node.id)) return "请重新选择静态中转：必须是不同于主节点的 vless 节点";
  if (binding.exitId && (!exit || exit.kind !== "socks5" || exit.id === node.id)) return "请重新选择出口：必须是不同于主节点的 SOCKS5 节点";
  if ([node, relay, exit].some((n) => n && !n.hasSecret)) return "所选节点缺少地址，请在管理节点中补充";
  return null;
}
