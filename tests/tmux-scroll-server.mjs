// Local, opt-in visual regression bridge to a private tmux server. No user sessions are accessed.
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { connectScroll } from './tmux-scroll-client.mjs';
const container = process.env.TDC_TEST_CONTAINER;
if (!container) throw new Error('Set TDC_TEST_CONTAINER');
const socket = `tdc-scroll-visual-${process.pid}`;
const target = '=tdc-scroll-qa:0.0';
const docker = (args) => {
  const result = spawnSync('docker', ['exec', '-u', 'node', container, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
};
docker(['tmux', '-L', socket, '-f', '/etc/tmux.conf', 'new-session', '-d', '-s', 'tdc-scroll-qa', '-x', '84', '-y', '16', 'sh', '-c', 'awk \'BEGIN {for(i=1;i<=300;i++) printf "ROW %04d | real tmux history\\n", i}\'; sleep 3600']);
// script allocates the test PTY while Docker stdin remains a pipe (including on Windows).
const client = spawn('docker', ['exec', '-i', '-u', 'node', '-e', 'TERM=xterm-256color', container, 'script', '-qefc', `stty raw -echo cols 84 rows 16; exec tmux -L ${socket} attach-session -t tdc-scroll-qa`, '/dev/null'], { windowsHide: true });
const scrollClient = connectScroll(container, socket, target);
const streams = new Set();
let output = '';
client.stdout.setEncoding('utf8');
client.stdout.on('data', data => {
  output += data;
  for (const stream of streams) stream.write(`data: ${JSON.stringify(data)}\n\n`);
});
client.stderr.on('data', data => process.stderr.write(data));
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5420');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.end(); return; }
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/events') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      streams.add(res);
      res.write(`data: ${JSON.stringify(output)}\n\n`);
      req.on('close', () => streams.delete(res));
    } else if (url.pathname === '/output') {
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      res.end(JSON.stringify({ data: output.slice(offset), offset: output.length }));
    } else if (url.pathname === '/input' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { data } = JSON.parse(Buffer.concat(chunks).toString());
      if (typeof data !== 'string' || data.length > 8192) throw new Error('Invalid input');
      // Only the private QA pane receives input; exercise actual tmux mouse-up bindings.
      client.stdin.write(data);
      res.end('{}');
    } else if (url.pathname === '/scrollback') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      if (body.offsetRows !== undefined) {
        if (!Number.isSafeInteger(body.offsetRows) || body.offsetRows < 0) throw new Error('Invalid offset');
      }
      const [history, offset, rows, mode, alternate] = await scrollClient.request(body.offsetRows);
      res.end(JSON.stringify({ historyRows: Number(history), offsetRows: Number(offset), viewportRows: Number(rows), inCopyMode: mode === 'copy-mode', available: alternate === '0' && (!mode || mode === 'copy-mode'), alternateScreen: alternate === '1' }));
    } else { res.statusCode = 404; res.end('{}'); }
  } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
});
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  scrollClient.close();
  client.kill();
  try { docker(['tmux', '-L', socket, 'kill-server']); } catch {}
  server.close();
  process.exit();
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
server.listen(0, '127.0.0.1', () => console.log(`Visual QA: http://localhost:5420/tests/tmux-scroll.html?port=${server.address().port}`));
