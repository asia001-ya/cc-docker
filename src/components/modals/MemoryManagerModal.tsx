import { useEffect, useMemo, useState } from "react";
import { isTauri } from "../../api/commands";
import type { MemoryCleanupResult, ProcessMemoryEntry, ProcessTarget } from "../../api/types";
import { memoryReclaimSummary, memoryReclaimTone } from "../../lib/memoryReclaim";
import { cleanupSummary, cleanupTone, memorySize, processMemorySummary } from "../../lib/systemMemory";
import { useMemoryStore } from "../../store/memoryStore";
import { useUiStore } from "../../store/uiStore";
import { Modal } from "../ui/Modal";
import { Button, Callout, Icon, Input, ProgressBar } from "../ui/controls";

function processKey(process: Pick<ProcessMemoryEntry, "pid" | "createdAt">): string {
  return `${process.pid}:${process.createdAt ?? "unknown"}`;
}

function sampleTime(sampledAtMs: number): string {
  return new Date(sampledAtMs).toLocaleString("zh-CN", { hour12: false });
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="min-w-0 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5">
    <p className="text-label-sm text-on-surface-variant">{label}</p>
    <p className="mt-1 font-mono text-headline-sm text-on-surface">{value}</p>
    {hint && <p className="mt-0.5 text-body-sm text-outline">{hint}</p>}
  </div>;
}

