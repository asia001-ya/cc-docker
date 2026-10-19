import { useEffect, useRef, useState } from "react";
import type { ContainerEdit, ContainerEditView, HostConfigApplyResult, Precheck } from "../../api/types";
import { containerEditApply, containerEditGet, containerEditPrecheck, errorText, isTauri } from "../../api/commands";
import { useFleetStore } from "../../store/fleetStore";
import { useTabStore } from "../../store/tabStore";
import { useUiStore } from "../../store/uiStore";
import { Modal } from "../ui/Modal";
import { Button, Callout, Field, Input } from "../ui/controls";
import { ProjectMountFields } from "./ProjectMountFields";

export function EditContainerModal({ container }: { container: string }) {
  const closeModal = useUiStore((state) => state.closeModal);
  const [info, setInfo] = useState<ContainerEditView | null>(null);
  const [config, setConfig] = useState<ContainerEdit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<{ key: string; value: Precheck } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<HostConfigApplyResult | null>(null);
  const inFlight = useRef(false);
  const key = JSON.stringify(config);
  const changed = !!info && key !== JSON.stringify(info.config);
  useEffect(() => {
    let active = true;
    if (!isTauri()) {
      const entry = useFleetStore.getState().fleet.entries.find((entry) => entry.container.name === container);
      const value: ContainerEditView = {
        containerId: entry?.container.id ?? container, image: entry?.container.image ?? "",
        running: entry?.container.running ?? false, affectedSessions: 0,
        config: { mounts: (entry?.container.mounts ?? []).filter((mount) => mount.kind === "bind" && mount.destination.startsWith("/workspace"))
          .map((mount) => ({ hostPath: mount.source, containerPath: mount.destination, readOnly: !mount.rw })),
          cpus: 4, memoryMb: 8192, workingDir: "/workspace" },
      };
      setInfo(value);
      setConfig(value.config);
      return;
    }
    containerEditGet(container).then((value) => { if (active) { setInfo(value); setConfig(value.config); } })
      .catch((cause) => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [container]);
  useEffect(() => {
    if (!changed || result) return;
    let active = true;
    const timer = setTimeout(() => {
      const promise = isTauri() ? containerEditPrecheck(container, JSON.parse(key)) : Promise.resolve({ ok: true, errors: [], warnings: [] });
      promise.then((value) => { if (active) setCheck({ key, value }); })
        .catch((cause) => { if (active) setCheck({ key, value: { ok: false, errors: [errorText(cause)], warnings: [] } }); });
    }, 350);
    return () => { active = false; clearTimeout(timer); };
  }, [container, key, changed, result]);
  const precheck = check?.key === key ? check.value : null;
  const close = () => { if (!inFlight.current) closeModal(); };
  const patch = (value: Partial<ContainerEdit>) => { if (config) { setConfig({ ...config, ...value }); setError(null); } };
  const apply = async () => {
    if (!config || !info || !changed || !precheck?.ok || inFlight.current || result) return;
    if (!isTauri()) return useUiStore.getState().toast("info", "演示模式：未实际修改容器");
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const applied = await containerEditApply(container, config, info.containerId);
      setResult(applied);
      if (applied.containerId !== info.containerId) {
        const tabs = useTabStore.getState();
        for (const session of Object.values(tabs.sessions)) if (session.container === container) tabs.markExited(session.id, null);
      }
    } catch (cause) { setError(errorText(cause)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <Modal title="编辑容器" icon="edit" badge={container} width={820} onClose={close} onSubmit={() => void apply()}
    footerLeft={<span className="font-ui text-label-sm text-on-surface-variant">{busy ? "正在保存快照并重建…" : result ? "配置已保存" : !changed ? "未修改配置" : !precheck ? "正在预检…" : precheck.ok ? "配置预检通过" : "配置预检未通过"}</span>}
    footer={<><Button disabled={busy} onClick={close}>{result ? "完成" : "取消"}</Button>{!result &&
      <Button variant="primary" icon="save" disabled={busy || !changed || !precheck?.ok} onClick={() => void apply()}>保存并重建</Button>}</>}
  >
    <div className="flex flex-col gap-4">
      {error && <div role="alert"><Callout tone="danger">{error}</Callout></div>}
      {!info && !error && <p className="text-outline">正在读取容器配置…</p>}
      {result ? <>
        <Callout tone="success">配置已保存，容器{result.restarted ? "已重新启动" : "保持停止"}。账号凭证、会话历史和容器文件已保留，可重新打开终端继续会话。</Callout>
        {result.snapshotImage && <p className="break-all font-mono text-code-sm text-outline">原容器快照：{result.snapshotImage}</p>}
        {result.warnings.map((warning) => <Callout key={warning} tone="warning">{warning}</Callout>)}
      </> : config && info && <>
        <p className="font-mono text-code-sm text-outline">{info.image}</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="CPU 核数" hint="0 表示不限制"><Input type="number" min={0} max={1024} step={0.5} disabled={busy} value={config.cpus} onChange={(event) => patch({ cpus: Number(event.target.value) })} /></Field>
          <Field label="内存上限（MB）" hint="0 表示不限制"><Input type="number" min={0} max={1_048_576} step={512} disabled={busy} value={config.memoryMb} onChange={(event) => patch({ memoryMb: Number(event.target.value) })} /></Field>
        </div>
        <Field label="默认工作目录"><Input mono disabled={busy} value={config.workingDir} onChange={(event) => patch({ workingDir: event.target.value })} /></Field>
        <ProjectMountFields mounts={config.mounts} disabled={busy} onChange={(mounts) => patch({ mounts })} />
        {changed && <Callout tone="warning">
          修改配置需要重建容器{info.running ? "，当前终端、tmux 会话及后台进程会结束" : ""}。
          {info.affectedSessions > 0 ? "当前登记终端 " + info.affectedSessions + " 个。" : ""}
          保存时保留账号卷、历史和容器文件，重建失败时恢复原容器。
        </Callout>}
        {precheck?.errors.map((message) => <Callout key={message} tone="danger">{message}</Callout>)}
      </>}
    </div>
  </Modal>;
}
