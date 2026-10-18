import { useEffect, useMemo, useRef, useState } from "react";
import { containerList, errorText, isTauri, usageEnable, usageQuery, usageRefresh } from "../../api/commands";
import type { ContainerInfo, UsageAuthType, UsageCollectionContainer, UsageContainerSummary, UsageLog, UsageMetrics, UsageQuery, UsageResult, UsageTrendPoint } from "../../api/types";
import { displayUsageTrend, formatUsageCompact, formatUsageCost, formatUsageNumber, formatUsagePercent, formatUsageSpeed, localDateInput, partitionUsageContainers, usageDateRange, USAGE_RANGES, ZERO_USAGE, type TrendMetric, type UsageRange } from "../../lib/usage";
import { queryUsageDemo } from "../../lib/usageDemo";
import { useFleetStore } from "../../store/fleetStore";
import { useUiStore } from "../../store/uiStore";
import { Modal } from "../ui/Modal";
import { Button, Callout, Icon, Input, Select } from "../ui/controls";

const AUTH_LABEL: Record<UsageAuthType, string> = { api: "API", authorization: "授权", unknown: "未知" };
const TREND_METRICS: { value: TrendMetric; label: string }[] = [{ value: "costUsd", label: "成本" }, { value: "requests", label: "请求" }, { value: "totalTokens", label: "Token" }];
type ContainerPresence = "current" | "archived" | "unknown";

