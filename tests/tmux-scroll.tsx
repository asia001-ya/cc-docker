import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import '../src/styles.css';
import { TmuxScrollbar } from '../src/components/terminal/TmuxScrollbar';
import type { ScrollbackState } from '../src/api/types';

const base = `http://127.0.0.1:${new URLSearchParams(location.search).get('port')}`;
let terminal: Terminal;
let report = (_state: ScrollbackState, _ms: number) => {};
const getTerminal = () => terminal;
const load = async (_id: string, offsetRows?: number): Promise<ScrollbackState> => {
  const started = performance.now();
  const response = await fetch(`${base}/scrollback`, offsetRows === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offsetRows }) });
  const state = await response.json();
  if (!response.ok) throw new Error(state.error);
  report(state, performance.now() - started);
  return state;
};
function Fixture() {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('正在附着独立测试会话…');
  const [selection, setSelection] = useState('');
  const [mouseReports, setMouseReports] = useState(0);
  useEffect(() => {
    terminal = new Terminal({ allowProposedApi: true, cols: 84, rows: 16, fontSize: 12, lineHeight: 1.2, theme: { background: '#121317' } });
    terminal.open(host.current!);
    terminal.loadAddon(new WebglAddon());
    report = (state, ms) => {
      setStatus(`本地 xterm 历史：${terminal.buffer.active.baseY} 行（${terminal.buffer.active.type}）\n容器 tmux 历史：${state.historyRows} 行　距底部：${state.offsetRows} 行　历史浏览：${state.inCopyMode ? '保持中' : '实时输出'}\n最近请求：${ms.toFixed(1)} ms`);
      // clearSelection 后又拖选相同坐标时，xterm 不一定再次发 onSelectionChange。
      setSelection(terminal.getSelection());
    };
    terminal.onSelectionChange(() => setSelection(terminal.getSelection()));
    let input = Promise.resolve();
    terminal.onData(data => {
      if (/\x1b\[</.test(data)) setMouseReports(count => count + 1);
      input = input.then(async () => {
        const response = await fetch(`${base}/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
        if (!response.ok) throw new Error('QA input failed');
      }).catch(error => setStatus(String(error)));
    });
    const events = new EventSource(`${base}/events`);
    events.onmessage = event => terminal.write(JSON.parse(event.data));
    return () => { report = () => {}; events.close(); terminal.dispose(); };
  }, []);
  return <main style={{ padding: 20 }}>
    <h1 style={{ marginBottom: 12 }}>真实容器历史 · 独立 tmux 测试会话</h1>
    <div style={{ position: 'relative', width: 650, height: 285, border: '1px solid #4b5563' }}>
      <div ref={host} id="terminal-qa" style={{ height: '100%', padding: '4px 0 0 6px', overflow: 'hidden' }} />
      <TmuxScrollbar sessionId="qa" theme="fluent" load={load} containerRef={host} getTerminal={getTerminal} />
    </div>
    <pre style={{ marginTop: 16, fontSize: 14, whiteSpace: 'pre-wrap' }}>{status}</pre>
    <pre style={{ marginTop: 12, fontSize: 14, whiteSpace: 'pre-wrap' }}>鼠标协议发送：{mouseReports} 次{'\n'}本地选中文字：{selection || '（尚未选择）'}</pre>
    <p style={{ marginTop: 12, color: '#a0aec0' }}>拖动右侧滑块后松手；数字应连续，容器保持所选历史位置。End 返回底部。</p>
  </main>;
}
const root = createRoot(document.getElementById('qa-root')!);
root.render(<Fixture />);
import.meta.hot?.dispose(() => root.unmount());
