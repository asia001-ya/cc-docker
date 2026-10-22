import type { QuotaWindow } from "../../api/types";
import { colorForRemaining, formatCountdown, windowRemaining } from "../../lib/quota";
import { useUiStore } from "../../store/uiStore";
import { ProgressBar } from "../ui/controls";

export function QuotaWindowRow({ label, win, now }: {
  label: string; win: QuotaWindow | null | undefined; now: number;
}) {
  const settings = useUiStore((s) => s.settings.quota);
  const remaining = windowRemaining(win, now);
  const color = remaining ? colorForRemaining(remaining.pct, settings.warnThreshold, settings.criticalThreshold) : "#8A8886";
  const reset = remaining?.inferred ? "已重置（待刷新确认）" : formatCountdown(win?.resets_at, now);
  const percent = <span className="text-right font-semibold" style={{ color }}>
    {remaining ? Math.round(remaining.pct) + "%" + (remaining.inferred ? "*" : "") : "—"}
  </span>;
  const resetLabel = remaining?.inferred ? "已重置*" : reset;
  const title = label + "剩余额度" + (reset ? " · " + reset : "");
  return <div
    className="quota-window-row grid grid-cols-[38px_minmax(0,1fr)_46px_74px] items-center gap-2 font-mono text-code-sm"
    title={title}
  >
    <span className="text-on-surface-variant">{label}</span>
    <ProgressBar pct={remaining?.pct ?? 0} color={color} height={5} />
    {percent}
    <span className="quota-window-reset truncate text-outline">{resetLabel}</span>
  </div>;
}
