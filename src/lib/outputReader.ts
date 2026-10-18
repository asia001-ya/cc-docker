import type { OutputItem, OutputSnapshot } from "../api/types";

export interface OutputReaderState {
  conversationId: string | null;
  revision: string | null;
  items: OutputItem[];
  selectedId: string | null;
  status: OutputSnapshot["status"];
  limited: boolean;
}
export const emptyOutputs = (): OutputReaderState => ({ conversationId: null, revision: null, items: [], selectedId: null, status: "waiting", limited: false });

/** An update must not change the document being read. Conversation switches clear the previous selection. */
export function mergeOutputs(previous: OutputReaderState, next: OutputSnapshot): OutputReaderState {
  if (next.items === null && next.conversationId === previous.conversationId) return previous;
  const items = next.items ?? [];
  const selectedId = next.conversationId === previous.conversationId && items.some(item => item.id === previous.selectedId)
    ? previous.selectedId : items[0]?.id ?? null;
  return { conversationId: next.conversationId, revision: next.revision, items, selectedId, status: next.status, limited: next.limited };
}

/** Rendering never fetches embedded images; links open only after an explicit click. */
export function outputLink(href: string | undefined): string | null {
  if (!href) return null;
  try { const url = new URL(href); return ["https:", "http:"].includes(url.protocol) ? url.href : null; } catch { return null; }
}
