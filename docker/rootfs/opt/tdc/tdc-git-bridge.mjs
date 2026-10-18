#!/usr/bin/env node
// Credential helper <-> private Unix socket <-> Docker exec stdio. No credential files.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const LIMIT = 65536;
const configDir = () => process.env.TDC_GIT_BRIDGE_DIR || path.join(os.homedir(), '.claude/tdc/git-bridge');
const socketDir = () => process.env.TDC_GIT_SOCKET_DIR || path.join(os.tmpdir(), `tdc-git-${process.getuid?.() ?? 'user'}`);
const configPath = () => path.join(configDir(), 'config');
const statePath = () => path.join(socketDir(), 'current.json');
const helper = '!node /opt/tdc/tdc-git-bridge.mjs helper';
const safeText = value => typeof value === 'string' && value.length <= 16384 && !/[\x00-\x1f\x7f]/.test(value);

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory()) throw new Error('unsafe-directory');
  fs.chmodSync(dir, 0o700);
}
function atomic(file, content) {
  const temporary = file + '.' + randomUUID();
  fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}
function git(args, acceptMissing = false) {
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 5000, maxBuffer: LIMIT, windowsHide: true });
  if (result.status !== 0 && !(acceptMissing && [1, 5].includes(result.status))) throw new Error('git-config-failed');
  return result.stdout?.trim() || '';
}
export function installConfig(settings) {
  privateDir(configDir());
  const previous = fs.existsSync(configPath()) ? fs.readFileSync(configPath()) : null;
  const temporary = path.join(configDir(), `config-${randomUUID()}`);
  fs.writeFileSync(temporary, '', { flag: 'wx', mode: 0o600 });
  try {
    for (const host of settings.allowedHosts) {
      if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?$/.test(host)) throw new Error('invalid-host');
      const prefix = `credential.https://${host}`;
      git(['config', '--file', temporary, '--add', `${prefix}.helper`, '']);
      git(['config', '--file', temporary, '--add', `${prefix}.helper`, helper]);
      git(['config', '--file', temporary, `${prefix}.useHttpPath`, 'true']);
    }
    for (const key of ['name', 'email']) {
      if (safeText(settings.identity?.[key]) && settings.identity[key]) git(['config', '--file', temporary, `user.${key}`, settings.identity[key]]);
    }
    fs.renameSync(temporary, configPath());
    const includes = git(['config', '--global', '--get-all', 'include.path'], true).split('\n');
    if (!includes.includes(configPath())) git(['config', '--global', '--add', 'include.path', configPath()]);
  } catch (error) {
    if (previous !== null) atomic(configPath(), previous);
    else fs.rmSync(configPath(), { force: true });
    throw error;
  } finally { fs.rmSync(temporary, { force: true }); }
}
export function disable() {
  git(['config', '--global', '--fixed-value', '--unset-all', 'include.path', configPath()], true);
  fs.rmSync(configPath(), { force: true });
  fs.rmSync(statePath(), { force: true });
}
export function parseCredential(input) {
  const result = {};
  if (input.length > LIMIT) return null;
  for (const line of input.split('\n')) {
    if (!line) break;
    const index = line.indexOf('=');
    if (index < 1) return null;
    const key = line.slice(0, index), value = line.slice(index + 1);
    if (['protocol', 'host', 'path', 'username'].includes(key)) {
      if (!safeText(value) || Object.hasOwn(result, key)) return null;
      result[key] = value;
    }
  }
  return result.protocol === 'https' && result.host ? result : null;
}
function lines(stream, callback, fail) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > LIMIT) return fail();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try { callback(JSON.parse(line)); } catch { fail(); return; }
    }
  });
}
export function serve() {
  let server, socket, initialized = false, lastPing = Date.now();
  const clients = new Map();
  const finish = () => {
    for (const client of clients.values()) client.destroy();
    server?.close();
    if (socket) fs.rmSync(socket, { force: true });
    try { if (JSON.parse(fs.readFileSync(statePath(), 'utf8')).socket === socket) fs.rmSync(statePath()); } catch {}
    process.exit(0);
  };
  const send = message => process.stdout.write(JSON.stringify(message) + '\n');
  const heartbeat = setInterval(() => { if (Date.now() - lastPing > 25000) finish(); }, 5000);
  heartbeat.unref();
  process.stdin.on('end', finish);
  process.on('SIGTERM', finish);
  lines(process.stdin, message => {
    lastPing = Date.now();
    if (!initialized) {
      if (message.type !== 'init' || !Array.isArray(message.allowedHosts) || message.allowedHosts.length > 16) throw new Error('bad-init');
      privateDir(socketDir());
      socket = path.join(socketDir(), `${randomUUID()}.sock`);
      server = net.createServer(client => {
        if (clients.size >= 8) return client.destroy();
        const id = randomUUID();
        clients.set(id, client);
        client.setTimeout(20000, () => client.destroy());
        client.on('error', () => client.destroy());
        client.on('close', () => clients.delete(id));
        let requested = false;
        lines(client, credential => {
          if (requested) return client.destroy();
          requested = true;
          send({ type: 'request', id, credential });
        }, () => client.destroy());
      });
      server.on('error', finish);
      server.listen(socket, () => {
        try {
          fs.chmodSync(socket, 0o600);
          installConfig(message);
          atomic(statePath(), JSON.stringify({ socket }));
          send({ type: 'ready' });
        } catch { send({ type: 'error' }); finish(); }
      });
      initialized = true;
    } else if (message.type === 'response') {
      const client = clients.get(message.id);
      if (client) client.end(JSON.stringify(message.credential || {}) + '\n');
    }
  }, finish);
}
async function runHelper(operation) {
  // store/erase must never write to the host credential manager.
  if (operation !== 'get') return;
  const input = await new Promise(resolve => {
    let value = '', done = false;
    const finish = () => { if (!done) { done = true; process.stdin.pause(); resolve(value); } };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      value += chunk;
      if (value.length > LIMIT) process.exit(0);
      // Git terminates requests with a blank line; Docker may keep stdin attached.
      if (value.includes('\n\n')) finish();
    });
    process.stdin.on('end', finish);
  });
  const credential = parseCredential(input);
  if (!credential) return;
  let state;
  try { state = JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return; }
  if (typeof state.socket !== 'string' || path.dirname(state.socket) !== socketDir()) return;
  await new Promise(resolve => {
    const client = net.createConnection(state.socket);
    const finish = () => { client.destroy(); resolve(); };
    client.setTimeout(20000, finish);
    client.on('error', finish); client.on('end', finish);
    client.on('connect', () => client.write(JSON.stringify(credential) + '\n'));
    lines(client, result => {
      if (safeText(result.username) && safeText(result.password)) process.stdout.write(`username=${result.username}\npassword=${result.password}\n\n`);
      finish();
    }, finish);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'serve') serve();
    else if (process.argv[2] === 'disable') disable();
    else if (process.argv[2] === 'helper') {
      const deadline = setTimeout(() => process.exit(0), 18000);
      try { await runHelper(process.argv[3]); } finally { clearTimeout(deadline); }
    }
  } catch { process.stderr.write('宿主 Git 凭据连接不可用\n'); process.exitCode = 1; }
}
