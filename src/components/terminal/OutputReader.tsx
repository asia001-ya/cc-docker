import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { OutputItem, OutputSnapshot, SessionRecord } from "../../api/types";
import { errorText, isTauri, termOutputs } from "../../api/commands";
import { emptyOutputs, mergeOutputs, outputLink, type OutputReaderState } from "../../lib/outputReader";
import { useTabStore } from "../../store/tabStore";
import { Icon, IconButton } from "../ui/controls";
import { openExternal } from "./xtermPool";

type Memory = { data: OutputReaderState; open: boolean; collapsed: boolean; scroll: Map<string, number> };
const memory = new Map<string, Memory>();
const labels = { plan: "计划", document: "文档" };
const icons = { plan: "checklist", document: "description" };

const MarkdownBody = memo(function MarkdownBody({ markdown }: { markdown: string }) {
  return <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => {
      const url = outputLink(href);
      return url ? <a href={url} onClick={event => { event.preventDefault(); openExternal(url); }}>{children}</a> : <span>{children}</span>;
    },
    img: ({ alt }) => <span className="output-image-label">[图片{alt ? `：${alt}` : ""}]</span>,
    table: ({ children }) => <div className="output-table-scroll"><table>{children}</table></div>,
  }}>{markdown}</Markdown>;
});

export interface OutputReaderProps {
  session: SessionRecord;
  load?: (id: string, revision?: string | null) => Promise<OutputSnapshot>;
}

