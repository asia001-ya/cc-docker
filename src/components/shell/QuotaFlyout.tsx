/**
 * 额度浮层（极简挂件）：从状态栏弹出，列出全部容器的 5h / 周额度、重置倒计时、端口，并可一键切换。
 */
import { useFleetStore } from "../../store/fleetStore";
import { useActiveSession } from "../../store/tabStore";
import { useUiStore } from "../../store/uiStore";
import { colorForRemaining, formatCountdown, freshness, HEALTH_LABEL, windowRemaining } from "../../lib/quota";
import type { FleetEntry, QuotaWindow } from "../../api/types";
import { Icon, IconButton, ProgressBar, StatusDot } from "../ui/controls";
import { openInPreview } from "../terminal/previewActions";
import { useNow } from "./StatusBar";

/**
 * 单窗口进度行。
 * @param props label、win、now
 * @returns JSX
 */
function WindowRow({ label, win, now }: { label: string; win: QuotaWindow | null | undefined; now: number }) {
  const q = useUiStore((s) => s.settings.quota);
  const r = windowRemaining(win, now);
  const color = r ? colorForRemaining(r.pct, q.warnThreshold, q.criticalThreshold) : "#8A8886";
  return (
    <div className="grid grid-cols-[28px_1fr_42px_74px] items-center gap-2 font-mono text-code-sm">
      <span className="text-on-surface-variant">{label}</span>
      <ProgressBar pct={r?.pct ?? 0} color={color} height={5} />
      <span className="text-right font-semibold" style={{ color }}>
        {r ? `${Math.round(r.pct)}%` : "—"}
      </span>
      <span className="truncate text-outline">{r?.inferred ? "已重置*" : win?.resets_at ? formatCountdown(win.resets_at, now) : ""}</span>
    </div>
  );
}

/**
 * 单容器卡片。
 * @param props entry、当前容器、切换回调
 * @returns JSX
 */
function Row({ entry, current, onSwitch }: { entry: FleetEntry; current: boolean; onSwitch: (target: string) => void }) {
  const now = useNow();
  return (
    <div className={`flex flex-col gap-1.5 rounded-lg border p-2.5 ${current ? "border-accent/40 bg-accent/[0.08]" : "border-white/[0.06] bg-white/[0.03]"}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 font-ui text-headline-sm text-on-surface">
          <StatusDot health={entry.health} />
          <span className="truncate">{entry.container.name}</span>
          {current && <span className="rounded bg-accent/20 px-1 font-ui text-label-sm text-accent">当前</span>}
        </span>
        <span className="flex items-center gap-1">
          <span className="font-ui text-label-sm text-on-surface-variant">{HEALTH_LABEL[entry.health]}</span>
          {!current && entry.container.running && entry.health !== "exhausted" && (
            <button
              type="button"
              onClick={() => onSwitch(entry.container.name)}
              className="flex h-6 items-center gap-0.5 rounded bg-white/[0.07] px-1.5 font-ui text-label-sm text-accent hover:bg-white/[0.12]"
              title="把当前会话切换到此容器"
            >
              <Icon name="swap_horiz" size={14} /> 切换
            </button>
          )}
        </span>
      </div>
      {entry.health === "api" ? (
        <div className="font-ui text-body-sm text-on-surface-variant">
          按量计费 · {entry.provider?.base_url ?? "官方 API"} · {entry.provider?.model ?? "默认模型"}
        </div>
      ) : entry.health === "stopped" ? (
        <div className="font-ui text-body-sm text-outline">容器未运行</div>
      ) : (
        <>
          <WindowRow label="5h" win={entry.quota?.five_hour} now={now} />
          <WindowRow label="周" win={entry.quota?.seven_day} now={now} />
          <div className="flex items-center justify-between font-ui text-label-sm text-outline">
            <span className="truncate">{entry.account?.email ?? "未读取到账号"}</span>
            <span>数据 {freshness(entry.quota?.rate_limits_updated_at, now)}</span>
          </div>
        </>
      )}
      {entry.ports.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {entry.ports.map((p) =>
            p.url ? (
              <button
                key={p.containerPort}
                type="button"
                onClick={() => {
                  useUiStore.getState().setQuotaFlyout(false);
                  openInPreview(entry.container.name, p.url!);
                }}
                className="flex items-center gap-0.5 rounded bg-accent/10 px-1.5 py-0.5 font-mono text-code-sm text-accent hover:bg-accent/20"
                title={`${p.process ?? ""} 容器端口 ${p.containerPort}，点击在分屏中预览`}
              >
                <Icon name="open_in_new" size={12} />:{p.hostPort}
              </button>
            ) : (
              <span key={p.containerPort} title={p.hint ?? ""} className="rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-code-sm text-outline line-through decoration-white/20">
                {p.containerPort}
              </span>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 额度浮层组件。
 * @param props onSwitch 切换到指定容器
 * @returns JSX
 */
export function QuotaFlyout({ onSwitch }: { onSwitch: (target: string | null) => void }) {
  const open = useUiStore((s) => s.quotaFlyout);
  const setOpen = useUiStore((s) => s.setQuotaFlyout);
  const entries = useFleetStore((s) => s.fleet.entries);
  const active = useActiveSession();
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={() => setOpen(false)} />
      <div className="wallpaper-panel fixed bottom-7 left-2 z-50 flex max-h-[70vh] w-[380px] flex-col rounded-xl border border-white/[0.12] bg-[rgba(32,32,32,0.9)] shadow-flyout backdrop-blur-[30px] animate-[popIn_140ms_cubic-bezier(0.1,0.9,0.2,1)]">
        <header className="flex items-center justify-between border-b border-white/[0.06] px-3 py-2">
          <span className="flex items-center gap-1.5 font-ui text-headline-sm text-on-surface">
            <Icon name="speed" size={16} className="text-accent" /> 额度总览
          </span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              disabled={!active}
              onClick={() => onSwitch(null)}
              className="flex h-6 items-center gap-1 rounded bg-accent px-2 font-ui text-label-md font-semibold text-black hover:bg-accent-hover disabled:opacity-40"
            >
              <Icon name="bolt" size={14} /> 切至最高额度
            </button>
            <IconButton icon="close" title="关闭" onClick={() => setOpen(false)} />
          </span>
        </header>
        <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto p-2">
          {entries.length === 0 && <div className="py-6 text-center font-ui text-body-sm text-outline">暂无容器</div>}
          {entries.map((e) => (
            <Row key={e.container.name} entry={e} current={e.container.name === active?.container} onSwitch={onSwitch} />
          ))}
        </div>
        <footer className="border-t border-white/[0.06] px-3 py-1.5 font-ui text-label-sm text-outline">
          额度数据来自容器内 Claude Code 的 statusline，仅在 claude 运行时刷新；* 表示重置时间已过、推断为已恢复。
        </footer>
      </div>
    </>
  );
}
