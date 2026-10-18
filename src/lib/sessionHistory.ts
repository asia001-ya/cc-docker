import type { SessionSnapshot } from "../api/types";

export interface SessionHistoryItem {
  sessionId: string;
  title: string;
  cwd: string | null;
  project: string;
  updatedAt: number | null;
  updatedLabel: string;
  optionLabel: string;
}

function readableTitle(title: string | null | undefined): string {
  const clean = title?.replace(/\s+/g, " ").trim() ?? "";
  return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(clean) ? "" : clean;
}

function timestamp(value: number | null | undefined): number | null {
  return typeof value === "number" && value > 0 && Number.isFinite(new Date(value * 1000).getTime()) ? value : null;
}

function updatedLabel(value: number | null): string {
  if (value === null) return "时间未知";
  const date = new Date(value * 1000);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 按最近活动排列，用最新快照去重；缺失的标题和目录可从同一会话的旧快照补齐。 */
export function buildSessionHistory(sessions: readonly SessionSnapshot[]): SessionHistoryItem[] {
  const byId = new Map<string, SessionSnapshot>();
  const sorted = [...sessions].sort((a, b) => (timestamp(b.updated_at) ?? 0) - (timestamp(a.updated_at) ?? 0));
  for (const session of sorted) {
    const id = session.session_id?.trim();
    if (!id) continue;
    const title = readableTitle(session.title);
    const cwd = session.cwd?.trim() || null;
    const previous = byId.get(id);
    if (previous) {
      if (!previous.title && title) previous.title = title;
      if (!previous.cwd && cwd) previous.cwd = cwd;
    } else {
      byId.set(id, { ...session, session_id: id, title, cwd });
    }
  }
  return [...byId.values()].map((session) => {
    const cwd = session.cwd || null;
    const project = cwd ? cwd.split(/[\\/]+/).filter(Boolean).at(-1) ?? "根目录" : "未指定项目";
    const updatedAt = timestamp(session.updated_at);
    const time = updatedLabel(updatedAt);
    const title = session.title || `${project}的会话 · ${time}`;
    const titleChars = Array.from(title);
    const shortTitle = titleChars.length > 64 ? `${titleChars.slice(0, 64).join("")}…` : title;
    return {
      sessionId: session.session_id!, title, cwd, project, updatedAt, updatedLabel: time,
      optionLabel: session.title ? `${shortTitle} · ${project} · ${time}` : shortTitle,
    };
  });
}

/** 选择历史只补齐未手工编辑的字段；缺少历史目录时保留当前目录。 */
export function deriveHistorySelection(
  selected: SessionHistoryItem | undefined,
  current: { title: string; cwd: string; titleEdited: boolean; cwdEdited: boolean },
): { title: string; cwd: string } {
  return {
    title: selected && !current.titleEdited ? selected.title : current.title,
    cwd: selected?.cwd && !current.cwdEdited ? selected.cwd : current.cwd,
  };
}