function CleanupResult({ result }: { result: MemoryCleanupResult }) {
  return <section aria-label="本次清理结果" className="space-y-3 rounded-lg border border-white/10 bg-black/15 p-4">
    <h2 className="text-headline-sm text-on-surface">本次清理结果</h2>
    <div role="status"><Callout tone={cleanupTone(result)}><p className="whitespace-pre-wrap break-words">{cleanupSummary(result)}</p></Callout></div>
    {result.processes.length > 0 && <div className="max-h-40 overflow-auto rounded border border-white/[0.06]">
      <table className="w-full text-left text-body-sm">
        <caption className="sr-only">所选进程的工作集整理结果</caption>
        <thead className="bg-white/[0.04] text-on-surface-variant"><tr><th className="px-3 py-2 font-normal">进程</th><th className="px-3 py-2 font-normal">整理结果</th></tr></thead>
        <tbody>{result.processes.map((process) => <tr key={processKey(process)} className="border-t border-white/[0.06]">
          <td className="px-3 py-2"><span className="break-all text-on-surface">{process.name}</span><span className="ml-2 font-mono text-outline">{process.pid}</span></td>
          <td className="px-3 py-2 text-on-surface-variant">{processMemorySummary(process)}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {result.errors.length > 0 && <div role="alert"><Callout tone="warning"><p className="mb-1 font-semibold">部分操作未完成</p><ul className="list-disc space-y-1 pl-4">{result.errors.map((error, index) => <li key={`${index}:${error}`} className="break-words">{error}</li>)}</ul></Callout></div>}
    {result.wsl && <div className="border-t border-white/[0.06] pt-3"><p className="mb-1 text-label-sm text-on-surface">WSL 缓存回收</p><p className="whitespace-pre-wrap break-words text-body-sm leading-relaxed text-on-surface-variant">{memoryReclaimSummary(result.wsl)}</p></div>}
  </section>;
}

/** 分析宿主内存并明确选择整理对象；清理任务独立于弹框生命周期。 */
export function MemoryManagerModal() {
  const close = useUiStore((state) => state.closeModal);
  const { analysis, pending, error, result, wslResult, cooldownUntil, analyze, cleanup, reclaimWsl } = useMemoryStore();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [includeWslCache, setIncludeWslCache] = useState(false);
  const [now, setNow] = useState(Date.now);
  const desktop = isTauri();
  const busy = Boolean(pending) || Boolean(analysis?.running);
  const system = analysis?.system ?? null;

  useEffect(() => { if (desktop) void analyze(); }, [desktop, analyze]);
  useEffect(() => {
    if (!cooldownUntil) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);
  useEffect(() => {
    const eligible = new Set((analysis?.processes ?? []).filter((process) => process.eligible && process.createdAt !== null).map(processKey));
    setSelected((previous) => {
      const next = new Set([...previous].filter((key) => eligible.has(key)));
      return next.size === previous.size ? previous : next;
    });
    if (!analysis?.wsl.supported) setIncludeWslCache(false);
  }, [analysis]);

  const processes = useMemo(() => [...(analysis?.processes ?? [])].sort((a, b) => (b.workingSetBytes ?? -1) - (a.workingSetBytes ?? -1) || a.pid - b.pid), [analysis]);
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return processes.filter((process) => !search || process.name.toLocaleLowerCase().includes(search) || String(process.pid).includes(search));
  }, [processes, query]);
  const eligibleVisible = filtered.filter((process) => process.eligible && process.createdAt !== null);
  const targets = processes.filter((process) => selected.has(processKey(process)) && process.eligible && process.createdAt !== null)
    .map((process): ProcessTarget => ({ pid: process.pid, createdAt: process.createdAt! }));
  const remaining = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const supported = desktop && Boolean(analysis?.supported);
  const wslSupported = desktop && Boolean(analysis?.wsl.supported);
  const hasSelection = targets.length > 0 || (includeWslCache && wslSupported);
  const cleanDisabled = !supported || busy || remaining > 0 || !hasSelection;
  const wslDisabled = !wslSupported || busy || remaining > 0;
  const load = system && system.totalBytes > 0 ? Math.max(0, Math.min(100, system.usedBytes / system.totalBytes * 100)) : 0;
  const toggle = (process: ProcessMemoryEntry) => {
    if (busy || !supported || !process.eligible || process.createdAt === null) return;
    setSelected((previous) => {
      const next = new Set(previous);
      const key = processKey(process);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const runCleanup = () => {
    if (!cleanDisabled) void cleanup({ targets, includeWslCache: includeWslCache && wslSupported });
  };
  const status = pending === "analysis" ? "正在分析电脑内存占用…"
    : pending === "wsl-cache" ? "正在回收 WSL 缓存并观察宿主占用…"
    : pending === "wsl-compact" ? "正在整理 WSL 空闲页并观察宿主占用…"
    : busy ? "正在清理并进行前后采样，可关闭面板后查看结果。"
    : remaining > 0 ? `${remaining} 秒后可再次清理`
    : `已选择 ${targets.length} 个进程${includeWslCache && wslSupported ? "，包含 WSL 缓存" : ""}`;

  return <Modal title="内存管理" icon="memory" width={960} badge={!desktop ? "浏览器预览" : undefined} onClose={close} onSubmit={runCleanup}
    headerExtra={<Button variant="subtle" icon={pending === "analysis" ? "progress_activity" : "refresh"} disabled={!desktop || Boolean(pending)} onClick={() => void analyze()}>刷新分析</Button>}
    footerLeft={<span role="status" className="text-label-sm text-on-surface-variant">{!desktop ? "请在 Windows 桌面应用中分析和清理内存" : status}</span>}
    footer={<><Button onClick={close}>关闭</Button><Button variant="primary" icon={pending === "clean" ? "progress_activity" : "cleaning_services"} disabled={cleanDisabled} onClick={runCleanup} title={!hasSelection ? "请先选择可整理进程或勾选 WSL 缓存" : undefined}>{pending === "clean" ? "清理中…" : "一键清理"}</Button></>}>
    <div className="space-y-4 font-ui" aria-busy={busy}>
      {!desktop && <Callout>浏览器预览无法读取电脑内存。请打开 Windows 桌面应用查看真实占用并执行清理。</Callout>}
      {error && <div role="alert"><Callout tone="danger">{error}</Callout></div>}
      {desktop && analysis && (analysis.reason || !analysis.supported) && <Callout tone="warning">{analysis.reason ?? "当前环境不支持 Windows 内存分析与整理。"}</Callout>}
      {desktop && !analysis && !error && <div role="status" className="flex items-center justify-center gap-2 py-8 text-body-md text-on-surface-variant"><Icon name="progress_activity" />正在读取整机内存和进程列表…</div>}
      <section aria-label="整机内存总览" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-headline-sm text-on-surface">整机内存</h2><span className="text-label-sm text-outline">{system ? `采样时间 ${sampleTime(system.sampledAtMs)}` : "尚无内存采样"}</span></div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="物理内存总量" value={system ? memorySize(system.totalBytes) : "—"} />
          <Metric label="已用内存" value={system ? memorySize(system.usedBytes) : "—"} />
          <Metric label="可用内存" value={system ? memorySize(system.availableBytes) : "—"} />
          <Metric label="提交内存 / 上限" value={system ? `${memorySize(system.commitBytes)} / ${memorySize(system.commitLimitBytes)}` : "—"} hint="提交内存包括分页文件支持的分配" />
        </div>
        {system ? <div className="flex items-center gap-3"><ProgressBar pct={load} color={load >= 90 ? "#ff7b7b" : "#60cdff"} height={6} /><span className="shrink-0 font-mono text-code-sm text-on-surface-variant">{load.toFixed(1)}% 已用</span></div>
          : desktop && analysis && <p className="text-body-sm text-outline">整机内存读数暂不可用，无法确认物理内存变化。</p>}
      </section>

      <section aria-label="进程内存排行" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-headline-sm text-on-surface">进程内存排行 <span className="ml-1 text-label-sm text-outline">{filtered.length} 项</span></h2><div className="flex flex-wrap items-center gap-2"><Input aria-label="搜索进程名或 PID" placeholder="搜索进程名或 PID" value={query} onChange={(event) => setQuery(event.target.value)} className="w-48" />
          <Button variant="subtle" disabled={!supported || busy || eligibleVisible.length === 0} onClick={() => setSelected((previous) => new Set([...previous, ...eligibleVisible.map(processKey)]))}>全选当前可整理项</Button>
          <Button variant="subtle" disabled={busy || selected.size === 0} onClick={() => setSelected(new Set())}>清空选择</Button></div></div>
        <p className="text-body-sm leading-relaxed text-on-surface-variant">整理所选进程的工作集，程序需要时会重新读取内存，可能短暂变慢，也不能修复内存泄漏。工作集含共享页面，不能相加作为整机占用；私有提交量是进程独占的内存分配。</p>
        <div className="max-h-[280px] overflow-auto rounded-lg border border-white/[0.08]">
          <table className="w-full min-w-[650px] text-left text-body-sm">
            <caption className="sr-only">按工作集从高到低排列，默认不选择任何进程</caption>
            <thead className="sticky top-0 z-10 bg-surface-container-high text-on-surface-variant"><tr><th className="w-12 px-3 py-2 font-normal">选择</th><th className="px-3 py-2 font-normal">进程 / PID</th><th className="px-3 py-2 text-right font-normal">工作集</th><th className="px-3 py-2 text-right font-normal">私有提交量</th><th className="px-3 py-2 font-normal">可整理状态</th></tr></thead>
            <tbody>{filtered.map((process) => {
              const eligible = process.eligible && process.createdAt !== null;
              const reason = eligible ? "可整理" : process.reason ?? (process.createdAt === null ? "无法确认进程身份" : "当前不可整理");
              return <tr key={processKey(process)} className="border-t border-white/[0.06] hover:bg-white/[0.03]">
                <td className="px-3 py-2"><input type="checkbox" className="h-4 w-4 cursor-pointer accent-accent disabled:cursor-default disabled:opacity-40" aria-label={`整理 ${process.name}（PID ${process.pid}）`} checked={selected.has(processKey(process)) && eligible} disabled={!supported || busy || !eligible} onChange={() => toggle(process)} title={reason} /></td>
                <td className="max-w-[240px] px-3 py-2"><p className="truncate text-on-surface" title={process.name}>{process.name}</p><p className="font-mono text-code-sm text-outline">{process.pid}</p></td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-code-sm text-on-surface">{memorySize(process.workingSetBytes)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-code-sm text-on-surface-variant">{memorySize(process.privateBytes)}</td>
                <td className={`max-w-[260px] break-words px-3 py-2 ${eligible ? "text-on-surface-variant" : "text-outline"}`}>{reason}</td>
              </tr>;
            })}</tbody>
          </table>
          {filtered.length === 0 && <p className="py-6 text-center text-body-sm text-outline">{query.trim() ? "没有匹配的进程" : "尚无进程内存数据"}</p>}
        </div>
      </section>

      <section aria-label="WSL 内存回收" className="space-y-3 rounded-lg border border-white/[0.06] bg-white/[0.03] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-headline-sm text-on-surface">WSL 内存回收</h2><div className="flex flex-wrap gap-2"><Button icon="memory" disabled={wslDisabled} onClick={() => void reclaimWsl("cache")}>回收 WSL 缓存</Button><Button icon="compress" disabled={wslDisabled} onClick={() => void reclaimWsl("compact")}>整理 WSL 空闲页</Button></div></div>
        <label className={`flex items-start gap-2 text-body-md text-on-surface ${!wslSupported || busy ? "opacity-50" : "cursor-pointer"}`}><input type="checkbox" className="mt-0.5 h-4 w-4 accent-accent" checked={includeWslCache} disabled={!wslSupported || busy} onChange={(event) => setIncludeWslCache(event.target.checked)} /><span>一键清理时包含 WSL 缓存<span className="mt-0.5 block text-body-sm text-on-surface-variant">保留运行中的容器和会话。空闲页整理单独执行，期间占用可能先升后降。</span></span></label>
        {desktop && analysis && !analysis.wsl.supported && <p className="text-body-sm text-outline">{analysis.wsl.reason ?? "当前 WSL 环境不支持内存回收。"}</p>}
      </section>
      {result && <CleanupResult result={result} />}
      {wslResult && <section aria-label="WSL 回收结果" className="space-y-2"><h2 className="text-headline-sm text-on-surface">WSL 回收结果</h2><div role="status"><Callout tone={memoryReclaimTone(wslResult)}><p className="whitespace-pre-wrap break-words">{memoryReclaimSummary(wslResult)}</p></Callout></div></section>}
    </div>
  </Modal>;
}
