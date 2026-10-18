import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@xterm/xterm/css/xterm.css';
import { renderStatusLine } from '../docker/rootfs/opt/tdc/statusline-display.mjs';
const terminal = new Terminal({ allowProposedApi: true, fontFamily: '"JetBrains Mono", Consolas, "Microsoft YaHei UI", monospace', fontSize: 15, lineHeight: 1.5, theme: { background: '#121317', foreground: '#e6edf3' }, screenReaderMode: true });
const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(document.getElementById('terminal'));
terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';
const normal = { context_window_size: 1000000, effort_level: 'xhigh', context_used_percentage: 20, thinking_enabled: true };
let values = normal;
function render() {
  fit.fit(); terminal.clear();
  const requested = Number(document.getElementById('width').value);
  if (requested) terminal.resize(Math.min(requested, terminal.cols), terminal.rows);
  const rule = '\x1b[38;2;55;64;78m' + '─'.repeat(terminal.cols - 2) + '\x1b[0m';
  const line = renderStatusLine({}, { ...values, model: { display_name: 'Opus 5.5' }, cwd: '/workspace/tht-docker-claude', git_branch: 'main' }, terminal.cols);
  terminal.write('\x1b[0m\x1b[H\x1b[2J' + [rule, '❯ ', rule, ...line.split('\n'), '\x1b[38;2;78;160;145mplan mode on\x1b[0m \x1b[38;2;139;148;158m(shift+tab to cycle)\x1b[0m'].join('\r\n'));
  document.getElementById('dimensions').textContent = `${terminal.cols} 列 · ${line.split('\n').length} 行状态信息 · 6 项实时字段`;
}
const states = {
  standard: normal,
  warning: { ...normal, context_used_percentage: 40 },
  elevated: { ...normal, context_used_percentage: 60 },
  full: { ...normal, effort_level: 'max', context_used_percentage: 92 },
  unknown: { ...normal, context_used_percentage: null },
  small: { ...normal, context_window_size: 200000, thinking_enabled: false, context_used_percentage: 30 },
};
for (const [id, state] of Object.entries(states)) document.getElementById(id).onclick = () => {
  values = state;
  for (const other of Object.keys(states)) document.getElementById(other).setAttribute('aria-pressed', String(other === id));
  render();
};
document.getElementById('width').onchange = render;
document.fonts.ready.then(render);
const observer = new ResizeObserver(render); observer.observe(document.getElementById('terminal'));
import.meta.hot?.dispose(() => { observer.disconnect(); terminal.dispose(); });
