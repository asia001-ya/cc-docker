// Manual regression fixture, served by Vite; uses the app's actual terminal options and styles.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { termOptions } from '../src/components/terminal/xtermPool';
import { DEFAULT_SETTINGS } from '../src/lib/demo';
import { bindTerminalHistoryScroll } from '../src/lib/terminalScroll';
import '@fontsource/jetbrains-mono/400.css';
import '@xterm/xterm/css/xterm.css';
import '../src/styles.css';

const host = document.querySelector('#terminal');
const status = document.querySelector('#status');
const events = document.querySelector('#events');
const term = new Terminal(termOptions(DEFAULT_SETTINGS.terminal));
const fit = new FitAddon();
term.loadAddon(fit);
term.open(host);
let unbindHistory = bindTerminalHistoryScroll(host, term);
let count = 0;
let mouse = false;
let webgl;
let live;
let inputs = 0;
const log = [];
const record = (message) => { log.push(message); events.textContent = log.slice(-10).join('\n'); };
const update = () => {
  const b = term.buffer.active;
  const numbers = Array.from({ length: term.rows }, (_, i) => b.getLine(b.viewportY + i)?.translateToString(true) ?? '')
    .filter(Boolean).map(line => Number(line.match(/^ROW (\d+)/)?.[1]));
  const ordered = numbers.every((n, i) => Number.isFinite(n) && (i === 0 || n === numbers[i - 1] + 1));
  status.textContent = `viewport=${b.viewportY} bottom=${b.baseY} size=${term.cols}x${term.rows} ordered=${ordered} PTY inputs=${inputs}\n` +
    `first=${b.getLine(b.viewportY)?.translateToString(true)}\nlast=${b.getLine(b.viewportY + term.rows - 1)?.translateToString(true)}`;
};
const append = (n) => term.write(Array.from({ length: n }, () => `ROW ${String(++count).padStart(4, '0')} | ordered scrollback\r\n`).join(''), update);
document.querySelector('#seed').onclick = () => {
  term.reset(); count = 0; mouse = false;
  document.querySelector('#mouse').textContent = 'Mouse reporting: off';
  fit.fit(); append(300); log.length = 0; inputs = 0; events.textContent = '';
};
document.querySelector('#append').onclick = () => append(10);
document.querySelector('#mouse').onclick = (e) => {
  mouse = !mouse;
  term.write(mouse ? '\x1b[?1003h\x1b[?1006h' : '\x1b[?1003l\x1b[?1006l');
  e.target.textContent = `Mouse reporting: ${mouse ? 'on' : 'off'}`;
};
document.querySelector('#renderer').onclick = (e) => {
  if (webgl) { webgl.dispose(); webgl = undefined; }
  else { webgl = new WebglAddon(); term.loadAddon(webgl); }
  fit.fit();
  e.target.textContent = `Renderer: ${webgl ? 'WebGL' : 'DOM'}`;
};
term.onScroll((y) => { record(`scroll ${y}`); update(); });
term.onRender(update);
term.onData((data) => { inputs++; record(`PTY input ${JSON.stringify(data)}`); update(); });
document.querySelector('#guard').onclick = (e) => {
  if (unbindHistory) { unbindHistory(); unbindHistory = undefined; }
  else unbindHistory = bindTerminalHistoryScroll(host, term);
  e.target.textContent = `History guard: ${unbindHistory ? 'on' : 'off'}`;
};
document.querySelector('#live').onclick = (e) => {
  if (live) { clearInterval(live); live = undefined; }
  else live = setInterval(() => append(1), 120);
  e.target.textContent = `Live output: ${live ? 'on' : 'off'}`;
};
for (const name of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
  host.addEventListener(name, (e) => record(`${name} ${e.target.className}`), true);
}
await document.fonts.ready;
document.querySelector('#seed').click();
