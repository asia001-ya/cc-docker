#!/usr/bin/env node
/**
 * Read usage metadata from shared transcripts, using only this container's private
 * history to establish ownership. Prompts are inspected locally to distinguish
 * user turns from tool/system messages; neither prompts nor history display text
 * are included in the snapshot. Missing or ambiguous evidence fails closed.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MATCH_WINDOW_MS = 1000;
const asString = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const asNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
};
const epochMs = (value) => {
  const number = asNumber(value);
  if (number !== null && number > 0) return number > 1e12 ? number : number * 1000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
};
const token = (value) => {
  const number = asNumber(value);
  return number !== null && number >= 0 && number <= 1e12 ? Math.floor(number) : 0;
};
const duration = (value) => {
  const number = asNumber(value);
  return number !== null && number > 0 && number <= 86400000 ? number : null;
};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nodeKey = (sessionId, uuid) => JSON.stringify([sessionId, uuid]);
const timestampValue = (event) => event.timestamp ?? event.created_at ?? event.createdAt ?? event.message?.timestamp;

// Only explicit synthetic wrappers are transparent. A new user submission,
// including image-only or otherwise unfamiliar content, always ends the old turn.
const SYNTHETIC_WRAPPER = /<(system-reminder|local-command-caveat|local-command-stdout|task-notification|teammate-message|ide_opened_file|ide_selection|environment_context|session-start-hook|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/gi;
function syntheticText(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (/^\[Request interrupted by user(?: for tool use)?\]$/.test(text)) return true;
  if (/^This session is being continued from a previous conversation that ran out of context\./.test(text)) return true;
  return text.length > 0 && text.replace(SYNTHETIC_WRAPPER, "").trim() === "";
}

function nodeKind(event) {
  const role = event.message?.role;
  if (event.type === "user" || role === "user") {
    if (event.isMeta === true || event.isCompactSummary === true || isObject(event.toolUseResult)) return "bridge";
    const content = event.message?.content;
    if (syntheticText(content)) return "bridge";
    if (Array.isArray(content) && content.length > 0 && content.every((block) => (
      block?.type === "tool_result" || (block?.type === "text" && syntheticText(block.text))
    ))) return "bridge";
    return "user";
  }
  if (role === "assistant" || ["assistant", "system", "attachment", "progress", "tool", "tool_result"].includes(event.type)) return "bridge";
  return "unknown";
}

function readHistory(configDir, warnings) {
  let text;
  try { text = fs.readFileSync(path.join(configDir, "history.jsonl"), "utf8"); }
  catch {
    warnings.push("本地 history.jsonl 不可用，无法验证请求归属");
    return new Map();
  }
  const bySession = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { event = null; }
    const sessionId = asString(event?.sessionId ?? event?.session_id);
    const timestamp = epochMs(event?.timestamp);
    // A truncated/corrupt entry could be another candidate in the same window.
    // Do not claim uniqueness from a partly unreadable local history snapshot.
    if (!isObject(event) || !sessionId || timestamp === null) {
      warnings.push("本地 history.jsonl 含无效记录，无法验证请求归属");
      return new Map();
    }
    const entries = bySession.get(sessionId) ?? [];
    entries.push({ timestamp });
    bySession.set(sessionId, entries);
  }
  for (const entries of bySession.values()) entries.sort((a, b) => a.timestamp - b.timestamp);
  return bySession;
}

function candidates(entries, timestamp) {
  let low = 0, high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle].timestamp < timestamp - MATCH_WINDOW_MS) low = middle + 1;
    else high = middle;
  }
  const found = [];
  for (let index = low; index < entries.length && entries[index].timestamp <= timestamp + MATCH_WINDOW_MS; index += 1) found.push(entries[index]);
  return found;
}

function ownershipReader(nodes, unkeyedUsers, history) {
  const matching = new Map();
  const usersPerHistory = new Map();
  for (const node of [...nodes.values(), ...unkeyedUsers]) {
    if (!node || node.kind !== "user" || node.timestamp === null) continue;
    const nearby = candidates(history.get(node.sessionId) ?? [], node.timestamp);
    matching.set(node, nearby);
    for (const entry of nearby) usersPerHistory.set(entry, (usersPerHistory.get(entry) ?? 0) + 1);
  }
  const cache = new Map();
  return (start) => {
    let node = start;
    const visited = new Set();
    let ownership = "unverified";
    while (node) {
      if (node.key) {
        if (!nodes.get(node.key) || visited.has(node.key)) break;
        if (cache.has(node.key)) { ownership = cache.get(node.key); break; }
        visited.add(node.key);
        node = nodes.get(node.key);
      }
      if (node.kind === "user") {
        const nearby = matching.get(node) ?? [];
        if (nearby.length === 1 && usersPerHistory.get(nearby[0]) === 1) ownership = "local-history";
        break;
      }
      if (node.kind !== "bridge" || !node.parent) break;
      node = nodes.get(nodeKey(node.sessionId, node.parent));
    }
    for (const key of visited) cache.set(key, ownership);
    return ownership;
  };
}

/**
 * Return a synchronous protocol 2 metadata snapshot. stateDir is intentionally
 * unnecessary: a live session/state file does not establish request ownership.
 */
