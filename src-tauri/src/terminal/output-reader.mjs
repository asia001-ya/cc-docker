/** Read-only Claude output extraction; embedded by the desktop for existing images. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const WINDOW = 16 * 1024 * 1024;
const BODY_LIMIT = 256 * 1024;
const TOTAL_LIMIT = 2 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const inside = (root, file) => { const p = path.relative(root, file); return p && p !== '..' && !p.startsWith('..' + path.sep) && !path.isAbsolute(p); };
function safeFile(root, file) {
  try {
    if (!inside(root, path.resolve(file))) return null;
    const real = fs.realpathSync(file);
    return inside(root, real) && fs.statSync(real).isFile() ? real : null;
  } catch { return null; }
}
function smallJson(file) {
  try { return fs.statSync(file).size <= 65536 ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { return null; }
}
function title(text, fallback = 'Markdown 文档') {
  const heading = text.match(/^#{1,6}\s+(.+)$/m)?.[1];
  const line = (heading || text.split('\n').find(line => line.trim() && !/^\s*(```|\||---)/.test(line)) || fallback)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^[#>*\s-]+|[*`_]/g, '').replace(/[\x00-\x1f\x7f]/g, '').trim();
  return Array.from(line).slice(0, 52).join('') || fallback;
}

/** Follow the latest conversation branch; exclude subagent transcripts and obsolete branches. */
export function activeRecords(records, sessionId) {
  const relevant = records.filter(r => r && typeof r === 'object' && !r.isSidechain && (!r.sessionId || r.sessionId === sessionId));
  const byId = new Map(relevant.filter(r => r.uuid).map(r => [r.uuid, r]));
  const leaf = relevant.findLast(r => ['user', 'assistant'].includes(r.type) && r.uuid);
  if (!leaf || !Object.hasOwn(leaf, 'parentUuid')) return relevant;
  const ids = new Set();
  for (let row = leaf; row && !ids.has(row.uuid); row = byId.get(row.parentUuid)) ids.add(row.uuid);
  return relevant.filter(r => ids.has(r.uuid));
}

export function extractOutputs(records, sessionId) {
  const rows = activeRecords(records, sessionId);
  const failed = new Set(rows.flatMap(r => Array.isArray(r.message?.content)
    ? r.message.content.filter(b => b?.type === 'tool_result' && b.is_error).map(b => b.tool_use_id) : []));
  const planCalls = new Set(rows.flatMap(r => Array.isArray(r.message?.content)
    ? r.message.content.filter(b => b?.type === 'tool_use' && b.name === 'ExitPlanMode').map(b => b.id) : []));
  const outputs = new Map();
  const putDocument = (filePath, body, timestamp, kind) => {
    if (typeof filePath !== 'string' || !/\.md$/i.test(filePath) || typeof body !== 'string' || !body.trim()) return;
    const id = 'document:' + hash(filePath);
    outputs.delete(id);
    outputs.set(id, { id, filePath, kind: kind || (/[/\\]plans?[/\\]/i.test(filePath) ? 'plan' : 'document'), title: title(body, path.basename(filePath)), markdown: body, timestamp: timestamp || null });
  };
  for (const row of rows) {
    // Only file-backed plans qualify; an ordinary reply or inline plan is not an artifact.
    if (row.type === 'user' && typeof row.toolUseResult?.plan === 'string' && Array.isArray(row.message?.content)) {
      const call = row.message.content.find(b => b?.type === 'tool_result' && planCalls.has(b.tool_use_id) && !b.is_error);
      if (call) putDocument(row.toolUseResult.filePath, row.toolUseResult.plan, row.timestamp, 'plan');
    }
    if (row.type !== 'assistant' || row.isMeta || row.isCompactSummary) continue;
    const msg = row.message;
    if (!msg || (msg.role && msg.role !== 'assistant')) continue;
    const blocks = Array.isArray(msg.content) ? msg.content : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [];
    for (const block of blocks) {
      if (block?.type !== 'tool_use' || failed.has(block.id)) continue;
      const input = block.input || {};
      if (block.name === 'Edit' && typeof input.file_path === 'string' && typeof input.old_string === 'string' && input.old_string && typeof input.new_string === 'string') {
        const id = 'document:' + hash(input.file_path);
        const old = outputs.get(id);
        if (old?.markdown.includes(input.old_string)) {
          const markdown = input.replace_all ? old.markdown.split(input.old_string).join(input.new_string) : old.markdown.replace(input.old_string, () => input.new_string);
          outputs.delete(id);
          outputs.set(id, { ...old, markdown, title: title(markdown), timestamp: row.timestamp || old.timestamp });
        }
        continue;
      }
      if (block.name === 'Write') putDocument(input.file_path, input.content, row.timestamp);
    }
  }
  const items = [];
  let bytes = 0;
  let limited = outputs.size > 40;
  for (const item of [...outputs.values()].reverse().slice(0, 40)) {
    const truncated = item.markdown.length > BODY_LIMIT;
    item.markdown = Array.from(item.markdown.slice(0, BODY_LIMIT)).join('').replace(/[\uD800-\uDBFF]$/, '');
    const size = Buffer.byteLength(item.markdown);
    if (bytes + size > TOTAL_LIMIT) { limited = true; break; }
    bytes += size;
    items.push({ ...item, truncated, revision: hash(item.markdown) });
  }
  return { items, limited };
}

