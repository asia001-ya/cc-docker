/**
 * 弹框 3：新建 / 重命名终端会话。
 * 新建：显示名、目标容器、初始目录（挂载点下拉）、启动命令（claude / 恢复历史 / bash / 自定义）、环境变量、tmux 持久化。
 * 重命名：只改显示名。
 */
import { useMemo, useState } from "react";
import type { SessionMode } from "../../api/types";
import { errorText, termRename } from "../../api/commands";
import { useFleetStore } from "../../store/fleetStore";
import { useTabStore } from "../../store/tabStore";
import { useUiStore } from "../../store/uiStore";
import { parseEnvLines } from "../../lib/validators";
import { buildSessionHistory, deriveHistorySelection } from "../../lib/sessionHistory";
import { buildSessionLaunchArgs, type SessionLaunch } from "../../lib/sessionLaunch";
import { Modal } from "../ui/Modal";
import { Button, CardRadio, Field, Input, Select, Switch, TextArea } from "../ui/controls";

/** 新建会话参数 */
export interface NewSessionSpec {
  container: string;
  title: string;
  cwd: string;
  mode: SessionMode;
  args: string[];
  env: string[];
  tmux: boolean;
  split?: "row" | "column";
}

interface Props {
  mode: "new" | "rename";
  container?: string;
  sessionId?: string;
  split?: "row" | "column";
  /** 创建回调 */
  onCreate: (spec: NewSessionSpec) => Promise<void>;
}

/**
 * 会话弹框。
 * @param props 模式、默认容器、会话 ID、分屏方向、创建回调
 * @returns JSX
 */
