#!/usr/bin/env node
/**
 * 从 Claude 历史补充可读会话标题。只读取 projects 内的文件，每份 JSONL 最多读头尾各 64 KiB；
 * snapshot 每次启动独立进程也不会反复扫描整份长对话。所有历史读取失败均降级为 null。
 * 标题若仅出现在长日志中部且无 index，可回退为头部首条提问或 null，不为补标题全量扫描。
 */
import fs from "node:fs";
import path from "node:path";

const TRANSCRIPT_WINDOW_BYTES = 64 * 1024;
const INDEX_MAX_BYTES = 1024 * 1024;
const PROJECT_LIMIT = 512;
const TITLE_LENGTH = 48;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const COMMAND_WRAPPER = /<(?:command-name|command-message|command-args|local-command-stdout|bash-input|bash-stdout|bash-stderr)\b/i;
const METADATA_WRAPPER = /<(system-reminder|local-command-caveat|task-notification|teammate-message|ide_opened_file|ide_selection|environment_context|session-start-hook|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/gi;
const METADATA_START = /^\s*<(?:system-reminder|local-command-caveat|task-notification|teammate-message|ide_opened_file|ide_selection|environment_context|session-start-hook|user-prompt-submit-hook)\b/i;

/** 归一标题空白、去除终端控制字符，并按 Unicode 字符截断，不拆开代理对。 */
export function normalizeSessionTitle(value) {
  if (typeof value !== "string") return null;
  const title = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\s+/gu, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
  if (!title) return null;
  const chars = Array.from(title);
  return chars.length > TITLE_LENGTH ? `${chars.slice(0, TITLE_LENGTH - 1).join("")}…` : title;
}

/** 排除 Claude 的命令、工具和系统封装，只保留真实用户文本。 */
export function userMessageTitle(record) {
  if (!record || record.type !== "user" || record.isSidechain || record.isMeta || record.isCompactSummary || record.toolUseResult) return null;
  if (record.message?.role && record.message.role !== "user") return null;
  const content = record.message?.content;
  let text;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    if (content.some((block) => block?.type === "tool_result" || block?.type === "tool_use")) return null;
    text = content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join(" ");
  } else {
    return null;
  }
  if (COMMAND_WRAPPER.test(text)) return null;
  text = text.replace(METADATA_WRAPPER, " ").trim();
  if (METADATA_START.test(text) || /^\/(?:[\w:-]+)(?:\s|$)/u.test(text)) return null;
  if (/^\[Request interrupted by user/i.test(text) || /^This session is being continued from a previous conversation/i.test(text)) return null;
  return normalizeSessionTitle(text);
}

/** 自定义标题优先，其次 Claude 的 AI 标题 / 摘要，最后首条有效用户消息。 */
export function titleFromRecords(records, { sessionId, indexEntry = null } = {}) {
  const index = indexEntry && !indexEntry.isSidechain && (!sessionId || indexEntry.sessionId === sessionId) ? indexEntry : null;
  let custom = normalizeSessionTitle(index?.customTitle);
  let ai = normalizeSessionTitle(index?.aiTitle);
  let summary = normalizeSessionTitle(index?.summary);
  let first = null;
  for (const record of records) {
    if (!record || typeof record !== "object" || record.isSidechain) continue;
    if (sessionId && record.sessionId && record.sessionId !== sessionId) continue;
    if (record.type === "custom-title" && typeof record.customTitle === "string") custom = normalizeSessionTitle(record.customTitle);
    if (record.type === "ai-title" && typeof record.aiTitle === "string") ai = normalizeSessionTitle(record.aiTitle);
    if (record.type === "summary" && typeof record.summary === "string") summary = normalizeSessionTitle(record.summary);
    if (!first) first = userMessageTitle(record);
  }
  const indexedPrompt = typeof index?.firstPrompt === "string" ? userMessageTitle({ type: "user", message: { content: index.firstPrompt } }) : null;
  // Claude 的通用自动标题没有任务信息；用户明确重命名的同名标题仍保持原文。
  const automatic = ai === "Claude Code" ? null : ai === "Shared screenshot" ? first || indexedPrompt || "截图会话" : ai;
  return custom || automatic || summary || first || indexedPrompt || null;
}

function isInside(root, file) {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 同时限制词法路径和 realpath，禁止通过 transcript_path 或符号链接读取 projects 之外。 */
function safeFile(root, file) {
  try {
    const absolute = path.resolve(file);
    if (!isInside(root, absolute)) return null;
    const real = fs.realpathSync(absolute);
    if (!isInside(root, real)) return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

function readRecords(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const windows = size <= TRANSCRIPT_WINDOW_BYTES * 2
      ? [[0, size]]
      : [[0, TRANSCRIPT_WINDOW_BYTES], [size - TRANSCRIPT_WINDOW_BYTES, TRANSCRIPT_WINDOW_BYTES]];
    const records = [];
    for (const [offset, length] of windows) {
      const buffer = Buffer.alloc(length);
      const count = fs.readSync(fd, buffer, 0, length, offset);
      let text = buffer.subarray(0, count).toString("utf8");
      if (offset > 0) text = text.slice(text.indexOf("\n") + 1);
      if (offset + count < size) text = text.slice(0, text.lastIndexOf("\n") + 1);
      for (const line of text.split("\n")) {
        try {
          const record = JSON.parse(line);
          // 尾部只用于找最新标题，不能把中途的用户消息误当作首条提问。
          if (offset === 0 || ["custom-title", "ai-title", "summary"].includes(record?.type)) records.push(record);
        } catch { /* 部分行、损坏行均跳过。 */ }
      }
    }
    return records;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readIndex(root, dir) {
  let fd;
  try {
    const file = safeFile(root, path.join(dir, "sessions-index.json"));
    if (!file) return [];
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    if (size > INDEX_MAX_BYTES) return [];
    const buffer = Buffer.alloc(size);
    const count = fs.readSync(fd, buffer, 0, size, 0);
    const data = JSON.parse(buffer.subarray(0, count).toString("utf8"));
    return Array.isArray(data?.entries) ? data.entries : [];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * 为一次 snapshot 创建读取器；项目目录和旧版 index 只读取一次，同一 transcript 也只解析一次。
 * @param {string} projectsDir CLAUDE_CONFIG_DIR 下的 projects 目录
 * @returns {(session: object) => string|null} 接受 session_id / transcript_path / cwd 的会话快照
 */
export function createSessionTitleReader(projectsDir) {
  let root;
  try { root = fs.realpathSync(projectsDir); } catch { return () => null; }
  let projectDirs;
  const indexes = new Map();
  const titles = new Map();
  return (session) => {
    try {
      const id = session?.session_id;
      if (typeof id !== "string" || !SESSION_ID.test(id)) return null;
      const name = `${id}.jsonl`;
      let file = null;
      if (typeof session.transcript_path === "string" && path.isAbsolute(session.transcript_path) && path.basename(session.transcript_path) === name) {
        file = safeFile(root, session.transcript_path);
      }
      if (!file && typeof session.cwd === "string") {
        file = safeFile(root, path.join(root, session.cwd.replace(/[^A-Za-z0-9]/g, "-"), name));
      }
      if (!file) {
        projectDirs ??= fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).slice(0, PROJECT_LIMIT).map((entry) => path.join(root, entry.name));
        for (const dir of projectDirs) {
          file = safeFile(root, path.join(dir, name));
          if (file) break;
        }
      }
      if (!file) return null;
      if (titles.has(file)) return titles.get(file);
      const dir = path.dirname(file);
      if (!indexes.has(dir)) indexes.set(dir, readIndex(root, dir));
      const indexEntry = indexes.get(dir).find((entry) => entry?.sessionId === id && !entry.isSidechain);
      const title = titleFromRecords(readRecords(file), { sessionId: id, indexEntry });
      titles.set(file, title);
      return title;
    } catch {
      return null;
    }
  };
}

/** 单会话便捷入口；批量读取请复用 createSessionTitleReader。 */
export function getSessionTitle(session, { projectsDir } = {}) {
  return createSessionTitleReader(projectsDir)(session);
}