function timestampText(value: number | null): string {
  return value === null ? "尚未采集" : new Date(value * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function CollectionBadge({ collection, historical = false, presence = "current" }: { collection: UsageCollectionContainer; historical?: boolean; presence?: ContainerPresence }) {
  const labels = { active: "正在采集", stopped: "已停止", unsupported: "待启用采集", error: "采集异常" };
  const inactive = historical || presence !== "current";
  const title = historical ? "旧记录缺少容器归属信息" : presence === "archived" ? "该容器已不在当前列表中，用量记录仍然保留" : presence === "unknown" ? "暂时无法读取当前容器列表，显示已保存的用量记录" : collection.error ?? `最近采集：${timestampText(collection.lastCollectedAt)}`;
  return <span title={title} className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-label-sm ${inactive ? "bg-white/[0.06] text-outline" : collection.status === "active" ? "bg-st-ok/10 text-st-ok" : collection.status === "error" ? "bg-st-bad/10 text-st-bad" : collection.status === "unsupported" ? "bg-st-warn/10 text-st-warn" : "bg-white/[0.06] text-outline"}`}>
    {!inactive && <span className="h-1 w-1 rounded-full bg-current" />}{historical ? "历史归属未知" : presence === "archived" ? "仅历史记录" : presence === "unknown" ? "状态未确认" : labels[collection.status]}
  </span>;
}

function StatCard({ label, value, detail, icon, accent = false }: { label: string; value: string; detail: string; icon: string; accent?: boolean }) {
  return <div className={`min-w-0 rounded-xl border p-3.5 ${accent ? "border-accent/25 bg-accent/[0.08]" : "border-white/[0.07] bg-white/[0.025]"}`}>
    <div className="flex items-center justify-between gap-2 text-body-sm text-on-surface-variant"><span>{label}</span><Icon name={icon} className={accent ? "text-accent" : "text-outline"} /></div>
    <div className={`mt-2 truncate font-mono text-[23px] font-semibold leading-tight tabular-nums ${accent ? "text-accent" : "text-on-surface"}`} title={value}>{value}</div>
    <div className="mt-1.5 truncate text-label-sm text-outline" title={detail}>{detail}</div>
  </div>;
}

function SummaryCards({ metrics }: { metrics: UsageMetrics }) {
  const input = metrics.inputTokens + metrics.cacheReadTokens + metrics.cacheWriteTokens;
  return <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3 xl:grid-cols-6">
    <StatCard label="估算费用 · USD" value={formatUsageCost(metrics.costUsd)} detail="按请求所属供应商的当前定价重算" icon="payments" accent />
    <StatCard label="请求数" value={formatUsageNumber(metrics.requests)} detail="有 token 记录的模型响应" icon="swap_vert" />
    <StatCard label="Token 总量" value={formatUsageCompact(metrics.totalTokens)} detail={`输入 ${formatUsageNumber(metrics.inputTokens)} · 输出 ${formatUsageNumber(metrics.outputTokens)}`} icon="token" />
    <StatCard label="缓存读取 token" value={formatUsageCompact(metrics.cacheReadTokens)} detail="命中已有缓存的输入" icon="cached" />
    <StatCard label="缓存写入 token" value={formatUsageCompact(metrics.cacheWriteTokens)} detail="新建缓存的输入" icon="save" />
    <StatCard label="缓存命中率" value={formatUsagePercent(metrics.cacheHitRate, input > 0)} detail="缓存读取 ÷ 全部输入 token" icon="percent" />
  </div>;
}

function TrendChart({ points, monthly }: { points: UsageTrendPoint[]; monthly: boolean }) {
  const [metric, setMetric] = useState<TrendMetric>("costUsd");
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const width = 960;
  const height = 178;
  const left = 68;
  const right = 18;
  const top = 14;
  const bottom = 30;
  const maximum = points.reduce((value, point) => Math.max(value, point.metrics[metric]), 0);
  const ceiling = maximum || 1;
  const x = (index: number) => left + (points.length === 1 ? (width - left - right) / 2 : index / Math.max(points.length - 1, 1) * (width - left - right));
  const y = (value: number) => height - bottom - value / ceiling * (height - top - bottom);
  const format = (value: number) => metric === "costUsd" ? formatUsageCost(value) : formatUsageCompact(value);
  const selected = highlighted === null ? null : points[highlighted];
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(point.metrics[metric])}`).join(" ");
  const area = points.length ? `${path} L${x(points.length - 1)},${height - bottom} L${x(0)},${height - bottom} Z` : "";
  const ticks = [...new Set([0, Math.floor((points.length - 1) / 3), Math.floor((points.length - 1) * 2 / 3), points.length - 1])].filter((index) => index >= 0);

  return <section aria-label="使用趋势" className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2"><Icon name="show_chart" className="text-accent" /><h2 className="text-headline-sm">使用趋势</h2><span className="text-label-sm text-outline">按{monthly ? "月" : "天"}</span></div>
      <div className="flex items-center gap-3">
        <div className="flex rounded-lg bg-black/15 p-0.5" aria-label="趋势指标">
          {TREND_METRICS.map((item) => <button key={item.value} type="button" aria-pressed={metric === item.value} className={`rounded px-2.5 py-1 text-body-sm ${metric === item.value ? "bg-accent/15 text-accent" : "text-on-surface-variant hover:bg-white/[0.06]"}`} onClick={() => { setMetric(item.value); setHighlighted(null); }}>{item.label}</button>)}
        </div>
        <button type="button" aria-expanded={showTable} onClick={() => setShowTable(!showTable)} className="text-label-sm text-outline hover:text-accent">{showTable ? "收起数据" : "查看数据"}</button>
      </div>
    </div>
    <div className="mt-2 h-5 text-right font-mono text-code-sm text-on-surface-variant" aria-live="polite">
      {selected ? <>{selected.date} <span className="ml-2 text-accent">{format(selected.metrics[metric])}</span></> : <span className="font-ui text-outline">{maximum ? "悬停或用键盘选择数据点" : "所选区间暂无该指标用量"}</span>}
    </div>
    {points.length ? <svg viewBox={`0 0 ${width} ${height}`} className="mt-1 block w-full overflow-visible" role="group" aria-label={`${TREND_METRICS.find((item) => item.value === metric)?.label}趋势图`}>
      {[0, 0.5, 1].map((fraction) => <g key={fraction}>
        <line x1={left} y1={y(ceiling * fraction)} x2={width - right} y2={y(ceiling * fraction)} stroke="currentColor" strokeOpacity="0.08" strokeDasharray={fraction ? "4 4" : undefined} />
        <text x={left - 10} y={y(ceiling * fraction) + 4} textAnchor="end" fill="currentColor" className="text-outline" fontSize="11">{format(maximum ? ceiling * fraction : 0)}</text>
      </g>)}
      <path d={area} fill="var(--color-accent, #60cdff)" fillOpacity="0.07" />
      <path d={path} fill="none" stroke="currentColor" className="text-accent" strokeWidth="2.5" strokeLinejoin="round" />
      {ticks.map((index) => <text key={index} x={x(index)} y={height - 6} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} fill="currentColor" className="text-outline" fontSize="11">{monthly ? points[index].date : points[index].date.slice(5)}</text>)}
      {points.map((point, index) => <g key={point.date}>
        {highlighted === index && <line x1={x(index)} y1={top} x2={x(index)} y2={height - bottom} stroke="currentColor" className="text-accent" strokeOpacity="0.3" strokeDasharray="3 3" />}
        <circle cx={x(index)} cy={y(point.metrics[metric])} r={highlighted === index || points.length === 1 ? 4 : 0} fill="currentColor" className="text-accent" />
        <circle cx={x(index)} cy={y(point.metrics[metric])} r="9" fill="transparent" tabIndex={0} role="img" aria-label={`${point.date}，${format(point.metrics[metric])}`} onMouseEnter={() => setHighlighted(index)} onMouseLeave={() => setHighlighted(null)} onFocus={() => setHighlighted(index)} onBlur={() => setHighlighted(null)} className="cursor-crosshair outline-accent">
          <title>{point.date}：{format(point.metrics[metric])}</title>
        </circle>
      </g>)}
    </svg> : <div className="flex h-28 items-center justify-center text-body-sm text-outline">采集到用量后将在这里显示趋势</div>}
    {showTable && <div className="mt-3 max-h-48 overflow-auto rounded-lg border border-white/[0.07]">
      <table className="w-full text-right font-mono text-code-sm"><caption className="sr-only">趋势数据，按{monthly ? "月" : "天"}汇总</caption><thead className="sticky top-0 bg-surface-container-high"><tr><th className="px-3 py-2 text-left">日期</th><th className="px-3 py-2">成本 · USD</th><th className="px-3 py-2">请求</th><th className="px-3 py-2">Token</th></tr></thead><tbody>{points.map((point) => <tr key={point.date} className="border-t border-white/[0.05]"><td className="px-3 py-1.5 text-left">{point.date}</td><td className="px-3 py-1.5">{formatUsageCost(point.metrics.costUsd)}</td><td className="px-3 py-1.5">{formatUsageNumber(point.metrics.requests)}</td><td className="px-3 py-1.5">{formatUsageNumber(point.metrics.totalTokens)}</td></tr>)}</tbody></table>
    </div>}
  </section>;
}

