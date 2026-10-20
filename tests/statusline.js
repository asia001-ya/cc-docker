import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/fira-code/400.css';
import '@fontsource/fira-code/700.css';
import '@xterm/xterm/css/xterm.css';
import { renderStatusLine } from '../docker/rootfs/opt/tdc/statusline-display.mjs';
import { fontStack } from '../src/lib/themes';
import { statuslineFontReady } from '../src/lib/statuslineFont';
const terminal = new Terminal({ allowProposedApi: true, fontFamily: fontStack('Consolas'), fontSize: 16, lineHeight: 1.2, customGlyphs: true, minimumContrastRatio: 1, theme: { background: '#121317', foreground: '#e6edf3' }, screenReaderMode: true });
const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(document.getElementById('terminal'));
terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';
const normal = { context_window_size: 1000000, effort_level: 'xhigh', context_used_percentage: 20, thinking_enabled: true };
let values = normal;
let webgl = null;
function render() {
  terminal.options.fontFamily = fontStack(document.getElementById('font').value);
  terminal.options.fontSize = Number(document.getElementById('size').value);
  terminal.options.lineHeight = Number(document.getElementById('line-height').value);
  const useWebgl = document.getElementById('renderer').value === 'webgl';
  if (!useWebgl && webgl) { webgl.dispose(); webgl = null; }
  if (useWebgl && !webgl) {
    try { webgl = new WebglAddon(); terminal.loadAddon(webgl); }
    catch { webgl = null; document.getElementById('renderer').value = 'dom'; }
  }
  fit.fit(); terminal.clear();
  const requested = Number(document.getElementById('width').value);
  if (requested) terminal.resize(Math.min(requested, terminal.cols), terminal.rows);
  const rule = '\x1b[38;2;55;64;78m' + '─'.repeat(terminal.cols - 2) + '\x1b[0m';
  const line = renderStatusLine({}, { ...values, model: { display_name: 'Opus 5.5' }, cwd: '/workspace/tht-docker-claude', git_branch: 'main' }, terminal.cols);
  terminal.write('\x1b[0m\x1b[H\x1b[2J' + [rule, '❯ ', rule, ...line.split('\n'), '\x1b[38;2;78;160;145mplan mode on\x1b[0m \x1b[38;2;139;148;158m(shift+tab to cycle)\x1b[0m'].join('\r\n'));
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `${terminal.options.fontSize}px ${terminal.options.fontFamily}`;
  const bounds = ['■', '∖'].map(char => {
    const glyph = measure.measureText(char);
    return { top: glyph.actualBoundingBoxAscent, bottom: glyph.actualBoundingBoxDescent, width: glyph.width };
  });
  const matched = bounds[0].top === bounds[1].top && bounds[0].bottom === bounds[1].bottom && bounds[0].width === bounds[1].width;
  document.getElementById('dimensions').textContent = `${terminal.cols} 列 · ${line.split('\n').length} 行状态信息 · ${webgl ? 'WebGL' : 'DOM'} · ■/∖ ${matched ? '等高' : '未对齐'} (${bounds.map(b => `${b.top}/${b.bottom}`).join(' · ')})`;
}
const states = {
  low: { ...normal, context_used_percentage: 6 },
  empty: { ...normal, context_used_percentage: 0 },
  standard: normal,
  warning: { ...normal, context_used_percentage: 40 },
  elevated: { ...normal, context_used_percentage: 60 },
  full: { ...normal, effort_level: 'max', context_used_percentage: 92 },
  complete: { ...normal, context_used_percentage: 100 },
  unknown: { ...normal, context_used_percentage: null },
  small: { ...normal, context_window_size: 200000, thinking_enabled: false, context_used_percentage: 30 },
};
for (const [id, state] of Object.entries(states)) document.getElementById(id).onclick = () => {
  values = state;
  for (const other of Object.keys(states)) document.getElementById(other).setAttribute('aria-pressed', String(other === id));
  render();
};
for (const id of ['width', 'font', 'renderer', 'size', 'line-height']) document.getElementById(id).onchange = render;
const observer = new ResizeObserver(render);
Promise.all([document.fonts.ready, statuslineFontReady]).then(() => {
  render();
  observer.observe(document.getElementById('terminal'));
});
import.meta.hot?.dispose(() => { observer.disconnect(); webgl?.dispose(); terminal.dispose(); });