/** One reader for the focused terminal. Overlaying it never changes the PTY dimensions. */
export function OutputReader({ session, load = termOutputs }: OutputReaderProps) {
  const saved = useRef(memory.get(session.id));
  const [data, setData] = useState<OutputReaderState>(() => saved.current?.data ?? emptyOutputs());
  const [open, setOpen] = useState(saved.current?.open ?? false);
  const [collapsed, setCollapsed] = useState(saved.current?.collapsed ?? false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!saved.current?.data.items.length);
  const [refresh, setRefresh] = useState(0);
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const cardButton = useRef<HTMLButtonElement>(null);
  const positions = useRef(saved.current?.scroll ?? new Map<string, number>());
  const latest = useRef({ data, open, collapsed });
  latest.current = { data, open, collapsed };
  const item = data.items.find(item => item.id === data.selectedId);
  const positionKey = `${data.conversationId}:${item?.id}`;
  const filtered = data.items.filter(item => `${item.title} ${labels[item.kind]}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      if (document.visibilityState === "hidden") { timer = setTimeout(read, 2500); return; }
      try {
        const result = await load(session.id, latest.current.data.revision);
        if (disposed) return;
        setData(previous => mergeOutputs(previous, result));
        setError("");
      } catch (cause) {
        if (!disposed) setError(errorText(cause));
      } finally {
        if (!disposed) { setLoading(false); timer = setTimeout(read, 3000); }
      }
    };
    void read();
    return () => { disposed = true; clearTimeout(timer); };
  }, [session.id, load, refresh]);

  useEffect(() => () => {
    memory.delete(session.id);
    memory.set(session.id, { ...latest.current, scroll: positions.current });
    while (memory.size > 12) memory.delete(memory.keys().next().value!);
  }, [session.id]);

  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = positions.current.get(positionKey) ?? 0;
    setCopied(false);
  }, [positionKey, open]);
  useEffect(() => { if (open) closeButton.current?.focus(); }, [open]);
  const close = () => { setOpen(false); requestAnimationFrame(() => cardButton.current?.focus()); };
  const choose = (next: OutputItem) => { setData(current => ({ ...current, selectedId: next.id })); setOpen(true); };
  const copy = async () => {
    if (!item) return;
    try { await navigator.clipboard.writeText(item.markdown); setCopied(true); } catch { setError("复制失败，请选中文字后复制"); }
  };
  const empty = loading ? "正在读取文档…" : data.status === "missing" ? "暂时找不到此会话的文档记录" : "生成计划或实现类 Markdown 文件后显示在这里";
  const briefError = error ? "暂时无法读取，点击刷新重试" : "";

  return <div className="output-reader-layer" onKeyDown={event => {
    event.stopPropagation();
    if (event.key === "Escape" && open) { event.preventDefault(); close(); }
  }}>
    {!open && <section className={`output-card ${collapsed ? "is-collapsed" : ""}`} aria-label="输出内容目录">
      <div className="output-card-heading">
        <button ref={cardButton} type="button" className="output-card-toggle" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>
          <Icon name="article" size={17} /><span>输出内容</span><span className="output-count">{data.items.length || ""}</span>
          <Icon name={collapsed ? "expand_more" : "expand_less"} size={16} />
        </button>
        {!collapsed && <IconButton icon="refresh" title="刷新输出内容" onClick={() => setRefresh(value => value + 1)} />}
      </div>
      {!collapsed && <>
        <p className="output-session" title={`${session.title} · ${session.container}`}>{session.title} · {session.container}</p>
        <div className="output-card-list">
          {data.items.slice(0, 5).map((entry, index) => <button type="button" key={entry.id} className="output-card-item" title={`${entry.title}\n${entry.filePath}`} onClick={() => choose(entry)}>
            <Icon name={icons[entry.kind]} size={18} /><span>{entry.title}</span>{index === 0 && <i>最新</i>}<Icon name="chevron_right" size={16} />
          </button>)}
          {!data.items.length && <p className="output-empty">{briefError || empty}</p>}
        </div>
        {data.items.length > 0 && <button type="button" className="output-view-all" onClick={() => setOpen(true)}><Icon name="library_books" size={15} />查看全部 {data.items.length} 项</button>}
        {error && data.items.length > 0 && <p className="output-notice">{briefError}</p>}
      </>}
    </section>}
    {open && <section className="output-reading-panel" aria-label="输出阅读面板">
      <header className="output-panel-heading">
        <Icon name="article" size={19} /><div><strong>输出内容</strong><span title={session.title}>{session.title}</span></div>
        <IconButton icon="refresh" title="刷新输出内容" onClick={() => setRefresh(value => value + 1)} />
        <IconButton icon={copied ? "done" : "content_copy"} title={copied ? "已复制" : item?.truncated ? "复制已读取 Markdown" : "复制完整 Markdown"} disabled={!item} onClick={() => void copy()} />
        <button ref={closeButton} type="button" className="output-close" aria-label="关闭阅读面板" title="关闭（Esc）" onClick={close}><Icon name="close" size={20} /></button>
      </header>
      <div className="output-selector">
        <input aria-label="搜索输出标题" placeholder="搜索输出标题…" value={filter} onChange={event => setFilter(event.target.value)} />
        <select aria-label="选择输出内容" value={filtered.some(entry => entry.id === data.selectedId) ? data.selectedId ?? "" : ""} onChange={event => {
          const next = data.items.find(entry => entry.id === event.target.value); if (next) choose(next);
        }}>
          {!filtered.some(entry => entry.id === data.selectedId) && <option value="" disabled>{filtered.length ? "选择一项输出" : "没有匹配的标题"}</option>}
          {filtered.map(entry => <option key={entry.id} value={entry.id}>{labels[entry.kind]} · {entry.title}</option>)}
        </select>
      </div>
      {error && <p className="output-notice" role="status">{briefError}，已读取内容仍可阅读。</p>}
      {data.items[0] && data.items[0].id !== item?.id && <button type="button" className="output-latest" onClick={() => choose(data.items[0])}>查看最新输出：{data.items[0].title}<Icon name="arrow_forward" size={15} /></button>}
      <div ref={body} className="output-reading-body" tabIndex={0} aria-label="输出正文" onScroll={event => positions.current.set(positionKey, event.currentTarget.scrollTop)}>
        {item && <div className="output-document-heading"><div><span>{labels[item.kind]}</span><span>{item.timestamp && !Number.isNaN(Date.parse(item.timestamp)) ? new Date(item.timestamp).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""}</span><span>{item.markdown.length.toLocaleString()} 字符</span></div><p className="output-file-path" title={item.filePath}>{item.filePath}</p></div>}
        {item ? <article className="output-markdown"><MarkdownBody markdown={item.markdown} />{item.truncated && <p className="output-notice">此条内容过长，当前显示前 256 Ki 字符。</p>}</article> : <p className="output-empty">{empty}</p>}
      </div>
      <footer className="output-panel-footer"><span>独立阅读 · 滚动位置已保留</span><span>{data.limited ? "仅展示最近可读取的输出" : `${data.items.length} 项输出`}</span></footer>
    </section>}
  </div>;
}

export function ActiveOutputReader() {
  const session = useTabStore(state => {
    const id = state.tabs.find(tab => tab.id === state.activeTabId)?.activeSessionId;
    return id ? state.sessions[id] : undefined;
  });
  // The browser demo has no container transcript. Fixtures supply their own loader.
  return session && isTauri() ? <OutputReader key={session.id} session={session} /> : null;
}