function ContainerCard({ item, onSelect, presence = "current" }: { item: UsageContainerSummary; onSelect: () => void; presence?: ContainerPresence }) {
  const metrics = item.metrics;
  const input = metrics.inputTokens + metrics.cacheReadTokens + metrics.cacheWriteTokens;
  return <button type="button" onClick={onSelect} aria-label={`查看 ${item.container} 用量详情`} className="group min-w-0 rounded-xl border border-white/[0.08] bg-white/[0.025] p-4 text-left transition-colors hover:border-accent/40 hover:bg-accent/[0.04] focus-visible:outline-accent">
    <div className="flex items-start justify-between gap-2"><span className="flex min-w-0 items-center gap-2"><Icon name="deployed_code" className="shrink-0 text-outline group-hover:text-accent" /><span className="truncate text-headline-sm" title={item.container}>{item.container}</span></span><Icon name="arrow_forward" className="shrink-0 text-outline group-hover:text-accent" /></div>
    <div className="mt-2"><CollectionBadge collection={item.collection} historical={item.container === "未归属（历史）"} presence={presence} /></div>
    <div className="mt-4 flex items-baseline justify-between gap-2"><span className="truncate font-mono text-[24px] font-semibold text-accent" title={formatUsageCost(metrics.costUsd)}>{formatUsageCost(metrics.costUsd)}</span><span className="shrink-0 text-label-sm text-outline">USD</span></div>
    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-white/[0.06] pt-3 text-body-sm">
      {[ ["请求", formatUsageNumber(metrics.requests)], ["Token 总量", formatUsageCompact(metrics.totalTokens)], ["缓存读取", formatUsageCompact(metrics.cacheReadTokens)], ["缓存命中率", formatUsagePercent(metrics.cacheHitRate, input > 0)] ].map(([label, value]) => <div key={label}><dt className="text-outline">{label}</dt><dd className="mt-0.5 font-mono text-on-surface">{value}</dd></div>)}
    </dl>
  </button>;
}

