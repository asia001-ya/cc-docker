import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractOutputs, readOutputs } from '../src-tauri/src/terminal/output-reader.mjs';

const sessionId = 'conversation-1';
const answer = (id, text, extra = {}) => ({ type: 'assistant', sessionId, uuid: id, message: { id, role: 'assistant', content: [{ type: 'text', text }] }, ...extra });
const document = (id, content, extra = {}) => ({ ...tool(id, 'Write', { file_path: '/workspace/docs/' + id + '.md', content }), ...extra });
const tool = (id, name, input) => ({ type: 'assistant', sessionId, uuid: id, message: { id, content: [{ type: 'tool_use', id, name, input }] } });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdc-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'config');
  const state = path.join(root, 'state');
  const projects = path.join(config, 'projects', '-workspace');
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(path.join(state, 'sessions'), { recursive: true });
  const file = path.join(projects, sessionId + '.jsonl');
  fs.writeFileSync(path.join(state, 'sessions', 'terminal-1.json'), JSON.stringify({ tdc_session_id: 'terminal-1', session_id: sessionId, transcript_path: file }));
  return { root, config, state, projects, file, request: { tdcId: 'terminal-1', configDir: config, stateDir: state }, write: rows => fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n') };
}

test('ordinary replies, Markdown-looking answers, inline plans and non-Markdown files never enter the directory', () => {
  const rows = [answer('plain', '普通回答'), answer('markdown', '# 实施计划\n\n这仍然只是回答'),
    tool('plan', 'ExitPlanMode', { plan: '# 内联计划' }),
    { type: 'user', toolUseResult: { plan: '# 无文件路径的计划' }, message: { content: [{ type: 'tool_result', tool_use_id: 'plan' }] } },
    tool('code', 'Write', { file_path: '/workspace/app.ts', content: 'export {}' })];
  assert.deepEqual(extractOutputs(rows, sessionId).items, []);
});

test('Markdown files preserve tables and code and exclude other sessions and sidechains', () => {
  const markdown = '# 实现说明\n\n| 阶段 | 内容 |\n|---|---|\n| 1 | 中文 |\n\n```ts\nconst ready = true;\n```';
  const rows = [document('implementation', markdown), document('other', 'wrong', { sessionId: 'other' }), document('side', 'wrong', { isSidechain: true }), answer('reply', markdown)];
  const { items } = extractOutputs(rows, sessionId);
  assert.equal(items.length, 1);
  assert.equal(items[0].markdown, markdown);
  assert.equal(items[0].filePath, '/workspace/docs/implementation.md');
  assert.equal(items[0].title, '实现说明');
});

test('latest parentUuid branch excludes abandoned documents', () => {
  const rows = [document('root', '共同文档', { parentUuid: null }), document('old', '废弃分支', { parentUuid: 'root' }), document('new', '当前分支', { parentUuid: 'root' })];
  assert.deepEqual(extractOutputs(rows, sessionId).items.map(item => item.markdown), ['当前分支', '共同文档']);
});

test('file-backed plans deduplicate Write and ExitPlanMode; edits update one entry and failed writes are omitted', () => {
  const filePath = '/home/node/.claude/plans/test.md';
  const rows = [tool('write', 'Write', { file_path: filePath, content: '# 计划\n旧步骤' }),
    tool('edit', 'Edit', { file_path: filePath, old_string: '旧步骤', new_string: '新步骤' }),
    tool('plan', 'ExitPlanMode', {}), { type: 'user', toolUseResult: { filePath, plan: '# 计划\n新步骤' }, message: { content: [{ type: 'tool_result', tool_use_id: 'plan', content: 'ok' }] } },
    document('bad', '失败的文件'), { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bad', is_error: true }] } }];
  assert.deepEqual(extractOutputs(rows, sessionId).items.map(item => [item.kind, item.markdown, item.filePath]), [['plan', '# 计划\n新步骤', filePath]]);
});

test('reader maps only the requested terminal, tolerates incomplete rows and uses revision caching', t => {
  const f = fixture(t);
  f.write([document('a', '# 实现说明\n正文')]);
  fs.appendFileSync(f.file, '{unfinished');
  const first = readOutputs(f.request, {});
  assert.equal(first.items[0].title, '实现说明');
  assert.equal(first.conversationId, sessionId);
  assert.equal(readOutputs({ ...f.request, revision: first.revision }, {}).items, null);
  assert.equal(readOutputs({ ...f.request, tdcId: 'different' }, {}).status, 'waiting');
  assert.throws(() => readOutputs({ ...f.request, tdcId: '../escape' }, {}));
  assert.equal(readOutputs({ ...f.request, tdcId: 'different', fallbackId: sessionId }, {}).items.length, 1);
});

test('transcript paths cannot escape projects, even if the filename is a valid session ID', t => {
  const f = fixture(t);
  const outside = path.join(f.root, sessionId + '.jsonl');
  fs.writeFileSync(outside, JSON.stringify(document('outside', 'do not read')));
  fs.writeFileSync(path.join(f.state, 'sessions', 'terminal-1.json'), JSON.stringify({ session_id: sessionId, transcript_path: outside }));
  assert.equal(readOutputs(f.request, {}).status, 'missing');
  f.write([document('inside', 'safe')]);
  assert.equal(readOutputs(f.request, {}).items[0].markdown, 'safe');
});

test('a mismatched statusline mapping cannot expose another conversation', t => {
  const f = fixture(t); f.write([document('a', 'wrong terminal')]);
  fs.writeFileSync(path.join(f.state, 'sessions', 'terminal-1.json'), JSON.stringify({ tdc_session_id: 'different', session_id: sessionId, transcript_path: f.file }));
  assert.equal(readOutputs(f.request, {}).status, 'waiting');
});

test('output limits are explicit and retain the newest documents', () => {
  const results = extractOutputs(Array.from({ length: 50 }, (_, i) => document('a' + i, '正文' + i)), sessionId);
  assert.equal(results.items.length, 40); assert.equal(results.limited, true);
  assert.equal(results.items[0].markdown, '正文49');
  const long = extractOutputs([document('long', '字'.repeat(300000))], sessionId).items[0];
  assert.equal(long.truncated, true); assert.ok(long.markdown.length <= 256 * 1024);
});
