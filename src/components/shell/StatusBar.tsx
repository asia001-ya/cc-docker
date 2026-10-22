/**
 * 底部沉浸状态栏（24px）：Docker 连接、当前容器 5h / 周额度进度条与重置时间、Web 端口链接、会话信息。
 * 点击额度区域打开 QuotaFlyout。
 */
import { useEffect, useMemo, useState } from "react";
import { useFleetStore, useEntry } from "../../store/fleetStore";
import { useActiveSession } from "../../store/tabStore";
import { useUiStore } from "../../store/uiStore";
import { blockBar, colorForRemaining, formatReset, freshness, windowRemaining, HEALTH_LABEL } from "../../lib/quota";
import { Icon, StatusDot } from "../ui/controls";
import { openInPreview } from "../terminal/previewActions";
import { buildSessionCatalog } from "../../lib/sessionCatalog";
import type { QuotaWindow } from "../../api/types";

/**
 * 每 30 秒刷新一次的当前时间（倒计时用）。
 * @returns epoch 秒
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * 单个额度窗口的状态栏片段。
 * @param props label、win、now、阈值
 * @returns JSX
 */
function QuotaSeg({ label, win, now, warn, critical }: { label: string; win: QuotaWindow | null | undefined; now: number; warn: number; critical: number }) {
  const r = windowRemaining(win, now);
  if (!r) return <span className="text-outline">{label} —</span>;
  const color = colorForRemaining(r.pct, warn, critical);
  return (
    <span className="flex items-center gap-1.5" title={r.inferred ? "重置时间已过，推断为已恢复" : `重置于 ${formatReset(win?.resets_at, now)}`}>
      <span className="text-on-surface-variant">{label}</span>
      <span style={{ color }} className="font-semibold">
        {Math.round(r.pct)}%
      </span>
      <span aria-hidden="true" className="inline-flex h-[6px] shrink-0 items-stretch gap-px opacity-90" style={{ color }}>
        {Array.from(blockBar(r.pct), (cell, index) => (
          <span key={index} className="h-full w-[5px] shrink-0" style={cell === "■"
            ? { backgroundColor: "currentColor" }
            : { backgroundImage: "repeating-linear-gradient(135deg, currentColor 0 1px, transparent 1px 3px)", opacity: 0.4 }} />
        ))}
      </span>
      {win?.resets_at && !r.inferred && <span className="text-outline">{formatReset(win.resets_at, now)}重置</span>}
      {r.inferred && <span className="text-outline">*</span>}
    </span>
  );
}

/**
 * 状态栏组件。
 * @returns JSX
 */
