import type { FleetEntry, SessionRecord, SessionSnapshot } from "../api/types";
import { buildSessionHistory } from "./sessionHistory";

export interface SessionCatalogItem {
  key: string;
  kind: "open" | "history";
  container: string;
  title: string;
  cwd: string | null;
  project: string;
  updatedAt: number | null;
  updatedLabel: string;
  openSessionId: string | null;
  claudeSessionId: string | null;
  isActive: boolean;
  exited: boolean;
  containerRunning: boolean;
}

export interface SessionCatalogInput {
  entries: readonly FleetEntry[];
  sessions: Readonly<Record<string, SessionRecord>>;
  openSessionIds: readonly string[];
  exited: Readonly<Record<string, number | null>>;
  activeSessionId: string | null;
}

function timestamp(value: number | null | undefined): number | null {
  return typeof value === "number" && value > 0 && Number.isFinite(new Date(value * 1000).getTime()) ? value : null;
}

function hasExited(id: string, exited: Readonly<Record<string, number | null>>): boolean {
  return Object.prototype.hasOwnProperty.call(exited, id);
}

function latestSnapshot(record: SessionRecord, entry: FleetEntry | undefined): SessionSnapshot | undefined {
  let latest: SessionSnapshot | undefined;
  for (const snapshot of entry?.sessions ?? []) {
    if (snapshot.tdc_session_id !== record.id) continue;
    if (!latest || (timestamp(snapshot.updated_at) ?? 0) > (timestamp(latest.updated_at) ?? 0)) latest = snapshot;
  }
  return latest;
}

/** 只有没有当前终端快照时，才用启动参数推断最初恢复的会话。 */
function resumedId(record: SessionRecord): string | null {
  if (record.mode !== "claude") return null;
  let id: string | null = null;
  for (let index = 0; index < record.args.length; index++) {
    const arg = record.args[index];
    if (arg === "--") break;
    if (arg === "--resume") {
      const value = record.args[index + 1]?.trim();
      id = value && !value.startsWith("-") ? value : null;
      if (id) index++;
    } else if (arg.startsWith("--resume=")) {
      id = arg.slice("--resume=".length).trim() || null;
    }
  }
  return id;
}

function currentClaudeId(record: SessionRecord, snapshot: SessionSnapshot | undefined): string | null {
  // 即便最新快照的 ID 为空，也不能沿用旧 --resume 参数把已换过的会话认错。
  return snapshot ? snapshot.session_id?.trim() || null : resumedId(record);
}

/** 恢复前重新检查同容器历史是否已有未退出的终端承载，返回可聚焦的终端 ID。 */
export function findOpenSessionForHistory(
  container: string,
  claudeSessionId: string,
  sessions: Readonly<Record<string, SessionRecord>>,
  entries: readonly FleetEntry[],
  openSessionIds: readonly string[],
  exited: Readonly<Record<string, number | null>>,
): string | null {
  const requested = claudeSessionId.trim();
  if (!requested) return null;
  const entry = entries.find((candidate) => candidate.container.name === container);
  for (const id of openSessionIds) {
    const record = sessions[id];
    if (!record || record.container !== container || hasExited(id, exited)) continue;
    if (currentClaudeId(record, latestSnapshot(record, entry)) === requested) return id;
  }
  return null;
}

/** 打开的终端按标签页顺序在前；历史按容器内 ID 去重，再按最近活动排列。 */
export function buildSessionCatalog({ entries, sessions, openSessionIds, exited, activeSessionId }: SessionCatalogInput): SessionCatalogItem[] {
  const byContainer = new Map(entries.map((entry) => [entry.container.name, entry]));
  const histories = new Map(entries.map((entry) => [entry.container.name, buildSessionHistory(entry.sessions)]));
  const hosted = new Map<string, Set<string>>();
  const open: SessionCatalogItem[] = [];
  for (const id of new Set(openSessionIds)) {
    const record = sessions[id];
    if (!record) continue;
    const entry = byContainer.get(record.container);
    const snapshot = latestSnapshot(record, entry);
    const claudeSessionId = currentClaudeId(record, snapshot);
    const history = claudeSessionId ? histories.get(record.container)?.find((item) => item.sessionId === claudeSessionId) : undefined;
    const cwd = snapshot?.cwd?.trim() || history?.cwd || record.cwd.trim() || null;
    const updatedAt = timestamp(snapshot?.updated_at) ?? history?.updatedAt ?? timestamp(record.createdAt);
    const display = buildSessionHistory([{
      session_id: claudeSessionId ?? id,
      title: snapshot?.title,
      cwd,
      updated_at: updatedAt,
    }, ...(history ? [{ session_id: claudeSessionId, title: history.title, updated_at: 0 }] : [])])[0];
    const rawTitle = record.title.replace(/\s+/g, " ").trim();
    const namedDisplay = buildSessionHistory([{ session_id: id, title: rawTitle, cwd, updated_at: updatedAt }])[0];
    // 复用历史标题的可读性规则，UUID 等占位名称不能覆盖真实对话名。
    const terminalTitle = namedDisplay.title === rawTitle ? rawTitle : "";
    const defaultTitle = !terminalTitle || /^会话\s*#\s*\d+$/u.test(terminalTitle);
    const title = defaultTitle && (snapshot || history) ? display.title : terminalTitle || display.title;
    const isExited = hasExited(id, exited);
    if (claudeSessionId && !isExited) {
      if (!hosted.has(record.container)) hosted.set(record.container, new Set());
      hosted.get(record.container)!.add(claudeSessionId);
    }
    open.push({
      key: `open:${id}`, kind: "open", container: record.container, title, cwd,
      project: display.project, updatedAt, updatedLabel: display.updatedLabel,
      openSessionId: id, claudeSessionId, isActive: id === activeSessionId, exited: isExited,
      containerRunning: entry?.container.running ?? false,
    });
  }
  const history: SessionCatalogItem[] = [];
  for (const entry of entries) {
    const container = entry.container.name;
    for (const item of histories.get(container) ?? []) {
      if (hosted.get(container)?.has(item.sessionId)) continue;
      history.push({
        key: `history:${container}:${item.sessionId}`, kind: "history", container,
        title: item.title, cwd: item.cwd, project: item.project, updatedAt: item.updatedAt, updatedLabel: item.updatedLabel,
        openSessionId: null, claudeSessionId: item.sessionId, isActive: false, exited: false,
        containerRunning: entry.container.running,
      });
    }
  }
  history.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return [...open, ...history];
}

export interface SessionCatalogFilter {
  container?: string;
  query?: string;
  kind?: "all" | "open" | "history";
}

/** 按容器、类别及名称 / 项目 / 目录关键词过滤，保留目录原有排序。 */
export function filterSessionCatalog(items: readonly SessionCatalogItem[], { container, query, kind = "all" }: SessionCatalogFilter = {}): SessionCatalogItem[] {
  const words = query?.trim().toLowerCase().split(/\s+/u).filter(Boolean) ?? [];
  return items.filter((item) => {
    if (container && item.container !== container) return false;
    if (kind !== "all" && item.kind !== kind) return false;
    const searchable = [item.title, item.project, item.cwd, item.container, item.claudeSessionId].filter(Boolean).join(" ").toLowerCase();
    return words.every((word) => searchable.includes(word));
  });
}