function LogTable({ logs }: { logs: UsageLog[] }) {
  return <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
    <table className="w-full whitespace-nowrap text-left text-body-sm"><caption className="sr-only">请求使用日志，输入、输出和缓存均以 token 计</caption>
      <thead className="bg-white/[0.035] text-label-sm text-on-surface-variant"><tr>
        {[["时间", ""], ["类型", ""], ["供应商 / 模型", ""], ["输入", "普通输入 token，不含缓存"], ["输出", "输出 token"], ["缓存命中", "读取缓存的 token"], ["缓存写入", "创建缓存的 token"], ["成本 · USD", "按所属供应商当前定价估算；供应商已删除时沿用请求保存的价格"], ["速度", "输出 token / 秒；缺少可靠时长时不显示"]].map(([label, title]) => <th key={label} scope="col" title={title} className={`px-3 py-2.5 font-medium ${["输入", "输出", "缓存命中", "缓存写入", "成本 · USD", "速度"].includes(label) ? "text-right" : ""}`}>{label}</th>)}
      </tr></thead>
      <tbody>{logs.map((row) => <tr key={row.id} className="border-t border-white/[0.05] hover:bg-white/[0.025]">
        <td className="px-3 py-3 font-mono text-code-sm text-on-surface-variant" title={`${new Date(row.timestamp * 1000).toLocaleString("zh-CN")} · 会话 ${row.sessionId}`}>{timestampText(row.timestamp)}{row.attribution === "historical" && <div className="mt-1 font-ui text-label-sm text-outline">{row.attributionSource === "local-history" ? "供应商未确认" : row.attributionSource === "ambiguous" ? "归属有冲突" : "归属未确认"}</div>}</td>
        <td className="px-3 py-3"><span className={`rounded px-1.5 py-0.5 text-label-sm ${row.authType === "api" ? "bg-accent/10 text-accent" : row.authType === "authorization" ? "bg-st-ok/10 text-st-ok" : "bg-white/[0.07] text-outline"}`}>{AUTH_LABEL[row.authType]}</span></td>
        <td className="max-w-[210px] px-3 py-3"><div className="truncate" title={row.providerName}>{row.providerName || "未知供应商"}</div><div className="mt-1 truncate font-mono text-code-sm text-outline" title={row.model}>{row.model || "未知模型"}</div></td>
        <td className="px-3 py-3 text-right font-mono tabular-nums">{formatUsageNumber(row.inputTokens)}</td>
        <td className="px-3 py-3 text-right font-mono tabular-nums">{formatUsageNumber(row.outputTokens)}</td>
        <td className="px-3 py-3 text-right font-mono tabular-nums text-on-surface-variant">{formatUsageNumber(row.cacheReadTokens)}</td>
        <td className="px-3 py-3 text-right font-mono tabular-nums text-on-surface-variant">{formatUsageNumber(row.cacheWriteTokens)}</td>
        <td className="px-3 py-3 text-right font-mono tabular-nums text-accent" title={`USD / 百万 token：输入 ${row.pricing.input}，输出 ${row.pricing.output}，缓存读取 ${row.pricing.cacheRead}，缓存写入 ${row.pricing.cacheWrite}`}>{formatUsageCost(row.costUsd)}</td>
        <td className="px-3 py-3 text-right font-mono tabular-nums text-on-surface-variant" title={row.durationMs ? `请求耗时 ${(row.durationMs / 1000).toFixed(2)} 秒` : "未记录可靠的请求耗时"}>{formatUsageSpeed(row.speed)}</td>
      </tr>)}</tbody>
    </table>
    {!logs.length && <div className="py-10 text-center text-body-sm text-outline">没有符合筛选条件的使用日志</div>}
  </div>;
}

