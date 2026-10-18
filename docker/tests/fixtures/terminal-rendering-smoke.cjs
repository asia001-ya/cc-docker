// Runs inside the container, with `sources` supplied by the host runner.
// Each renderer gets a synthetic transcript, isolated config and private tmux socket.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = fs.mkdtempSync('/tmp/tdc-render-smoke-');
const socket = 'tdc-render-smoke-' + randomUUID();
const tmux = (...args) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', timeout: 5000 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const count = (text, marker) => text.split(marker).length - 1;
const pane = mode => tmux('capture-pane', '-p', '-J', '-t', mode, '-S', '-5000');
const state = mode => tmux('display-message', '-p', '-t', mode, '#{alternate_on}|#{history_size}').trim();
const marker = 'TDC_RENDER_MARKER';
const end = 'TDC_RENDER_END';

function createTranscript(mode) {
  const config = root + '/' + mode;
  fs.mkdirSync(config + '/projects/-workspace', { recursive: true });
  fs.writeFileSync(config + '/.claude.json', JSON.stringify({
    hasCompletedOnboarding: true, theme: 'dark', projects: { '/workspace': { hasTrustDialogAccepted: true } },
  }));
  const id = randomUUID();
  const parent = randomUUID();
  const content = `## ${marker}\n\n| 组件 | 说明 |\n| --- | --- |\n` +
    Array.from({ length: 25 }, (_, i) => `| 组件${i} | 中文表格验证，重绘内容不能重复写进历史。中英文混排：AdvancedBookmarkReplacer / LuaGlobalBind。长单元格会随着终端宽度改变而换行。 |`).join('\n') +
    `\n\n## ${end}\n\n` +
    Array.from({ length: 8 }, (_, i) => `${i + 1}. TDC_ROW_${i} 用于验证终端重绘的合成回答，不涉及真实项目。这里添加足够长的中文段落，使不同终端宽度需要不同数量的物理行，检查缩小后恢复原始宽度时旧画面是否混入历史。`).join('\n');
  const common = { sessionId: id, cwd: '/workspace', timestamp: new Date().toISOString() };
  const records = [
    { ...common, type: 'user', uuid: parent, parentUuid: null, message: { role: 'user', content: '显示测试表格' } },
    { ...common, type: 'assistant', uuid: randomUUID(), parentUuid: parent, message: {
      id: 'msg_render_smoke', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: content }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    } },
  ];
  const followup = randomUUID();
  records.push({ ...common, type: 'user', uuid: followup, parentUuid: records[1].uuid,
    message: { role: 'user', content: '表格显示完成' } });
  records.push({ ...common, type: 'assistant', uuid: randomUUID(), parentUuid: followup, message: {
    id: 'msg_render_followup', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: '本地显示验证完成。' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
  } });
  fs.writeFileSync(`${config}/projects/-workspace/${id}.jsonl`, records.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { config, id };
}

