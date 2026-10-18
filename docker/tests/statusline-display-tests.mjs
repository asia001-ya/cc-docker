import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSessionSnapshot, readGitBranch, run } from '../rootfs/opt/tdc/statusline.mjs';
import { renderStatusLine, cleanLabel, textWidth, fitLabel } from '../rootfs/opt/tdc/statusline-display.mjs';

const input = { session_id: 'session-one', session_name: '实现状态栏', model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  workspace: { current_dir: '/workspace/project' }, effort: { level: 'high' }, thinking: { enabled: true },
  context_window: { context_window_size: 1000000, used_percentage: 15 } };
const snapshot = () => ({ ...buildSessionSnapshot(input, {}, 10), git_branch: 'feature/status' });
const plain = value => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdc-status-display-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('状态栏保留六项实时信息、隐藏会话名，空间足够时只占一行', () => {
  const output = plain(renderStatusLine({}, snapshot(), 160));
  for (const item of ['Opus 5.5', 'high', '1M', 'git feature/status', 'project', 'ctx [', '15%']) assert.ok(output.includes(item), item);
  assert.match(output, /ctx \[■+\\+\] 15%/);
  assert.doesNotMatch(output, /思考 |目录 |会话 |实现状态栏/, '直接展示级别与文件夹名，不展示会话名');
  assert.doesNotMatch(output, /\/workspace\//, '目录只显示最后一层名称');
  assert.equal(output.split('\n').length, 1);
  assert.equal(renderStatusLine({}, snapshot(), 80).split('\n').length, 1, '先缩短进度条以保留单行');
  assert.ok(renderStatusLine({}, snapshot(), 48).split('\n').length > 1, '放不下才换行');
});

test('思考和模型变化使用当次值，200K 不显示为 1M，未知占用不显示为 0%', () => {
  const disabled = buildSessionSnapshot({ ...input, thinking: { enabled: false }, context_window: { context_window_size: 200000, used_percentage: 100 } }, {}, 11);
  const output = plain(renderStatusLine({}, disabled));
  assert.match(output, /关闭/); assert.doesNotMatch(output, /思考 /); assert.match(output, /200K/); assert.match(output, /ctx \[■+\] 100%/);
  const unknown = plain(renderStatusLine({}, buildSessionSnapshot({}, {}, 12)));
  assert.match(unknown, /ctx \[\\+\] —/); assert.doesNotMatch(unknown, /0%/);
});

test('窄窗和中文路径按显示列截断，不拆开 emoji 或输出控制字符', () => {
  const s = { ...snapshot(), cwd: '/workspace/\x1b]52;c;unsafe\x07' + '👩‍💻中文文件夹'.repeat(30) + '\n\x1b[2J' };
  for (const columns of [24, 40, 80, 120]) {
    const output = renderStatusLine({}, s, columns);
    for (const line of output.split('\n')) assert.ok(textWidth(line) <= columns - 4, `${columns}: ${plain(line)}`);
    assert.doesNotMatch(output, /\x1b\]|\x1b\[2J|unsafe/);
  }
  assert.equal(fitLabel('a👩‍💻b', 3), 'a…');
  assert.equal(cleanLabel('a\nb'), 'a b');
  assert.equal(textWidth('a   中'), 6, '对齐空格必须计入终端列宽');
});

test('Git 分支读取兼容未提交仓库、切分支、detached HEAD、非仓库和缓存', t => {
  const dir = temporary(t);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { windowsHide: true, stdio: 'pipe' });
  assert.equal(readGitBranch(dir, null, 10), null);
  git('init', '--initial-branch=main');
  assert.equal(readGitBranch(dir, null, 10), 'main');
  git('symbolic-ref', 'HEAD', 'refs/heads/feature/status');
  assert.equal(readGitBranch(dir, { cwd: dir, git_checked_at: 10, git_branch: 'main' }, 12), 'main');
  assert.equal(readGitBranch(dir, { cwd: dir, git_checked_at: 10, git_branch: 'main' }, 16), 'feature/status');
  git('-c', 'user.name=TDC test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
  git('checkout', '--detach');
  assert.match(readGitBranch(dir, null, 20), /^detached:[a-f0-9]+$/);
});

test('采集保留额度数据和会话映射，记录新字段且会话切换不复用旧名称', t => {
  const dir = temporary(t);
  const env = { TDC_STATE_DIR: dir, TDC_SESSION_ID: 'desktop', CLAUDE_CONFIG_DIR: dir, COLUMNS: '120' };
  run(JSON.stringify({ ...input, rate_limits: { five_hour: { used_percentage: 25 } } }), env, 10);
  let data = JSON.parse(fs.readFileSync(path.join(dir, 'sessions/desktop.json')));
  assert.equal(data.title, '实现状态栏'); assert.equal(data.effort_level, 'high'); assert.equal(data.context_window_size, 1000000);
  assert.equal(data.session_id, 'session-one');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'quota.json'))).five_hour.used_percentage, 25);
  run(JSON.stringify({ session_id: 'session-two' }), env, 11);
  data = JSON.parse(fs.readFileSync(path.join(dir, 'sessions/desktop.json')));
  assert.equal(data.title, null); assert.equal(data.effort_level, null); assert.equal(data.context_window_size, null);
});