export function collectUsage({ configDir = process.env.CLAUDE_CONFIG_DIR || "/home/node/.claude" } = {}) {
  const usageFile = path.join(configDir, "tdc", "usage-provider.json");
  const out = { protocol: 2, supported: true, captureReady: false, captureStartedAt: null, provider: null, records: [], warnings: [] };
  try {
    if (fs.existsSync(usageFile)) {
      try { out.provider = JSON.parse(fs.readFileSync(usageFile, "utf8")); } catch { /* Invalid provider below. */ }
      if (isObject(out.provider)) {
        out.captureReady = true;
        try { out.captureStartedAt = Math.floor(fs.statSync(usageFile).mtimeMs / 1000); } catch { /* Preserve legacy fallback. */ }
      } else {
        out.warnings.push("usage-provider.json 不是有效 JSON");
      }
    }
  } catch {
    out.warnings.push("无法读取 usage-provider.json");
  }
  const history = readHistory(configDir, out.warnings);
  const files = [];
  const walk = (root) => {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
    }
  };
  walk(path.join(configDir, "projects"));
  const nodes = new Map();
  const unkeyedUsers = [];
  const pending = [];
  for (const file of files) {
    let text, mtime;
    try { text = fs.readFileSync(file, "utf8"); mtime = Math.floor(fs.statSync(file).mtimeMs / 1000); }
    catch { out.warnings.push(`无法读取 ${path.basename(file)}`); continue; }
    const sessionFromFile = path.basename(file, ".jsonl");
    let lineNo = 0;
    let lastUsageIndex = -1;
    for (const line of text.split(/\r?\n/)) {
      lineNo += 1;
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (!isObject(event)) continue;
      const message = isObject(event.message) ? event.message : null;
      const sessionId = asString(event.session_id ?? event.sessionId ?? message?.session_id ?? message?.sessionId) || sessionFromFile;
      const uuid = asString(event.uuid);
      const node = {
        key: uuid ? nodeKey(sessionId, uuid) : null,
        sessionId,
        parent: asString(event.parentUuid ?? event.parent_uuid),
        kind: nodeKind(event),
        timestamp: epochMs(timestampValue(event)),
      };
      if (node.key) {
        if (!nodes.has(node.key)) nodes.set(node.key, node);
        else {
          const previous = nodes.get(node.key);
          // Streaming duplicates may have different assistant timestamps/tokens;
          // only conflicting ancestry or user boundaries invalidate the UUID.
          if (!previous || previous.parent !== node.parent || previous.kind !== node.kind || (node.kind === "user" && previous.timestamp !== node.timestamp)) {
            // Conflicting user UUIDs still make nearby history matches ambiguous;
            // dropping them from the graph must not make another turn look unique.
            if (previous?.kind === "user") unkeyedUsers.push(previous);
            if (node.kind === "user") unkeyedUsers.push(node);
            nodes.set(node.key, null);
          }
        }
      } else if (node.kind === "user") unkeyedUsers.push(node);

      // Keep the legacy request ID/token/duration extraction contract. The graph
      // above also indexes attachment/system/tool nodes without any usage fields.
      if (event.type === "system" && event.subtype === "turn_duration") {
        const turnMs = duration(event.durationMs ?? event.duration_ms);
        if (turnMs !== null && lastUsageIndex >= 0) out.records[lastUsageIndex].durationMs = turnMs;
        continue;
      }
      const usage = (isObject(message?.usage) ? message.usage : null) || (isObject(event.usage) ? event.usage : null);
      if (!usage) continue;
      const inputTokens = token(usage.input_tokens ?? usage.inputTokens);
      const outputTokens = token(usage.output_tokens ?? usage.outputTokens);
      const cacheReadTokens = token(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cache_read_tokens ?? usage.cacheReadTokens);
      const cacheWriteTokens = token(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? usage.cache_write_tokens ?? usage.cacheWriteTokens);
      if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) continue;
      const rawId = asString(event.requestRef ?? event.request_ref ?? event.requestId ?? event.request_id ?? event.requestID ?? message?.id) || `${sessionId}:${lineNo}`;
      const id = `${sessionId}:${rawId}`.slice(0, 512);
      const timestamp = node.timestamp === null ? mtime : Math.floor(node.timestamp / 1000);
      if (!timestamp) continue;
      const model = asString(message?.model ?? event.model) || "";
      const durationMs = duration(event.duration_ms ?? event.durationMs ?? message?.duration_ms ?? usage.duration_ms);
      const row = { id, timestamp, sessionId, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, durationMs, attribution: "historical", ownership: "unverified" };
      out.records.push(row);
      pending.push({ node, row });
      lastUsageIndex = out.records.length - 1;
    }
  }
  const ownership = ownershipReader(nodes, unkeyedUsers, history);
  for (const { node, row } of pending) {
    row.ownership = ownership(node);
    if (row.ownership === "local-history" && out.captureReady && (out.captureStartedAt === null || row.timestamp >= out.captureStartedAt)) row.attribution = "captured";
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.stdout.write(`${JSON.stringify(collectUsage())}\n`);
}
