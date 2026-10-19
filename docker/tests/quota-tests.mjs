import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildQuotaSnapshot } from '../rootfs/opt/tdc/statusline.mjs';
import { fetchOAuthUsage, mergeLimits, refreshQuota } from '../rootfs/opt/tdc/tdc-quota.mjs';

const window = (used, reset = 2000) => ({ used_percentage: used, resets_at: reset });
test('quota: idle sessions cannot lower account usage or pretend that cached data is fresh', () => {
  const first = buildQuotaSnapshot(null, { rate_limits: { five_hour: window(70), seven_day: window(40, 9000) } }, {}, 100);
  const stale = buildQuotaSnapshot(first, { rate_limits: { five_hour: window(10), seven_day: window(20, 9000) } }, {}, 200);
  assert.equal(stale.five_hour.used_percentage, 70);
  assert.equal(stale.seven_day.used_percentage, 40);
  assert.equal(stale.rate_limits_updated_at, 100);
  const unchanged = buildQuotaSnapshot(stale, { rate_limits: { five_hour: window(70) } }, {}, 300);
  assert.equal(unchanged.rate_limits_updated_at, 100);
});

test('quota: independent windows reset, and a delayed report cannot resurrect the previous cycle', () => {
  const old = { five_hour: window(100), seven_day: window(50, 9000), rate_limits_updated_at: 100 };
  const next = mergeLimits(old, { five_hour: window(2, 20_000) }, 2001);
  assert.equal(next.five_hour.used_percentage, 2);
  assert.equal(next.seven_day.used_percentage, 50);
  const late = mergeLimits(next, { five_hour: window(100), seven_day: window(55, 9000) }, 2010);
  assert.deepEqual(late.five_hour, window(2, 20_000));
  assert.equal(late.seven_day.used_percentage, 55);
});

test('quota: concurrent processes preserve the highest account usage in each window', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdc-quota-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const module = new URL('../rootfs/opt/tdc/tdc-quota.mjs', import.meta.url).href;
  const file = path.join(dir, 'quota.json');
  await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise((resolve, reject) => {
    const limits = i % 2 ? { five_hour: window(i * 5) } : { seven_day: window(i * 5, 9000) };
    const source = 'import { withQuotaLock, mergeLimits } from ' + JSON.stringify(module) + ';'
      + 'withQuotaLock(' + JSON.stringify(file) + ', p => {'
      + 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);'
      + 'return mergeLimits(p, ' + JSON.stringify(limits) + ', 100); }, 3000);';
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', (data) => { error += data; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(error)));
  })));
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(result.five_hour, window(55));
  assert.deepEqual(result.seven_day, window(50, 9000));
  assert.deepEqual(fs.readdirSync(dir), ['quota.json']);
});

test('quota: OAuth refresh parses utilization/ISO time without putting credentials in argv', () => {
  const data = fetchOAuthUsage({ claudeAiOauth: { accessToken: 'synthetic-token' } }, (command, args, options) => {
    assert.equal(command, 'curl');
    assert.ok(!args.join(' ').includes('synthetic-token'));
    assert.ok(options.input.includes('https://api.anthropic.com/api/oauth/usage'));
    assert.ok(options.input.includes('Authorization: Bearer synthetic-token'));
    return { status: 0, stdout: JSON.stringify({ five_hour: { utilization: 12.5, resets_at: '2026-10-20T02:00:00Z' } }) + '\n200' };
  });
  const result = mergeLimits({ five_hour: window(90) }, data, 100, true);
  assert.equal(result.five_hour.used_percentage, 12.5);
  assert.equal(result.five_hour.resets_at, Date.parse('2026-10-20T02:00:00Z') / 1000);
  assert.throws(() => fetchOAuthUsage({ claudeAiOauth: { accessToken: 'test' } }, () =>
    ({ status: 0, stdout: 'private server response\n401' })), /授权已过期/);
});

test('quota: a refresh failure preserves the previous snapshot', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdc-quota-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'quota.json');
  const before = JSON.stringify({ five_hour: window(30) });
  fs.writeFileSync(file, before);
  assert.throws(() => refreshQuota({ CLAUDE_CONFIG_DIR: dir, TDC_STATE_DIR: dir }, () => { throw new Error('network'); }), /network/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
