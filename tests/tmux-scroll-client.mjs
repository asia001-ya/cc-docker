// Test-only client for the same persistent line protocol used by the Rust backend.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
export const script = readFileSync(new URL('../src-tauri/src/terminal/tmux-scroll.sh', import.meta.url), 'utf8');

export function connectScroll(container, socket, target) {
  const wrapper = `tmux() { command tmux -L '${socket}' "$@"; }\n`;
  const child = spawn('docker', ['exec', '-i', '-u', 'node', container, 'sh', '-c', wrapper + script, 'scroll-test', target, '--stream'], { windowsHide: true });
  let pending = '';
  let tail = Promise.resolve();
  let waiting;
  const fail = (error) => { waiting?.reject(error); waiting = undefined; };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    pending += data;
    const end = pending.indexOf('\n');
    if (end < 0 || !waiting) return;
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    if (line.startsWith('ok|')) waiting.resolve(line.slice(3).split('|'));
    else waiting.reject(new Error(line));
    waiting = undefined;
  });
  child.on('error', fail);
  child.on('exit', () => fail(new Error('scroll worker exited')));
  child.stdin.on('error', fail);
  child.stderr.on('data', data => process.stderr.write(data));
  return {
    request(offset) {
      const response = tail.then(() => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { fail(new Error('scroll timeout')); child.kill(); }, 4000);
        waiting = { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } };
        child.stdin.write(`${offset ?? 'get'}\n`);
      }));
      tail = response.catch(() => {});
      return response;
    },
    close() { child.stdin.end(); },
  };
}
