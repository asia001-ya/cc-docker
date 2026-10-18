import { useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "../../api/commands";
import { filterSessionCatalog, type SessionCatalogItem } from "../../lib/sessionCatalog";
import { Modal } from "../ui/Modal";
import { Button, Icon, Input, Select } from "../ui/controls";

export interface SessionListModalProps {
  items: SessionCatalogItem[];
  onActivate: (item: SessionCatalogItem) => Promise<void>;
  onClose: () => void;
  onRefresh?: () => Promise<void>;
}

type Kind = "all" | "open" | "history";
const KINDS: { value: Kind; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "open", label: "已打开" },
  { value: "history", label: "历史" },
];

function blockedReason(item: SessionCatalogItem): string | null {
  if (item.kind === "open") return null;
  if (!item.containerRunning) return "容器未运行";
  if (!item.cwd) return "历史未记录目录";
  if (!item.claudeSessionId) return "缺少会话记录";
  return null;
}

/** 浏览现有终端和历史会话；恢复由主程序在新终端中执行。 */
export function SessionListModal({ items, onActivate, onClose, onRefresh }: SessionListModalProps) {
  const [query, setQuery] = useState("");
  const [container, setContainer] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 同一轮渲染中的连击也只能触发一次恢复，避免创建重复终端。
  const actionInFlight = useRef(false);
  const busy = pendingKey !== null || refreshing;
  const containers = useMemo(() => [...new Set(items.map((item) => item.container))].sort((a, b) => a.localeCompare(b)), [items]);
  const matching = useMemo(() => filterSessionCatalog(items, { container, query }), [items, container, query]);
  const visible = useMemo(() => filterSessionCatalog(matching, { kind }), [matching, kind]);
  const counts = {
    all: matching.length,
    open: matching.filter((item) => item.kind === "open").length,
    history: matching.filter((item) => item.kind === "history").length,
  };

  useEffect(() => {
    if (container && !containers.includes(container)) setContainer("");
  }, [container, containers]);

  const close = () => {
    if (!actionInFlight.current) onClose();
  };

  const activate = async (item: SessionCatalogItem) => {
    if (actionInFlight.current || item.isActive || blockedReason(item)) return;
    actionInFlight.current = true;
    setPendingKey(item.key);
    setError(null);
    try {
      await onActivate(item);
    } catch (cause) {
      setError(`${item.kind === "open" ? "切换" : "恢复"}「${item.title}」失败：${errorText(cause)}`);
    } finally {
      actionInFlight.current = false;
      setPendingKey(null);
    }
  };

  const refresh = async () => {
    if (!onRefresh || actionInFlight.current) return;
    actionInFlight.current = true;
    setRefreshing(true);
    setError(null);
    try {
      await onRefresh();
    } catch (cause) {
      setError(`刷新会话列表失败：${errorText(cause)}`);
    } finally {
      actionInFlight.current = false;
      setRefreshing(false);
    }
  };

  return (
    <Modal
      title="会话列表"
      icon="view_list"
      badge={String(items.length)}
      width={860}
      onClose={close}
      footerLeft={
        <span className="font-ui text-label-md text-on-surface-variant">
          显示 {visible.length} / {items.length} 条
          <span className="hidden sm:inline"> · 历史会话在新终端中恢复</span>
        </span>
      }
      footer={<Button disabled={busy} onClick={close}>关闭</Button>}
    >
      <div className="flex min-h-0 flex-col gap-3" style={{ height: "min(560px, calc(92vh - 152px))" }}>
        <div className="flex shrink-0 gap-2">
          <div className="relative min-w-0 flex-1">
            <Icon name="search" className="pointer-events-none absolute left-2.5 top-2 text-outline" />
            <Input
              aria-label="搜索会话"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索名称、项目或目录"
              className="pl-8"
              disabled={busy}
              data-autofocus
            />
          </div>
          {onRefresh && (
            <Button icon="refresh" disabled={busy} onClick={() => void refresh()}>
              {refreshing ? "刷新中…" : "刷新"}
            </Button>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <div role="group" aria-label="会话类型" className="inline-flex rounded-lg bg-black/20 p-0.5">
            {KINDS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={kind === option.value}
                disabled={busy}
                onClick={() => setKind(option.value)}
                className={`h-7 rounded-md px-3 font-ui text-body-sm transition-colors disabled:cursor-not-allowed ${kind === option.value ? "bg-accent/15 text-accent" : "text-on-surface-variant hover:bg-white/[0.06]"}`}
              >
                {option.label} <span className="ml-1 text-label-sm opacity-70">{counts[option.value]}</span>
              </button>
            ))}
          </div>
          <Select aria-label="按容器筛选" className="!w-auto min-w-40 max-w-full" value={container} disabled={busy} onChange={(event) => setContainer(event.target.value)}>
            <option value="">全部容器</option>
            {containers.map((name) => <option key={name} value={name}>{name}</option>)}
          </Select>
        </div>
        {error && <div role="alert" className="shrink-0 rounded-lg border border-st-bad/25 bg-st-bad/10 px-3 py-2 font-ui text-body-sm text-st-bad">{error}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1" aria-busy={busy}>
          {visible.length === 0 ? (
            <div className="flex min-h-32 flex-col items-center justify-center gap-2 py-8 text-center font-ui text-body-md text-on-surface-variant">
              <Icon name={items.length ? "search_off" : "history"} size={28} className="text-outline" />
              <span>{items.length ? "没有符合筛选条件的会话" : "还没有可显示的会话"}</span>
              {items.length > 0 && <span className="text-body-sm text-outline">试试其他关键词或选择全部容器</span>}
            </div>
          ) : (
            <ul aria-label="会话" className="flex flex-col gap-2">
              {visible.map((item) => {
                const reason = blockedReason(item);
                const pending = pendingKey === item.key;
                const status = item.exited ? "已结束" : item.kind === "open" ? "已打开" : "历史";
                const tooltip = [item.title, item.claudeSessionId && `Claude 会话 ID：${item.claudeSessionId}`, item.openSessionId && `终端 ID：${item.openSessionId}`].filter(Boolean).join("\n");
                return (
                  <li key={item.key} className={`flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-start ${item.isActive ? "border-accent/35 bg-accent/[0.06]" : "border-white/[0.07] bg-white/[0.025]"}`}>
                    <div className="flex min-w-0 flex-1 gap-2.5">
                      <Icon name={item.kind === "open" ? "terminal" : "history"} size={19} className={`mt-0.5 shrink-0 ${item.isActive ? "text-accent" : "text-outline"}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 truncate font-ui text-body-md font-medium text-on-surface" title={tooltip}>{item.title}</span>
                          <span className={`shrink-0 rounded px-1.5 py-0.5 font-ui text-label-sm ${item.exited ? "bg-white/[0.05] text-outline" : item.kind === "open" ? "bg-st-ok/10 text-st-ok" : "bg-white/[0.05] text-on-surface-variant"}`}>{status}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-ui text-label-sm text-on-surface-variant">
                          <span>{item.container}</span>
                          <span>{item.updatedLabel}</span>
                        </div>
                        <div className="mt-1 truncate font-mono text-code-sm text-outline" title={item.cwd ?? undefined}>{item.cwd ?? "未记录工作目录"}</div>
                        {reason && <div className="mt-1 font-ui text-label-sm text-st-warn">{reason}</div>}
                      </div>
                    </div>
                    <Button
                      className="self-end sm:self-start"
                      variant={item.kind === "history" && !reason ? "primary" : "standard"}
                      disabled={busy || item.isActive || !!reason}
                      title={reason ?? (item.kind === "history" ? "在新的终端标签页中恢复此会话" : undefined)}
                      onClick={() => void activate(item)}
                    >
                      {pending ? item.kind === "open" ? "正在切换…" : "正在恢复…" : item.isActive ? "当前" : item.kind === "open" ? "切换" : "新终端恢复"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