export function SessionModal({ mode, container, sessionId, split, onCreate }: Props) {
  const close = useUiStore((s) => s.closeModal);
  const toast = useUiStore((s) => s.toast);
  const entries = useFleetStore((s) => s.fleet.entries);
  const running = entries.filter((e) => e.container.running);
  const existing = useTabStore((s) => (sessionId ? s.sessions[sessionId] : undefined));
  const upsert = useTabStore((s) => s.upsertSession);
  const sessionCount = useTabStore((s) => Object.keys(s.sessions).length);

  const [target, setTarget] = useState(container ?? running[0]?.container.name ?? "");
  const entry = entries.find((e) => e.container.name === target);
  const mountDirs = useMemo(() => {
    const dirs = (entry?.container.mounts ?? []).filter((m) => m.kind === "bind" && m.destination.startsWith("/workspace")).map((m) => m.destination);
    return dirs.length ? dirs : ["/workspace"];
  }, [entry]);
  const [title, setTitle] = useState(existing?.title ?? `会话 #${sessionCount + 1}`);
  const [titleEdited, setTitleEdited] = useState(false);
  const [cwd, setCwd] = useState(mountDirs[0]);
  const [cwdEdited, setCwdEdited] = useState(false);
  const [launch, setLaunch] = useState<SessionLaunch>("claude");
  const [yolo, setYolo] = useState(false);
  const [resumeId, setResumeId] = useState("");
  const [manualResume, setManualResume] = useState(false);
  const [custom, setCustom] = useState("");
  const [claudeArgs, setClaudeArgs] = useState("");
  const [envText, setEnvText] = useState("");
  const [tmux, setTmux] = useState(true);
  const [busy, setBusy] = useState(false);
  const env = parseEnvLines(envText);
  const history = useMemo(() => buildSessionHistory(entry?.sessions ?? []), [entry?.sessions]);
  const selectedHistory = history.find((item) => item.sessionId === resumeId);

  const selectHistory = (id: string) => {
    setResumeId(id);
    const next = deriveHistorySelection(history.find((item) => item.sessionId === id), { title, cwd, titleEdited, cwdEdited });
    setTitle(next.title);
    setCwd(next.cwd);
  };

  const selectTarget = (name: string) => {
    setTarget(name);
    setResumeId("");
    setManualResume(false);
    if (!titleEdited) setTitle(`会话 #${sessionCount + 1}`);
    if (!cwdEdited) {
      const next = entries.find((item) => item.container.name === name);
      setCwd(next?.container.mounts.find((mount) => mount.kind === "bind" && mount.destination.startsWith("/workspace"))?.destination ?? "/workspace");
    }
  };

  /**
   * 提交。
   * @returns Promise
   */
  const submit = async () => {
    if (mode === "rename") {
      if (!existing || !title.trim()) return;
      try {
        const rec = await termRename(existing.id, title.trim()).catch(() => ({ ...existing, title: title.trim() }));
        upsert(rec);
        close();
      } catch (e) {
        toast("error", errorText(e));
      }
      return;
    }
    if (!target) return toast("warning", "请选择运行中的容器");
    if (env.errors.length) return toast("warning", env.errors[0]);
    const extra = claudeArgs.trim() ? claudeArgs.trim().split(/\s+/) : [];
    const spec: NewSessionSpec = {
      container: target,
      title: title.trim() || "终端",
      cwd,
      mode: launch === "bash" ? "bash" : launch === "cmd" ? "cmd" : "claude",
      args: buildSessionLaunchArgs(launch, extra, yolo, resumeId, custom),
      env: env.env,
      tmux,
      split,
    };
    if (launch === "resume" && !resumeId) return toast("warning", "请选择要恢复的会话");
    if (launch === "cmd" && !custom.trim()) return toast("warning", "请输入命令");
    setBusy(true);
    try {
      await onCreate(spec);
      close();
    } catch (e) {
      toast("error", `打开会话失败：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (mode === "rename") {
    return (
      <Modal
        title="重命名会话"
        icon="edit"
        width={460}
        onClose={close}
        onSubmit={() => void submit()}
        footer={
          <>
            <Button onClick={close}>取消</Button>
            <Button variant="primary" kbd="Ctrl+Enter" onClick={() => void submit()}>
              保存
            </Button>
          </>
        }
      >
        <Field label="会话名称" hint={existing ? `${existing.container} · ${existing.cwd}` : undefined}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void submit()} data-autofocus />
        </Field>
      </Modal>
    );
  }

  return (
    <Modal
      title={split ? `分屏新建会话（${split === "row" ? "左右" : "上下"}）` : "新建终端会话"}
      icon="add_to_queue"
      width={720}
      onClose={close}
      onSubmit={() => void submit()}
      footerLeft={<span className="font-ui text-label-md text-on-surface-variant">tmux 持久化：关闭应用后会话继续运行，下次启动自动重新附着</span>}
      footer={
        <>
          <Button onClick={close}>取消</Button>
          <Button variant="primary" icon="terminal" kbd="Ctrl+Enter" disabled={busy || !target} onClick={() => void submit()}>
            {busy ? "正在打开…" : "打开会话"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="会话名称" required hint="显示在标签页上，可使用中文">
            <Input value={title} onChange={(e) => { setTitle(e.target.value); setTitleEdited(true); }} data-autofocus />
          </Field>
          <Field label="目标容器" required error={running.length === 0 ? "没有运行中的容器" : null}>
            <Select value={target} onChange={(e) => selectTarget(e.target.value)}>
              {running.map((e) => (
                <option key={e.container.name} value={e.container.name}>
                  {e.container.name}
                  {e.remaining ? ` · 剩余 ${Math.round(e.remaining.remaining)}%` : e.health === "api" ? " · API" : ""}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="初始工作目录" hint="下拉为该容器的项目挂载点；也可手动输入容器内路径">
          <div className="flex gap-1.5">
            <Select className="!w-56" value={mountDirs.includes(cwd) ? cwd : ""} onChange={(e) => { if (e.target.value) { setCwd(e.target.value); setCwdEdited(true); } }}>
              {mountDirs.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
              <option value="">自定义…</option>
            </Select>
            <Input mono value={cwd} onChange={(e) => { setCwd(e.target.value); setCwdEdited(true); }} />
          </div>
        </Field>
        <Field label="启动命令">
          <CardRadio
            columns={5}
            value={launch}
            onChange={setLaunch}
            options={[
              { value: "claude", icon: "smart_toy", title: "claude", desc: "新对话" },
              { value: "continue", icon: "history", title: "继续", desc: "--continue" },
              { value: "resume", icon: "manage_history", title: "恢复", desc: "--resume" },
              { value: "bash", icon: "terminal", title: "bash", desc: "纯 Shell" },
              { value: "cmd", icon: "code", title: "自定义", desc: "任意命令" },
            ]}
          />
        </Field>
        {(launch === "claude" || launch === "continue" || launch === "resume") && (
          <>
            <div className="flex items-center justify-between gap-4 rounded-lg border border-outline-variant/40 px-3 py-2.5">
              <div>
                <Switch checked={yolo} onChange={setYolo} label="YOLO 模式" />
                <p className="mt-1 font-ui text-label-sm text-on-surface-variant">开启后跳过 Claude 工具权限确认，仅对本次启动生效</p>
              </div>
              <span className={`shrink-0 font-mono text-code-sm ${yolo ? "text-accent" : "text-on-surface-variant"}`}>{yolo ? "bypassPermissions" : "默认权限"}</span>
            </div>
            <Field label="claude 额外参数" hint="例如 --model opus；开启 YOLO 时，权限模式以开关为准">
              <Input mono value={claudeArgs} onChange={(e) => setClaudeArgs(e.target.value)} placeholder="可留空" />
            </Field>
          </>
        )}
        {launch === "resume" && (
          <Field label="选择历史会话" hint={history.length === 0 ? "该容器暂无历史记录，可手动输入会话 ID" : "按最近活动排序；选择后自动填写未编辑的名称和目录"}>
            <div className="flex flex-col gap-1.5">
              {manualResume ? (
                <Input mono aria-label="会话 ID" value={resumeId} onChange={(e) => setResumeId(e.target.value.trim())} placeholder="粘贴完整的 Claude 会话 ID" />
              ) : (
                <Select aria-label="历史会话" value={selectedHistory?.sessionId ?? ""} onChange={(e) => selectHistory(e.target.value)}>
                  <option value="">{history.length ? "请选择要恢复的会话…" : "暂无历史会话"}</option>
                  {history.map((item) => (
                    <option key={item.sessionId} value={item.sessionId} title={item.title}>
                      {item.optionLabel}
                    </option>
                  ))}
                </Select>
              )}
              <div className="flex items-start justify-between gap-3 font-ui text-label-sm text-on-surface-variant">
                {selectedHistory ? (
                  <details className="min-w-0 flex-1">
                    <summary className="cursor-pointer truncate" title={selectedHistory.cwd ?? undefined}>
                      {selectedHistory.cwd ?? "未记录工作目录"} · {selectedHistory.updatedLabel}
                    </summary>
                    <div className="mt-1 break-all font-mono text-code-sm">ID：{selectedHistory.sessionId}</div>
                  </details>
                ) : <span />}
                <button type="button" className="shrink-0 text-accent hover:underline" onClick={() => {
                  if (manualResume && !selectedHistory) setResumeId("");
                  setManualResume(!manualResume);
                }}>
                  {manualResume ? "从历史列表选择" : "手动输入会话 ID"}
                </button>
              </div>
            </div>
          </Field>
        )}
        {launch === "cmd" && (
          <Field label="命令" hint="在 bash -lc 中执行，结束后回落到交互 shell">
            <Input mono value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="npm run dev -- --host 0.0.0.0" />
          </Field>
        )}
        <div className="grid grid-cols-[1fr_auto] items-start gap-4">
          <Field label="环境变量" hint="每行一个 K=V，仅对该会话生效" error={env.errors[0] ?? null}>
            <TextArea rows={3} value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder="ANTHROPIC_MODEL=claude-opus-5-5" />
          </Field>
          <div className="pt-6">
            <Switch checked={tmux} onChange={setTmux} label="tmux 持久化" />
          </div>
        </div>
      </div>
    </Modal>
  );
}