(async () => {
  try {
    fs.mkdirSync(root + '/bin');
    for (const [name, source] of Object.entries(sources)) {
      fs.writeFileSync(root + '/bin/' + (name === 'tdc-claude.sh' ? 'claude' : 'tdc-session'), source, { mode: 0o755 });
    }
    const results = [];
    for (const mode of ['classic', 'fullscreen']) {
      const { config, id } = createTranscript(mode);
      tmux('-f', '/dev/null', 'new-session', '-d', '-s', mode, '-x', '163', '-y', '37',
        'env', '-u', 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN', '-u', 'CLAUDE_CODE_NO_FLICKER',
        `CLAUDE_CONFIG_DIR=${config}`, `PATH=${root}/bin:${process.env.PATH}`,
        ...(mode === 'classic' ? ['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1'] : []),
        root + '/bin/tdc-session', '--no-tmux', 'smoke-' + mode, '/workspace', 'claude', '--safe-mode', '--resume', id);
      tmux('set-option', '-t', mode, 'mouse', 'on');
      let ready = false;
      for (let i = 0; i < 60; i++) {
        await delay(200);
        if (pane(mode).includes(end)) { ready = true; break; }
      }
      assert.ok(ready, mode + ': synthetic answer must render before resizing');
      await delay(250);
      const before = { state: state(mode), markers: count(pane(mode), marker), endings: count(pane(mode), end), rows: Array.from({length: 8}, (_, i) => count(pane(mode), `TDC_ROW_${i}`)) };
      for (const [cols, rows] of [[90, 30], [160, 37], [110, 32], [163, 37]]) {
        tmux('resize-window', '-t', mode, '-x', String(cols), '-y', String(rows));
        await delay(400);
      }
      const after = { state: state(mode), markers: count(pane(mode), marker), endings: count(pane(mode), end), rows: Array.from({length: 8}, (_, i) => count(pane(mode), `TDC_ROW_${i}`)) };
      if (mode === 'classic') {
        assert.equal(before.markers, 1, 'synthetic transcript contains one answer');
        assert.ok(after.rows.some(n => n > 1), 'baseline must reproduce duplicate history on Claude 2.1.300: ' + JSON.stringify({ before, after }));
      } else {
        assert.equal(before.state, '1|0');
        assert.equal(after.state, '1|0', 'fullscreen redraw must not append old frames to tmux history');
        assert.equal(count(pane(mode), end), 1, 'final section remains visible exactly once');
        let sawHeader = false;
        for (let i = 0; i < 8; i++) {
          tmux('send-keys', '-t', mode, 'PPage');
          await delay(150);
          const visible = pane(mode);
          assert.ok(count(visible, marker) <= 1);
          if (visible.includes(marker)) { sawHeader = true; break; }
        }
        assert.ok(sawHeader, 'PgUp must reach the beginning of the virtual conversation history');
        // tmux forwards SGR wheel events when Claude owns the alternate screen.
        tmux('send-keys', '-t', mode, '-l', '\x1b[<65;20;10M'.repeat(8));
        await delay(200);
        for (let i = 0; i < 8; i++) { tmux('send-keys', '-t', mode, 'NPage'); await delay(100); }
        assert.equal(count(pane(mode), end), 1, 'PgDn returns to the answer without duplicating it');
        assert.equal(state(mode), '1|0');
      }
      results.push({ mode, before, after });
    }
    // Use real PTYs to reproduce stale clients without attaching to user sessions.
    const panePid = tmux('display-message', '-p', '-t', 'fullscreen', '#{pane_pid}').trim();
    const clients = () => tmux('list-clients', '-t', 'fullscreen', '-F', '#{client_tty}').trim().split('\n').filter(Boolean).length;
    const attach = command => {
      const child = spawn('script', ['-q', '-c', command, '/dev/null'], { stdio: ['pipe', 'ignore', 'pipe'] });
      child.stderr.resume();
      return child;
    };
    const until = async (condition, description) => {
      for (let i = 0; i < 30; i++) { if (condition()) return; await delay(100); }
      assert.fail(description);
    };
    const old = attach(`stty cols 90 rows 30; exec tmux -L ${socket} attach-session -t '=fullscreen'`);
    await until(() => clients() === 1, 'first client must attach');
    const other = attach(`stty cols 110 rows 32; exec tmux -L ${socket} attach-session -t '=fullscreen'`);
    await until(() => clients() === 2, 'baseline leaves multiple clients attached');
    // Only command resolution is redirected to the private test socket.
    const script = root + '/reattach.sh';
    fs.writeFileSync(script, reattachSource.replace(/\btmux\b/g, `tmux -L ${socket}`));
    const newest = attach(`stty cols 163 rows 37; exec sh ${script} '=fullscreen' false`);
    await until(() => clients() === 1 && old.exitCode !== null && other.exitCode !== null, 'reattach must detach both obsolete clients');
    assert.equal(tmux('display-message', '-p', '-t', 'fullscreen', '#{pane_pid}').trim(), panePid, 'reattach preserves the running pane process');
    assert.equal(newest.exitCode, null);
    console.log(JSON.stringify({ version: execFileSync('tdc-claude-real', ['--version'], { encoding: 'utf8' }).trim(), results, reattach: { clients: clients(), panePreserved: true } }));
  } finally {
    try { tmux('kill-server'); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
