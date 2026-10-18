/**
 * 分屏树：Tab 内的终端布局（Windows Terminal 模型）。纯函数，不持有状态。
 *
 * 叶子 = 一个终端会话或预览窗格（ID 以 pv: 开头）；分支 = 左右（row）或上下（column）切分，ratio 为第一个子节点占比。
 */

/** 叶子节点 */
export interface LeafNode {
  type: "leaf";
  /** 节点 ID */
  id: string;
  /** 会话 ID */
  sessionId: string;
}

/** 分支节点 */
export interface SplitNode {
  type: "split";
  id: string;
  /** row = 左右并排；column = 上下堆叠 */
  direction: "row" | "column";
  /** 第一个子节点占比 0.1~0.9 */
  ratio: number;
  children: [PaneNode, PaneNode];
}

/** 分屏树节点 */
export type PaneNode = LeafNode | SplitNode;

let counter = 0;

/**
 * 生成节点 ID。
 * @returns 递增 ID
 */
export function nodeId(): string {
  counter += 1;
  return `p${Date.now().toString(36)}${counter}`;
}

/**
 * 创建叶子。
 * @param sessionId 会话 ID
 * @returns 叶子节点
 */
export function leaf(sessionId: string): LeafNode {
  return { type: "leaf", id: nodeId(), sessionId };
}

/**
 * 前序遍历所有叶子。
 * @param node 根节点
 * @returns 叶子列表（从左上到右下）
 */
export function leaves(node: PaneNode): LeafNode[] {
  return node.type === "leaf" ? [node] : [...leaves(node.children[0]), ...leaves(node.children[1])];
}

/**
 * 查找包含指定会话的叶子。
 * @param node 根节点
 * @param sessionId 会话 ID
 * @returns 叶子或 undefined
 */
export function findLeaf(node: PaneNode, sessionId: string): LeafNode | undefined {
  return leaves(node).find((l) => l.sessionId === sessionId);
}

/**
 * 把目标叶子切分为两个，新会话放在第二个位置。
 * @param node 根节点
 * @param targetSessionId 被切分的会话
 * @param newSessionId 新会话
 * @param direction 切分方向
 * @returns 新的根节点（目标不存在时原样返回）
 */
export function split(node: PaneNode, targetSessionId: string, newSessionId: string, direction: "row" | "column"): PaneNode {
  if (node.type === "leaf") {
    if (node.sessionId !== targetSessionId) return node;
    return { type: "split", id: nodeId(), direction, ratio: 0.5, children: [node, leaf(newSessionId)] };
  }
  const [a, b] = node.children;
  const na = split(a, targetSessionId, newSessionId, direction);
  const nb = na === a ? split(b, targetSessionId, newSessionId, direction) : b;
  return na === a && nb === b ? node : { ...node, children: [na, nb] };
}

/**
 * 移除会话所在叶子，兄弟节点上提。
 * @param node 根节点
 * @param sessionId 会话 ID
 * @returns 新的根节点；整棵树被移空时返回 null
 */
export function remove(node: PaneNode, sessionId: string): PaneNode | null {
  if (node.type === "leaf") return node.sessionId === sessionId ? null : node;
  const [a, b] = node.children;
  const na = remove(a, sessionId);
  const nb = remove(b, sessionId);
  if (na === null) return nb;
  if (nb === null) return na;
  return na === a && nb === b ? node : { ...node, children: [na, nb] };
}

/**
 * 替换叶子中的会话（热切换后原位替换）。
 * @param node 根节点
 * @param from 旧会话
 * @param to 新会话
 * @returns 新的根节点
 */
export function replaceSession(node: PaneNode, from: string, to: string): PaneNode {
  if (node.type === "leaf") return node.sessionId === from ? { ...node, sessionId: to } : node;
  const [a, b] = node.children;
  const na = replaceSession(a, from, to);
  const nb = replaceSession(b, from, to);
  return na === a && nb === b ? node : { ...node, children: [na, nb] };
}

/**
 * 设置分支比例。
 * @param node 根节点
 * @param splitId 分支 ID
 * @param ratio 新比例（会被夹到 0.1~0.9）
 * @returns 新的根节点
 */
export function setRatio(node: PaneNode, splitId: string, ratio: number): PaneNode {
  if (node.type === "leaf") return node;
  if (node.id === splitId) return { ...node, ratio: Math.min(0.9, Math.max(0.1, ratio)) };
  const [a, b] = node.children;
  const na = setRatio(a, splitId, ratio);
  const nb = setRatio(b, splitId, ratio);
  return na === a && nb === b ? node : { ...node, children: [na, nb] };
}

/**
 * 按方向寻找相邻会话（Alt+方向键切换焦点用）：取终端叶子序列中的前一个 / 后一个，跳过预览窗格。
 * @param node 根节点
 * @param sessionId 当前会话
 * @param delta -1 前一个，+1 后一个
 * @returns 目标会话 ID（循环）
 */
export function neighbor(node: PaneNode, sessionId: string, delta: 1 | -1): string {
  const ls = leaves(node).filter((l) => !isPreview(l.sessionId));
  const i = ls.findIndex((l) => l.sessionId === sessionId);
  if (i < 0 || ls.length === 0) return sessionId;
  return ls[(i + delta + ls.length) % ls.length].sessionId;
}

/** 预览窗格叶子的 ID 前缀 */
export const PREVIEW_PREFIX = "pv:";

/**
 * 叶子是否为预览窗格（预览不是终端会话，不会成为聚焦会话）。
 * @param id 叶子中的会话 ID
 * @returns 是否预览
 */
export function isPreview(id: string): boolean {
  return id.startsWith(PREVIEW_PREFIX);
}