/** 独立用量弹窗，终端工作区保持挂载。 */
export function UsageModal({ initialContainer, onClose }: { initialContainer?: string; onClose: () => void }) {
  const demo = !isTauri();
  const [liveContainers, setLiveContainers] = useState<Pick<ContainerInfo, "name" | "running">[] | null>(null);
  const [container, setContainer] = useState(initialContainer ?? "");
  const [range, setRange] = useState<UsageRange>("7d");
  const [start, setStart] = useState(() => { const date = new Date(); date.setDate(date.getDate() - 6); return localDateInput(date); });
  const [end, setEnd] = useState(() => localDateInput());
  const [authType, setAuthType] = useState<UsageAuthType | "">("");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState<UsageResult | null>(null);
  const [options, setOptions] = useState<Pick<UsageResult, "providers" | "models">>({ providers: [], models: [] });
  const [loading, setLoading] = useState(true);
  const [enabling, setEnabling] = useState(false);
  const [enabledHere, setEnabledHere] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const collectOnNextLoad = useRef(false);
  const loadingRef = useRef(false);
  const mounted = useRef(true);
  const dateRange = useMemo(() => usageDateRange(range, start, end), [range, start, end, refreshTick]);
  const query = useMemo<UsageQuery>(() => ({ from: dateRange.from, to: dateRange.to, utcOffsetMinutes: dateRange.utcOffsetMinutes,
    container: container || undefined, authType: authType || undefined, providerId: providerId || undefined, model: model || undefined, page, pageSize }), [dateRange.from, dateRange.to, dateRange.utcOffsetMinutes, container, authType, providerId, model, page, pageSize]);
  const previousQuery = useRef(query);

  useEffect(() => {
    if (previousQuery.current !== query) { setData(null); previousQuery.current = query; }
    if (dateRange.error) { setLoading(false); return; }
    let cancelled = false;
    const collect = collectOnNextLoad.current;
    collectOnNextLoad.current = false;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    const load = async () => {
      try {
        if (collect && !demo) await usageRefresh();
        const [result, inventory] = await Promise.all([
          demo ? queryUsageDemo(query) : usageQuery(query),
          demo ? useFleetStore.getState().fleet.entries.map((entry) => entry.container) : containerList(false).catch(() => null),
        ]);
        if (!cancelled) { setData(result); setLiveContainers(inventory); setOptions({ providers: result.providers, models: result.models }); if (result.page !== page) setPage(result.page); }
      } catch (cause) {
        if (!cancelled) setError(errorText(cause));
      } finally {
        if (!cancelled) { loadingRef.current = false; setLoading(false); }
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [query, demo, dateRange.error, refreshTick, page]);

  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => { if (!loadingRef.current) setRefreshTick((tick) => tick + 1); }, 30_000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, []);

  const trend = useMemo(() => displayUsageTrend(data?.trend ?? [], query), [data?.trend, query]);
  const selected = data?.containers.find((item) => item.container === container);
  const currentContainerNames = useMemo(() => liveContainers === null ? null : new Set(liveContainers.map((item) => item.name)), [liveContainers]);
  const selectedPresence: ContainerPresence = currentContainerNames === null ? "unknown" : currentContainerNames.has(container) ? "current" : "archived";
  const knownContainers = useMemo(() => {
    if (!data) return [];
    const names = new Set(data.containers.map((item) => item.container));
    const missing = !container ? (liveContainers ?? []).filter((item) => !names.has(item.name)).map((item): UsageContainerSummary => ({
      container: item.name,
      metrics: { ...ZERO_USAGE },
      collection: { container: item.name, status: item.running ? "unsupported" : "stopped", lastCollectedAt: null, error: null },
    })) : [];
    return [...data.containers, ...missing].sort((a, b) => b.metrics.costUsd - a.metrics.costUsd || b.metrics.requests - a.metrics.requests || a.container.localeCompare(b.container));
  }, [data, container, liveContainers]);
  const containerGroups = useMemo(() => partitionUsageContainers(knownContainers, currentContainerNames), [knownContainers, currentContainerNames]);
  const overviewContainers = currentContainerNames === null ? containerGroups.unconfirmed : containerGroups.current;
  const totalPages = data ? Math.max(1, Math.ceil(data.totalLogs / data.pageSize)) : 1;
  const hasFilters = Boolean(authType || providerId || model);
  const chooseContainer = (name: string) => { setContainer(name); setAuthType(""); setProviderId(""); setModel(""); setPage(1); };
  const refresh = () => { collectOnNextLoad.current = true; setRefreshTick((tick) => tick + 1); };
  const enableCapture = async () => {
    if (enabling) return;
    setEnabling(true);
    const name = container;
    try {
      if (!demo) await usageEnable(name);
      useUiStore.getState().toast("success", demo ? "演示：已启用精确采集" : "已启用，下次启动 Claude 生效，当前会话继续运行");
      if (mounted.current) { setEnabledHere((names) => [...names, name]); refresh(); }
    } catch (cause) {
      if (mounted.current) setError(`启用精确采集失败：${errorText(cause)}`);
    } finally {
      if (mounted.current) setEnabling(false);
    }
  };

  return <Modal title={container ? `${container} · 用量详情` : "用量统计"} icon="monitoring" width={1180} badge={demo ? "演示数据" : undefined} onClose={onClose}
    headerExtra={<Button icon="refresh" variant="subtle" disabled={loading || Boolean(dateRange.error)} onClick={refresh}>{loading ? "读取中…" : "刷新"}</Button>}
    footerLeft={<span className="text-label-sm text-outline">USD · token 包含输入、输出、缓存读取与写入{data && <span className="ml-3 hidden md:inline">最近采集 {timestampText(data.collection.lastCollectedAt)}</span>}</span>}
    footer={<Button onClick={onClose}>关闭</Button>}>
    <div className="space-y-4 font-ui" aria-busy={loading}>
      {demo && <Callout>当前为演示数据，仅用于预览统计界面。</Callout>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {container ? <><Button variant="subtle" icon="arrow_back" onClick={() => chooseContainer("")}>总览</Button><span className="text-outline">/</span><span className="truncate text-headline-sm" title={container}>{container}</span></> : <div><h1 className="text-headline-md">用量总览</h1><p className="mt-0.5 text-body-sm text-outline">选定区间的累计用量与成本，包含现有容器及历史记录</p></div>}
          {selected && <CollectionBadge collection={selected.collection} historical={container === "未归属（历史）"} presence={selectedPresence} />}
        </div>
        <div className="flex flex-wrap gap-1 rounded-lg bg-black/15 p-1" aria-label="统计区间">
          {USAGE_RANGES.map((item) => <button key={item.value} type="button" aria-pressed={range === item.value} onClick={() => { setRange(item.value); setPage(1); }} className={`rounded px-2.5 py-1 text-body-sm transition-colors ${range === item.value ? "bg-accent/15 text-accent" : "text-on-surface-variant hover:bg-white/[0.06]"}`}>{item.label}</button>)}
        </div>
      </div>
      {range === "custom" && <div className="flex flex-wrap items-center gap-2 text-body-sm text-on-surface-variant">
        <label htmlFor="usage-start">开始日期</label><Input id="usage-start" type="date" value={start} onChange={(event) => { setStart(event.target.value); setPage(1); }} className="w-40" />
        <label htmlFor="usage-end">结束日期</label><Input id="usage-end" type="date" value={end} min={start} onChange={(event) => { setEnd(event.target.value); setPage(1); }} className="w-40" /><span className="text-label-sm text-outline">包含结束当天 · 本地时区</span>
      </div>}
      {container && <div className="flex flex-wrap items-center gap-2">
        <Icon name="filter_alt" className="text-outline" />
        <Select aria-label="按类型筛选" value={authType} onChange={(event) => { setAuthType(event.target.value as UsageAuthType | ""); setPage(1); }} className="w-32"><option value="">全部类型</option><option value="api">API</option><option value="authorization">授权</option><option value="unknown">未知（历史）</option></Select>
        <Select aria-label="按供应商筛选" value={providerId} onChange={(event) => { setProviderId(event.target.value); setPage(1); }} className="max-w-full sm:w-48"><option value="">全部供应商</option>{options.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</Select>
        <Select aria-label="按模型筛选" value={model} onChange={(event) => { setModel(event.target.value); setPage(1); }} className="max-w-full sm:w-56"><option value="">全部模型</option>{options.models.map((name) => <option key={name} value={name}>{name}</option>)}</Select>
        {hasFilters && <Button variant="subtle" onClick={() => { setAuthType(""); setProviderId(""); setModel(""); setPage(1); }}>清除筛选</Button>}
        <span className="text-label-sm text-outline">筛选同时作用于统计、趋势和日志</span>
      </div>}
      {dateRange.error && <Callout tone="danger">{dateRange.error}</Callout>}
      {error && <Callout tone="danger"><div className="flex flex-wrap items-center justify-between gap-2"><span>读取用量失败：{error}</span><Button onClick={refresh} disabled={loading}>重试</Button></div></Callout>}
      {loading && !data && !dateRange.error && <div role="status" className="flex min-h-48 items-center justify-center gap-2 text-body-md text-on-surface-variant"><Icon name="progress_activity" />正在读取用量记录…</div>}
      {data && !dateRange.error && <>
        <SummaryCards metrics={data.totals} />
        {data.collection.warnings.length > 0 && <div className="space-y-2">{data.collection.warnings.map((warning, index) => <Callout key={`${index}-${warning}`} tone="warning">{warning}</Callout>)}</div>}
        {selected && selectedPresence === "current" && selected.collection.status !== "stopped" && !selected.collection.captureReady && !enabledHere.includes(container) && <Callout tone="warning"><div className="flex flex-wrap items-center justify-between gap-3"><div>该容器尚未启用精确采集。启用后，从下次启动 Claude 起记录容器、供应商与请求定价；当前会话继续运行。</div><Button disabled={enabling || loading} onClick={() => void enableCapture()} icon="add_chart">{enabling ? "启用中…" : "启用精确采集"}</Button></div></Callout>}
        {enabledHere.includes(container) && <Callout tone="success">已启用精确采集，下次启动 Claude 生效。当前会话继续运行。</Callout>}
        {selectedPresence === "current" && selected?.collection.status === "unsupported" && <Callout tone="warning">该容器尚未启用采集。使用支持用量采集的镜像启动新会话后，后续请求会自动记录；已导入历史请在总览中查看。</Callout>}
        {selectedPresence === "current" && selected?.collection.status === "error" && <Callout tone="danger">该容器采集失败：{selected.collection.error || "请检查容器状态后重试。"}</Callout>}
        {data.totals.requests === 0 && <div className="rounded-lg border border-dashed border-white/10 px-4 py-3 text-body-sm text-on-surface-variant">{hasFilters ? "当前筛选没有使用记录。可清除筛选或扩大日期范围。" : "所选区间尚无已采集的使用记录。新请求采集后会出现在这里，已保存的记录会在容器停止后继续保留。"}</div>}
        <TrendChart points={trend.points} monthly={trend.monthly} />
        {!container ? <div className="space-y-4">
          <section aria-label={currentContainerNames === null ? "容器用量（状态未确认）" : "当前容器用量"}>
            <div className="mb-3 flex items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-headline-sm"><Icon name="deployed_code" className="text-accent" />{currentContainerNames === null ? "容器用量（状态未确认）" : "当前容器用量"} <span className="text-label-sm text-outline">{overviewContainers.length}</span></h2><span className="text-body-sm text-outline">点击卡片查看详情与日志</span></div>
            {currentContainerNames === null && <p className="mb-3 text-body-sm text-outline">暂时无法读取当前容器列表，以下为已保存的用量记录；恢复连接后刷新即可确认。</p>}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{overviewContainers.map((item) => <ContainerCard key={item.container} item={item} presence={currentContainerNames === null ? "unknown" : "current"} onSelect={() => chooseContainer(item.container)} />)}</div>
            {currentContainerNames !== null && !overviewContainers.length && <div className="py-8 text-center text-body-sm text-outline">当前没有容器。创建容器并开始使用 Claude 后，统计会自动采集。</div>}
          </section>
          {containerGroups.historical.length > 0 && <details className="group/history rounded-xl border border-white/[0.07] bg-white/[0.015]">
            <summary tabIndex={0} className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-4 py-3 text-body-sm text-on-surface-variant hover:bg-white/[0.025] focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
              <Icon name="history" className="text-outline" /><span>历史用量记录</span><span className="text-label-sm text-outline">{containerGroups.historical.length} 组</span><Icon name="expand_more" className="ml-auto transition-transform group-open/history:rotate-180" />
            </summary>
            <div className="px-4 pb-4"><p className="mb-3 text-body-sm text-outline">包含已不在当前列表中的容器及归属未知的旧记录，不计入当前容器数量；用量仍计入上方累计统计。</p><div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{containerGroups.historical.map((item) => <ContainerCard key={item.container} item={item} presence="archived" onSelect={() => chooseContainer(item.container)} />)}</div></div>
          </details>}
        </div> : <section aria-label="使用日志" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-headline-sm"><Icon name="receipt_long" className="text-accent" />使用日志 <span className="text-label-sm text-outline">{formatUsageNumber(data.totalLogs)} 条</span></h2><span className="text-label-sm text-outline">输入 / 输出 / 缓存单位：token · 速度：输出 token/s</span></div>
          <LogTable logs={data.logs} />
          <div className="flex flex-wrap items-center justify-between gap-2 text-body-sm text-on-surface-variant">
            <label className="flex items-center gap-2">每页<Select aria-label="每页日志数" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }} className="w-20"><option value={25}>25 条</option><option value={50}>50 条</option><option value={100}>100 条</option></Select></label>
            <div className="flex items-center gap-3"><span>第 {data.page} / {totalPages} 页</span><Button icon="chevron_left" aria-label="上一页日志" disabled={loading || data.page <= 1} onClick={() => setPage(data.page - 1)}>上一页</Button><Button icon="chevron_right" aria-label="下一页日志" disabled={loading || data.page >= totalPages} onClick={() => setPage(data.page + 1)}>下一页</Button></div>
          </div>
          <p className="text-label-sm leading-relaxed text-outline">费用按请求所属供应商的当前定价重新估算；供应商已删除时沿用请求保存的价格。授权、未填价格及无法确定供应商的历史记录记为 $0；未记录可靠耗时时，速度显示为「—」。请求数仅统计已记录 token 的模型响应。</p>
        </section>}
      </>}
    </div>
  </Modal>;
}
