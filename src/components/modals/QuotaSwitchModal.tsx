/**
 * 弹框 4：额度预警与一键无缝切换。
 * 额度耗尽时自动弹出（或手动触发），推荐剩余额度最高的容器；Enter 确认、Esc 稍后、Tab 切换候选。
 */
import { useEffect, useState } from "react";
import type { Candidate, ExhaustedPayload } from "../../api/types";
import { errorText, isTauri, switchCandidates } from "../../api/commands";
import { useEntry, useFleetStore } from "../../store/fleetStore";
import { useTabStore } from "../../store/tabStore";
import { useUiStore } from "../../store/uiStore";
import { formatCountdown, formatReset } from "../../lib/quota";
import { Modal } from "../ui/Modal";
import { Button, Checkbox, Icon, Kbd, ProgressBar, StatusDot } from "../ui/controls";
import { useNow } from "../shell/StatusBar";

interface Props {
  source: string;
  sessionId: string | null;
  payload: ExhaustedPayload | null;
  /** 执行切换 */
  onSwitch: (sessionId: string, target: string) => Promise<void>;
}

/**
 * 演示模式下的本地候选计算。
 * @param source 源容器
 * @returns 候选
 */
function useDemoCandidates(source: string): Candidate[] {
  const entries = useFleetStore((s) => s.fleet.entries);
  return entries
    .filter((e) => e.container.name !== source && e.container.running && e.health !== "exhausted" && e.health !== "api" && e.remaining)
    .sort((a, b) => (b.remaining?.remaining ?? 0) - (a.remaining?.remaining ?? 0))
    .map((e) => ({ name: e.container.name, tier: 1, remaining: e.remaining?.remaining ?? null, reason: `剩余 ${Math.round(e.remaining?.remaining ?? 0)}%` }));
}

/**
 * 热切换弹框。
 * @param props 源容器、源会话、耗尽事件、切换回调
 * @returns JSX
 */
