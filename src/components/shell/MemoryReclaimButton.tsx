import { useEffect, useRef, useState } from "react";
import { errorText, isTauri, memoryCompact, memoryReclaim, memoryReclaimStatus } from "../../api/commands";
import type { MemoryReclaimResult, MemoryReclaimStatus } from "../../api/types";
import { memoryReclaimSummary, memoryReclaimTone } from "../../lib/memoryReclaim";
import { useFleetStore } from "../../store/fleetStore";
import { useUiStore } from "../../store/uiStore";
import { Icon } from "../ui/controls";

const COOLDOWN_MS = 30_000;
const HELP = "回收 WSL 共享缓存，保留运行中的容器和会话。缓存重新读取时可能短暂变慢。";

/** 主页面手动回收入口；真实执行前后端均检查能力，并限制重复操作。 */
export function MemoryReclaimButton() {
  const engineOk = useFleetStore((s) => s.fleet.engineOk);
  const dockerHost = useUiStore((s) => s.settings.docker.host);
  const [status, setStatus] = useState<MemoryReclaimStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [outcome, setOutcome] = useState<{ tone: "info" | "success" | "error"; text: string } | null>(null);
  const [resultOpen, setResultOpen] = useState(false);
  const running = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const desktop = isTauri();

  useEffect(() => {
    let disposed = false;
    setStatus(null);
    if (!desktop || !engineOk) return;
    const check = () => {
      void memoryReclaimStatus().then(
        (value) => { if (!disposed) setStatus(value); },
        (error: unknown) => { if (!disposed) setStatus({ supported: false, reason: errorText(error) }); },
      );
    };
    check();
    window.addEventListener("focus", check);
    return () => { disposed = true; window.removeEventListener("focus", check); };
  }, [desktop, engineOk, dockerHost]);

  useEffect(() => {
    if (!cooldownUntil) return;
    const tick = () => {
      const time = Date.now();
      setNow(time);
      if (time >= cooldownUntil) setCooldownUntil(0);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  useEffect(() => {
    if (!resultOpen) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setResultOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setResultOpen(false);
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
  }, [resultOpen]);

  const remaining = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const unavailable = !desktop ? "请在 Windows 桌面应用中释放 WSL 内存。"
    : !engineOk ? "请先连接本机 Docker Desktop。"
    : !status ? "正在检查 WSL 内存回收能力…"
    : !status.supported ? status.reason ?? "当前环境不支持 WSL 内存回收。"
    : null;

  const reclaim = async (operation: MemoryReclaimResult["operation"]) => {
    if (running.current || unavailable || Date.now() < cooldownUntil) return;
    running.current = true;
    const started = Date.now();
    setBusy(true);
    setOutcome(null);
    setResultOpen(false);
    setNow(started);
    setCooldownUntil(started + COOLDOWN_MS);
    try {
      const result = await (operation === "compact" ? memoryCompact() : memoryReclaim());
      setOutcome({ tone: memoryReclaimTone(result), text: memoryReclaimSummary(result) });
    } catch (error) {
      setOutcome({ tone: "error", text: errorText(error) });
    } finally {
      running.current = false;
      setBusy(false);
      setResultOpen(true);
      const finished = Date.now();
      setNow(finished);
      setCooldownUntil(finished + COOLDOWN_MS);
    }
  };

  return (
    <div ref={root} className="relative flex shrink-0 items-center">
      <button
        type="button"
        aria-label="释放内存"
        aria-busy={busy}
        title={busy ? "正在处理空闲内存并观察 VmmemWSL 占用，请稍候…" : unavailable ?? (remaining ? `${remaining} 秒后可再次释放。${HELP}` : HELP)}
        disabled={busy || !!unavailable || remaining > 0}
        onClick={() => void reclaim("cache")}
        className="flex h-7 min-w-[88px] items-center justify-center gap-1 rounded px-2 font-ui text-label-md text-on-surface-variant transition-colors hover:bg-white/[0.08] hover:text-on-surface disabled:cursor-default disabled:opacity-50"
      >
        <Icon name={busy ? "progress_activity" : "memory"} size={16} />
        <span>{busy ? "观察中…" : "释放内存"}</span>
      </button>
      {outcome && (
        <button
          type="button"
          title="查看上次内存回收结果"
          aria-label="查看上次内存回收结果"
          aria-expanded={resultOpen}
          aria-controls="memory-reclaim-result"
          onClick={() => setResultOpen((open) => !open)}
          className="flex h-7 w-5 items-center justify-center rounded text-on-surface-variant hover:bg-white/[0.08] hover:text-on-surface"
        >
          <Icon name="history" size={15} />
        </button>
      )}
      {outcome && resultOpen && (
        <div
          id="memory-reclaim-result"
          role={outcome.tone === "error" ? "alert" : "status"}
          className="wallpaper-panel absolute right-0 top-full z-[70] mt-2 w-[360px] max-w-[calc(100vw-24px)] select-text rounded-lg border border-white/[0.12] bg-[rgba(32,32,32,0.96)] p-3 font-ui text-body-md text-on-surface shadow-flyout backdrop-blur-[30px]"
        >
          <div className="mb-2 flex items-center gap-1.5">
            <Icon name={outcome.tone === "error" ? "error" : outcome.tone === "success" ? "check_circle" : "info"} size={17} className={outcome.tone === "error" ? "text-st-bad" : outcome.tone === "success" ? "text-st-ok" : "text-on-surface-variant"} />
            <span className="flex-1 font-semibold">{outcome.tone === "error" ? "内存回收提示" : "内存回收结果"}</span>
            <button type="button" title="关闭内存回收结果" aria-label="关闭内存回收结果" onClick={() => setResultOpen(false)} className="rounded p-0.5 text-outline hover:bg-white/10 hover:text-on-surface">
              <Icon name="close" size={15} />
            </button>
          </div>
          <p className="whitespace-pre-wrap break-words leading-relaxed">{outcome.text}</p>
          <div className="mt-3 border-t border-white/10 pt-3">
            <button
              type="button"
              disabled={busy || !!unavailable || remaining > 0}
              title={unavailable ?? (remaining ? `${remaining} 秒后可整理空闲页` : "整理 WSL 空闲页，帮助 Windows 回收零散的空闲内存")}
              onClick={() => void reclaim("compact")}
              className="inline-flex h-7 items-center gap-1.5 rounded border border-white/10 bg-white/[0.06] px-2 text-on-surface hover:bg-white/10 disabled:cursor-default disabled:opacity-50"
            >
              <Icon name="compress" size={15} />
              <span>整理空闲页{remaining > 0 ? `（${remaining} 秒后可用）` : ""}</span>
            </button>
            <p className="mt-2 text-body-sm leading-relaxed text-on-surface-variant">整理期间可能短暂变慢，内存占用可能先升后降；随后观察约 30 秒。</p>
          </div>
        </div>
      )}
    </div>
  );
}
