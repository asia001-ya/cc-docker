import type { QuotaWindow } from "../../api/types";
import { colorForRemaining, formatCountdown, windowRemaining } from "../../lib/quota";
import { useUiStore } from "../../store/uiStore";
import { ProgressBar } from "../ui/controls";

export function QuotaWindowRow({ label, win, now, compact = false }: {
  label: string; win: QuotaWindow | null | undefined; now: number; compact?: boolean;
}) {
  const settings = useUiStore((s) => s.settings.quota);
  const remaining = windowRemaining(win, now);
  const color = remaining ? colorForRemaining(remaining.pct, settings.warnThreshold, settings.criticalThreshold) : "#8A8886";
  const reset = remaining?.inferred ? "已重置（待刷新确认）" : formatCountdown(win?.resets_at, now);
  return <div
    className={"grid items-center gap-2 font-mono text-code-sm " + (compact ? "grid-cols-[38px_1fr_46px]" : "grid-cols-[38px_1fr_46px_74px]")}
    title={label + "剩余额度" + (reset ? " · " + reset : "")}
  >
    <span className="text-on-surface-variant">{label}</span>
    <ProgressBar pct={remaining?.pct ?? 0} color={color} height={compact ? 3 : 5} />
    <span className="text-right font-semibold" style={{ color }}>
      {remaining ? Math.round(remaining.pct) + "%" + (remaining.inferred ? "*" : "") : "—"}
    </span>
    {!compact && <span className="truncate text-outline">{remaining?.inferred ? "已重置*" : reset}</span>}
  </div>;
}