export function readOutputs(request, environment = process.env) {
  if (!ID.test(request?.tdcId || '')) throw new Error('Invalid session');
  const config = request.configDir || environment.CLAUDE_CONFIG_DIR || '/home/node/.claude';
  const state = request.stateDir || environment.TDC_STATE_DIR || '/home/node/.claude/tdc/state';
  const snapshot = smallJson(path.join(state, 'sessions', request.tdcId + '.json'));
  const mapped = snapshot && (!snapshot.tdc_session_id || snapshot.tdc_session_id === request.tdcId) ? snapshot : null;
  const conversationId = ID.test(mapped?.session_id || '') ? mapped.session_id : ID.test(request.fallbackId || '') ? request.fallbackId : null;
  const empty = status => ({ conversationId, status, revision: null, items: [], limited: false });
  if (!conversationId) return empty('waiting');
  let root;
  try { root = fs.realpathSync(path.join(config, 'projects')); } catch { return empty('missing'); }
  const name = conversationId + '.jsonl';
  let file = null;
  if (typeof mapped?.transcript_path === 'string' && path.basename(mapped.transcript_path) === name) file = safeFile(root, mapped.transcript_path);
  if (!file && typeof (mapped?.cwd || request.cwd) === 'string') file = safeFile(root, path.join(root, (mapped?.cwd || request.cwd).replace(/[^A-Za-z0-9]/g, '-'), name));
  if (!file) for (const dir of fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).slice(0, 512)) {
    file = safeFile(root, path.join(root, dir.name, name));
    if (file) break;
  }
  if (!file) return empty('missing');
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const revision = hash(`files-v2|${conversationId}|${file}|${stat.size}|${stat.mtimeMs}`);
    if (revision === request.revision) return { conversationId, status: 'ready', revision, items: null, limited: false };
    const offset = Math.max(0, stat.size - WINDOW);
    const buffer = Buffer.alloc(Math.min(WINDOW, stat.size));
    const length = fs.readSync(fd, buffer, 0, buffer.length, offset);
    let text = buffer.subarray(0, length).toString('utf8');
    if (offset) text = text.slice(text.indexOf('\n') + 1);
    const records = [];
    for (const line of text.split('\n')) { try { records.push(JSON.parse(line)); } catch { /* in-progress / damaged lines */ } }
    const result = extractOutputs(records, conversationId);
    return { conversationId, status: 'ready', revision, items: result.items, limited: result.limited || offset > 0 };
  } finally { fs.closeSync(fd); }
}

if (process.argv[1] === '--tdc-output-reader') {
  try { process.stdout.write(JSON.stringify(readOutputs(JSON.parse(process.argv[2])))); }
  catch { process.stderr.write('Cannot read session outputs'); process.exitCode = 1; }
}
