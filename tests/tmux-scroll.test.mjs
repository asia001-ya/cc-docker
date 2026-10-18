// Opt-in Docker integration: uses a private tmux socket and never attaches to a user's session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { connectScroll } from './tmux-scroll-client.mjs';

const container = process.env.TDC_TEST_CONTAINER;
const script = readFileSync(new URL('../src-tauri/src/terminal/tmux-scroll.sh', import.meta.url), 'utf8');
test('real tmux history, absolute seeking, release persistence and return to live output', { skip: !container && 'Set TDC_TEST_CONTAINER' }, async () => {
  const socket = `tdc-scroll-test-${process.pid}`;
  const docker = (args, check = true) => {
    const result = spawnSync('docker', ['exec', '-u', 'node', container, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (check) assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const tmux = (...args) => docker(['tmux', '-L', socket, ...args]).stdout.trim();
  const run = (offset) => {
    const wrapper = `tmux() { command tmux -L '${socket}' "$@"; }\n`;
    const args = ['sh', '-c', wrapper + script, 'scroll-test', '=tdc-scroll-qa:0.0'];
    if (offset !== undefined) args.push(String(offset));
    return docker(args).stdout.trim().split('|');
  };
  let stream;
  try {
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'tdc-scroll-qa', '-x', '90', '-y', '24', 'sh', '-c', 'seq 1 300; sleep 120');
    let before;
    for (let i = 0; i < 10; i++) {
      before = run();
      if (Number(before[0]) > 200) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(Number(before[0]) > 200);
    assert.equal(before[3], '');
    const contentBefore = tmux('capture-pane', '-p', '-t', 'tdc-scroll-qa');
    assert.equal(run(100)[1], '100');
    assert.equal(run(150)[1], '150');
    assert.equal(run(25)[1], '25');
    const oldest = run(999999);
    assert.equal(oldest[1], oldest[0]);
    assert.equal(oldest[3], 'copy-mode');
    // No mouse-up / cancel is sent when the drag finishes; repeated reads stay at the selected offset.
    assert.deepEqual(run(), oldest);
    assert.deepEqual(run(), oldest);
    const bottom = run(0);
    assert.equal(bottom[1], '');
    assert.equal(bottom[3], '');
    assert.equal(tmux('capture-pane', '-p', '-t', 'tdc-scroll-qa'), contentBefore);
    stream = connectScroll(container, socket, '=tdc-scroll-qa:0.0');
    assert.equal((await stream.request())[0], before[0]);
    const samples = [];
    for (let i = 0; i < 60; i++) {
      const offset = (i * 17) % 200 + 1;
      const started = performance.now();
      assert.equal((await stream.request(offset))[1], String(offset));
      samples.push(performance.now() - started);
    }
    const held = await stream.request();
    await assert.rejects(stream.request('invalid'), /error/);
    assert.deepEqual(await stream.request(), held);
    assert.equal((await stream.request(0))[3], '');
    samples.sort((a, b) => a - b);
    console.log(`Persistent channel 60 seeks: median ${samples[30].toFixed(1)} ms, p95 ${samples[57].toFixed(1)} ms.`);
    console.log(`Verified ${before[0]} real tmux history rows; offsets 100 → 150 → 25 → top → live.`);
  } finally {
    stream?.close();
    docker(['tmux', '-L', socket, 'kill-server'], false);
  }
});