export function QuotaSwitchModal({ source, sessionId, payload, onSwitch }: Props) {
  const close = useUiStore((s) => s.closeModal);
  const toast = useUiStore((s) => s.toast);
  const snooze = useUiStore((s) => s.snooze);
  const settings = useUiStore((s) => s.settings);
  const setSettings = useUiStore((s) => s.setSettings);
  const sessions = useTabStore((s) => s.sessions);
  const src = useEntry(source);
  const demoCandidates = useDemoCandidates(source);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const now = useNow();
  const entries = useFleetStore((s) => s.fleet.entries);

  // 源会话：优先传入的会话，其次该容器下任一会话
  const sid = sessionId ?? Object.values(sessions).find((r) => r.container === source)?.id ?? null;
  const srcSession = sid ? sessions[sid] : undefined;

  useEffect(() => {
    if (!isTauri()) return setCandidates(demoCandidates);
    switchCandidates(source)
      .then(setCandidates)
      .catch((e) => {
        toast("error", errorText(e));
        setCandidates([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const exhaustedWin = src?.quota?.five_hour && src.quota.five_hour.used_percentage >= settings.quota.switchThreshold ? "5 小时" : src?.quota?.seven_day && src.quota.seven_day.used_percentage >= settings.quota.switchThreshold ? "本周" : null;
  const resetAt = payload?.blockedUntil ?? src?.blockedUntil ?? null;
  const top = candidates?.[selected];
  // 手动触发（无耗尽事件且源容器未耗尽）时使用中性文案
  const manual = !payload && src?.health !== "exhausted";

  /**
   * 确认切换。
   * @returns Promise
   */
  const confirm = async () => {
    if (!top || !sid || busy) return;
    setBusy(true);
    try {
      await onSwitch(sid, top.name);
      close();
    } catch (e) {
      toast("error", `切换失败：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Enter 确认 / Tab 切换候选（Esc 由 Modal 处理）
  useEffect(() => {
    /**
     * 键盘处理。
     * @param e 键盘事件
     * @returns 无
     */
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.ctrlKey) {
        e.preventDefault();
        void confirm();
      } else if (e.key === "Tab" && candidates && candidates.length > 1) {
        e.preventDefault();
        e.stopPropagation();
        setSelected((i) => (i + (e.shiftKey ? candidates.length - 1 : 1)) % candidates.length);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  /**
   * 稍后处理：本轮不再自动弹出。
   * @returns 无
   */
  const later = () => {
    snooze(source, true);
    close();
  };

  return (
    <Modal
      title={manual ? "切换会话到其他容器" : "额度预警与无缝切换"}
      icon="bolt"
      width={600}
      onClose={manual ? close : later}
      footerLeft={
        <Checkbox
          checked={!settings.quota.autoPrompt}
          onChange={(v) => setSettings({ ...settings, quota: { ...settings.quota, autoPrompt: !v } })}
          label="额度耗尽时不再自动弹出"
        />
      }
      footer={
        <>
          <Button onClick={later}>
            稍后 <Kbd>Esc</Kbd>
          </Button>
          <Button variant="primary" icon={busy ? "progress_activity" : "swap_horiz"} disabled={!top || !sid || busy} onClick={() => void confirm()}>
            {busy ? "正在切换…" : top ? `切换至 ${top.name}` : "无可用容器"} <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {manual ? (
          <div className="flex items-start gap-3 rounded-xl border border-accent/25 bg-accent/[0.08] p-3">
            <Icon name="swap_horiz" size={28} className="text-accent" />
            <div className="flex flex-1 flex-col gap-0.5">
              <span className="font-ui text-headline-md text-on-surface">
                从 {source} 迁移{srcSession ? `会话「${srcSession.title}」` : "会话"}
              </span>
              <span className="font-ui text-body-md text-on-surface-variant">
                当前剩余 {src?.remaining ? `${Math.round(src.remaining.remaining)}%` : "未知"}；切换后源容器中的 claude 会先优雅退出，再在目标容器 --resume
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3 rounded-xl border border-st-bad/30 bg-st-bad-bg/60 p-3">
            <Icon name="hourglass_disabled" size={28} className="text-st-bad" />
            <div className="flex flex-1 flex-col gap-0.5">
              <span className="font-ui text-headline-md text-on-surface">
                {source} {payload?.reason === "limit_text" ? "检测到限额提示" : `${exhaustedWin ?? ""}额度已用尽`}
              </span>
              <span className="font-ui text-body-md text-on-surface-variant">
                {resetAt ? `预计 ${formatReset(resetAt, now)} 恢复（${formatCountdown(resetAt, now)}后）` : "恢复时间未知"}
                {srcSession && ` · 当前会话「${srcSession.title}」`}
              </span>
            </div>
          </div>
        )}

        {candidates === null && <div className="py-6 text-center font-ui text-body-sm text-outline">正在计算候选容器…</div>}
        {candidates?.length === 0 && (
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] p-4 text-center font-ui text-body-md text-on-surface-variant">
            没有可切换的容器：其它订阅容器均已耗尽或未运行。可在设置中开启"允许 API 兜底"，或新建容器。
          </div>
        )}
        {candidates && candidates.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="font-ui text-label-md text-on-surface-variant">
              推荐切换目标（<Kbd>Tab</Kbd> 切换候选）
            </span>
            {candidates.map((c, i) => {
              const e = entries.find((x) => x.container.name === c.name);
              const on = i === selected;
              return (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => setSelected(i)}
                  onDoubleClick={() => void confirm()}
                  className={`flex flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors ${on ? "border-accent/60 bg-accent/[0.12]" : "border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.06]"}`}
                >
                  <span className="flex items-center justify-between">
                    <span className="flex items-center gap-2 font-ui text-headline-sm text-on-surface">
                      {e && <StatusDot health={e.health} />}
                      {c.name}
                      {i === 0 && <span className="rounded-full bg-accent/20 px-1.5 py-0.5 font-ui text-label-sm text-accent">推荐</span>}
                      {c.tier === 4 && <span className="rounded-full bg-st-warn/20 px-1.5 py-0.5 font-ui text-label-sm text-st-warn">按量计费</span>}
                    </span>
                    <span className="font-mono text-code-md text-on-surface-variant">{c.reason}</span>
                  </span>
                  {c.remaining !== null && <ProgressBar pct={c.remaining} color={c.remaining > 30 ? "#28CA41" : "#FCE100"} height={4} />}
                </button>
              );
            })}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 font-ui text-body-sm">
          <div className="rounded-lg border border-st-ok/20 bg-st-ok-bg/40 p-2.5">
            <div className="mb-1 flex items-center gap-1 text-st-ok">
              <Icon name="check_circle" size={14} /> 会继承
            </div>
            <div className="text-on-surface-variant">Claude 对话历史（共享会话卷 + --resume）、项目源码、工作目录</div>
          </div>
          <div className="rounded-lg border border-st-warn/20 bg-st-warn-bg/40 p-2.5">
            <div className="mb-1 flex items-center gap-1 text-st-warn">
              <Icon name="info" size={14} /> 不会继承
            </div>
            <div className="text-on-surface-variant">Shell 进程、环境变量、后台进程（dev server）；首轮请求无 prompt cache</div>
          </div>
        </div>
        {!sid && <span className="font-ui text-body-sm text-st-warn">该容器当前没有打开的会话，无法迁移对话；可直接在目标容器新建会话。</span>}
      </div>
    </Modal>
  );
}