export function StatusBar() {
  const fleet = useFleetStore((s) => s.fleet);
  const demo = useFleetStore((s) => s.demo);
  const active = useActiveSession();
  const entry = useEntry(active?.container);
  const activeTitle = useMemo(() => active ? buildSessionCatalog({
    entries: entry ? [entry] : [], sessions: { [active.id]: active },
    openSessionIds: [active.id], exited: {}, activeSessionId: active.id,
  })[0]?.title ?? active.title : null, [active, entry]);
  const setFlyout = useUiStore((s) => s.setQuotaFlyout);
  const flyout = useUiStore((s) => s.quotaFlyout);
  const openModal = useUiStore((s) => s.openModal);
  const q = useUiStore((s) => s.settings.quota);
  const now = useNow();
  const sessionSnap = entry?.sessions.find((s) => s.tdc_session_id === active?.id);
  const ports = entry?.ports ?? [];
  const firstUrl = ports.find((p) => p.url);

  return (
    <footer className="wallpaper-panel flex h-6 shrink-0 select-none items-center justify-between gap-3 whitespace-nowrap border-t border-white/[0.04] bg-surface-container-lowest px-2 font-mono text-code-sm text-on-surface-variant">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={() => openModal({ kind: "settings", tab: "docker" })}
          className="flex shrink-0 items-center gap-1.5 rounded px-1 hover:bg-white/[0.06]"
          title={fleet.engineOk ? `Docker ${fleet.engineVersion ?? ""} 已连接` : (fleet.engineError ?? "Docker 未连接")}
        >
          <span className={`h-2 w-2 rounded-full ${fleet.engineOk ? "bg-st-ok" : "bg-st-bad"}`} />
          <span className="hidden sm:inline">{demo ? "演示模式" : fleet.engineOk ? `Docker ${fleet.latencyMs ?? "-"}ms` : "Docker 未连接"}</span>
        </button>

        <span className="h-3 w-px bg-white/10" />

        {entry ? (
          <button
            type="button"
            onClick={() => setFlyout(!flyout)}
            title="额度面板（Ctrl+Shift+Q）"
            className={`flex min-w-0 items-center gap-2 overflow-hidden rounded px-1 hover:bg-white/[0.06] ${flyout ? "bg-white/[0.06]" : ""}`}
          >
            <span className="flex min-w-0 shrink-0 items-center gap-1.5 text-on-surface">
              <StatusDot health={entry.health} size={7} pulse={entry.health === "exhausted"} />
              <span className="max-w-[150px] truncate xl:max-w-none">{entry.container.name}</span>
            </span>
            <span className="hidden min-w-0 items-center gap-3 overflow-hidden lg:flex">
            {entry.health === "api" ? (
              <span className="text-accent">API 按量</span>
            ) : entry.health === "stopped" ? (
              <span className="text-outline">容器已停止</span>
            ) : (
              <>
                <QuotaSeg label="5h" win={entry.quota?.five_hour} now={now} warn={q.warnThreshold} critical={q.criticalThreshold} />
                <span className="text-outline">|</span>
                <QuotaSeg label="周" win={entry.quota?.seven_day} now={now} warn={q.warnThreshold} critical={q.criticalThreshold} />
                {!entry.quota && <span className="text-outline">{HEALTH_LABEL.unknown}：在会话中运行 claude 后上报</span>}
                {entry.quota && <span className="hidden text-outline xl:inline">· {freshness(entry.quota.rate_limits_updated_at, now)}</span>}
              </>
            )}
            </span>
            <Icon name={flyout ? "expand_more" : "expand_less"} size={14} className="shrink-0 text-outline" />
          </button>
        ) : (
          <span className="text-outline">未打开会话</span>
        )}
        <button
          type="button"
          onClick={() => openModal({ kind: "sessionList" })}
          className="flex min-w-0 max-w-[45vw] shrink-0 items-center gap-1 rounded px-1.5 font-ui text-accent hover:bg-accent/10 sm:max-w-[260px] xl:max-w-[360px]"
          title={`${activeTitle ? `${activeTitle}\n` : ""}点击打开会话列表：切换终端或恢复历史会话`}
          aria-label="会话列表"
        >
          <Icon name="forum" size={14} className="shrink-0" />
          <span className="truncate">{activeTitle ?? "会话列表"}</span>
          <Icon name="expand_less" size={13} className="shrink-0 text-outline" />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <button
          type="button"
          onClick={() => openModal({ kind: "usage" })}
          title="用量统计：成本、请求、token 与容器使用日志"
          className="flex shrink-0 items-center gap-1 rounded px-1.5 font-ui text-accent hover:bg-accent/10"
        >
          <Icon name="monitoring" size={14} />
          <span className="hidden sm:inline">用量统计</span>
          <span className="sr-only sm:hidden">用量统计</span>
        </button>
        {firstUrl && (
          <button
            type="button"
            onClick={() => openInPreview(entry!.container.name, firstUrl.url!)}
            title={`容器端口 ${firstUrl.containerPort}${firstUrl.process ? `（${firstUrl.process}）` : ""} → ${firstUrl.url}，点击打开悬浮预览`}
            className="hidden items-center gap-1 rounded px-1 text-accent hover:bg-white/[0.06] hover:underline md:flex"
          >
            <Icon name="open_in_new" size={13} />
            {firstUrl.url!.replace("http://", "")}
            <span className="text-outline">←{firstUrl.containerPort}</span>
          </button>
        )}
        {ports.length > (firstUrl ? 1 : 0) && (
          <button type="button" onClick={() => setFlyout(true)} className="rounded px-1 hover:bg-white/[0.06]" title="查看全部端口">
            +{ports.length - (firstUrl ? 1 : 0)} 端口
          </button>
        )}
        {typeof sessionSnap?.context_used_percentage === "number" && <span className="hidden sm:inline">ctx {Math.round(sessionSnap.context_used_percentage)}%</span>}
        <span className="hidden lg:inline">UTF-8</span>
        <span className="hidden items-center gap-1 sm:flex">
          <Icon name="dns" size={13} />
          WSL2
        </span>
      </div>
    </footer>
  );
}
