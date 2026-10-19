#!/usr/bin/env node
/** Account-wide quota storage. Every statusline process and manual refresh uses the same lock. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function normalizePercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

export function normalizeEpochSeconds(value) {
  if (typeof value === 'string') value = Date.parse(value) / 1000;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value > 1e12 ? value / 1000 : value);
}

export function parseWindow(win) {
  if (!win || typeof win !== 'object') return null;
  const used = normalizePercent(win.used_percentage ?? win.utilization);
  return used === null ? null : { used_percentage: used, resets_at: normalizeEpochSeconds(win.resets_at) };
}

export function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Short critical section only: never hold this lock while querying the network. */
export function withQuotaLock(file, update, timeoutMs = 500) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = file + '.lock';
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        // The critical section contains only small local file operations.
        if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmdirSync(lock);
      } catch { /* Another writer may already have released it. */ }
      if (Date.now() >= deadline) throw new Error('额度正在更新，请稍后重试');
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  try {
    const next = update(readJsonSafe(file));
    writeJsonAtomic(file, next);
    return next;
  } finally {
    fs.rmdirSync(lock);
  }
}

/** Usage is account-wide, not additive. Ignore older reset windows and stale lower usage. */
export function mergeWindow(previous, incoming, nowSec, authoritative = false) {
  const prev = parseWindow(previous);
  const next = parseWindow(incoming);
  if (!next) return prev;
  if (!prev || authoritative) return next;
  if (prev.resets_at && next.resets_at) {
    if (next.resets_at < prev.resets_at) return prev;
    if (next.resets_at > prev.resets_at) return next;
  } else if (prev.resets_at && prev.resets_at <= nowSec) {
    // A cache without a reset timestamp cannot establish a new quota window.
    return prev;
  }
  return {
    used_percentage: Math.max(prev.used_percentage, next.used_percentage),
    resets_at: next.resets_at ?? prev.resets_at,
  };
}

export function mergeLimits(previous, limits, nowSec, authoritative = false) {
  const five_hour = mergeWindow(previous?.five_hour, limits?.five_hour, nowSec, authoritative);
  const seven_day = mergeWindow(previous?.seven_day, limits?.seven_day, nowSec, authoritative);
  const changed = JSON.stringify(five_hour) !== JSON.stringify(parseWindow(previous?.five_hour))
    || JSON.stringify(seven_day) !== JSON.stringify(parseWindow(previous?.seven_day));
  return {
    five_hour,
    seven_day,
    rate_limits_updated_at: changed || authoritative ? nowSec : previous?.rate_limits_updated_at ?? null,
  };
}

/** Credentials stay inside the container and travel to the official OAuth endpoint only. */
export function fetchOAuthUsage(credentials, execute = spawnSync) {
  const token = credentials?.claudeAiOauth?.accessToken;
  if (typeof token !== 'string' || !token || /[\x00-\x1f\x7f]/.test(token)) {
    throw new Error('未找到有效的授权账号，请先在容器中登录 Claude');
  }
  const config = [
    'url = "https://api.anthropic.com/api/oauth/usage"',
    'header = ' + JSON.stringify('Authorization: Bearer ' + token),
    'header = "anthropic-beta: oauth-2025-04-20"',
    'header = "Accept: application/json"',
  ].join('\n');
  const result = execute('curl', [
    '--disable', '--config', '-', '--silent', '--show-error', '--connect-timeout', '5', '--max-time', '15',
    '--proto', '=https', '--write-out', '\n%{http_code}',
  ], { input: config, encoding: 'utf8', timeout: 17_000, maxBuffer: 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('无法连接额度服务，请检查容器网络或代理后重试');
  const output = result.stdout ?? '';
  const separator = output.lastIndexOf('\n');
  const status = Number(output.slice(separator + 1).trim());
  if (status === 401 || status === 403) throw new Error('授权已过期或无法读取额度，请在容器中重新登录 Claude');
  if (status === 429) throw new Error('额度服务请求过于频繁，请稍后重试');
  if (status !== 200) throw new Error('额度服务返回 HTTP ' + status + '，请稍后重试');
  let data;
  try { data = JSON.parse(output.slice(0, separator)); } catch { throw new Error('额度服务返回了无效数据'); }
  if (!parseWindow(data.five_hour) && !parseWindow(data.seven_day)) throw new Error('账号暂未提供 5 小时或周额度');
  return data;
}

export function refreshQuota(env = process.env, fetchUsage = fetchOAuthUsage) {
  const configDir = env.CLAUDE_CONFIG_DIR || '/home/node/.claude';
  const provider = readJsonSafe(path.join(configDir, 'tdc/provider-settings.json'));
  const providerEnv = provider?.env ?? {};
  if (['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']
    .some((key) => providerEnv[key] || env[key])) throw new Error('API 容器没有订阅额度');
  const credentials = env.CLAUDE_CODE_OAUTH_TOKEN
    ? { claudeAiOauth: { accessToken: env.CLAUDE_CODE_OAUTH_TOKEN } }
    : readJsonSafe(path.join(configDir, '.credentials.json'));
  const limits = fetchUsage(credentials);
  const now = Math.floor(Date.now() / 1000);
  return withQuotaLock(path.join(env.TDC_STATE_DIR || path.join(configDir, 'tdc/state'), 'quota.json'), (previous) => ({
    ...previous,
    protocol: 1,
    updated_at: now,
    auth_hint: 'subscription',
    ...mergeLimits(previous, limits, now, true),
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(JSON.stringify({ ok: true, quota: refreshQuota() }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
    process.exitCode = 1;
  }
}
