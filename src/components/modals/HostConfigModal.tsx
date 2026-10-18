import { useEffect, useRef, useState } from "react";
import type { ContainerHostConfig, HostClaudeConfig, HostConfigApplyResult, Precheck } from "../../api/types";
import { containerHostConfigApply, containerHostConfigGet, containerHostConfigPrecheck, errorText, isTauri } from "../../api/commands";
import { hostConfigErrors, normalizeHostConfig, sameHostConfig } from "../../lib/hostConfig";
import { useFleetStore } from "../../store/fleetStore";
import { useTabStore } from "../../store/tabStore";
import { useUiStore } from "../../store/uiStore";
import { Modal } from "../ui/Modal";
import { Button, Callout } from "../ui/controls";
import { HostConfigFields } from "./HostConfigFields";

export function HostConfigModal({ container }: { container: string }) {
  const closeModal = useUiStore((s) => s.closeModal);
  const [info, setInfo] = useState<ContainerHostConfig | null>(null);
  const [config, setConfig] = useState<HostClaudeConfig>({});
  const [precheck, setPrecheck] = useState<Precheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<HostConfigApplyResult | null>(null);
  const inFlight = useRef(false);
  const localErrors = hostConfigErrors(config);
  const changed = !!info && !sameHostConfig(info.hostConfig, config);
  // 文件内容可能变化而路径未变，允许原位重新导入 MCP。
  const canReimport = !!info && !changed && !!config.mcpConfigs?.length;
  const needsCheck = changed || canReimport;
  const key = JSON.stringify(normalizeHostConfig(config));
  const invalid = localErrors.length > 0;
  const loaded = info !== null;

  useEffect(() => {
    let active = true;
    setInfo(null);
    setError(null);
    if (!isTauri()) {
      const entry = useFleetStore.getState().fleet.entries.find((e) => e.container.name === container);
      setInfo({ hostConfig: {}, running: entry?.container.running ?? false, containerId: entry?.container.id ?? container, affectedSessions: 2 });
      return;
    }
    containerHostConfigGet(container).then((value) => {
      if (!active) return;
      setInfo(value);
      setConfig(value.hostConfig);
    }).catch((cause) => { if (active) setError(`读取配置失败：${errorText(cause)}`); });
    return () => { active = false; };
  }, [container]);

  useEffect(() => {
    setPrecheck(null);
    if (!loaded || !needsCheck || invalid || result) return;
    if (!isTauri()) {
      setPrecheck({ ok: true, errors: [], warnings: [] });
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      containerHostConfigPrecheck(container, JSON.parse(key) as HostClaudeConfig)
        .then((value) => { if (active) setPrecheck(value); })
        .catch((cause) => { if (active) setPrecheck({ ok: false, errors: [`预检失败：${errorText(cause)}`], warnings: [] }); });
    }, 400);
    return () => { active = false; clearTimeout(timer); };
  }, [container, key, needsCheck, invalid, loaded, result]);

  const close = () => { if (!inFlight.current) closeModal(); };
  const errors = [...localErrors, ...(precheck?.errors ?? [])];
  const canApply = !!info && needsCheck && !invalid && precheck?.ok && !busy && !result;
  const apply = async () => {
    if (!canApply || !info || inFlight.current) return;
    if (!isTauri()) {
      useUiStore.getState().toast("info", "演示模式：未实际修改或重建容器");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const applied = await containerHostConfigApply(container, normalizeHostConfig(config), info.containerId);
      setResult(applied);
      const st = useTabStore.getState();
      if (applied.containerId !== info.containerId) {
        for (const session of Object.values(st.sessions)) if (session.container === container) st.markExited(session.id, null);
      }
    } catch (cause) {
      setError(`应用失败：${errorText(cause)}`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal title="宿主 Claude 配置" icon="folder_shared" badge={container} width={760} onClose={close}
      footerLeft={<span className={`font-ui text-label-sm ${errors.length ? "text-st-bad" : "text-on-surface-variant"}`}>{busy ? canReimport ? "正在重新导入 MCP…" : "正在保存快照并应用配置…" : result ? "配置已应用" : errors[0] ?? (canReimport ? "重新导入 MCP 不重建容器" : changed ? "应用将重建该容器" : "未修改配置")}</span>}
      footer={<>
        <Button disabled={busy} onClick={close}>{result ? "完成" : "取消"}</Button>
        {!result && <Button variant="primary" icon="autorenew" disabled={!canApply} onClick={() => void apply()}>{busy ? "正在应用…" : canReimport ? "重新导入 MCP" : "应用并重建"}</Button>}
      </>}
    >
      <div className="flex flex-col gap-4">
        {error && <div role="alert"><Callout tone="danger">{error}</Callout></div>}
        {!info && !error && <p className="font-ui text-body-md text-outline">正在读取容器配置…</p>}
        {result ? <>
          <Callout tone="success">{result.mcpRefreshed ? "MCP 已重新导入，下次启动 Claude 时生效，当前终端保持运行。" : result.containerId === info?.containerId
            ? "配置内容未变化，当前容器和会话保持运行。"
            : `配置已应用，容器已${result.restarted ? "重新启动" : "重建并保持停止"}。会话历史保留，可从底部会话列表恢复到新终端。`}</Callout>
          {result.snapshotImage && <div className="font-ui text-body-sm text-on-surface-variant">原容器文件快照：<code className="break-all font-mono">{result.snapshotImage}</code></div>}
          {result.backupContainer && <Callout tone="warning">原容器备份仍保留：{result.backupContainer}。它与新容器使用同一组数据卷，请勿同时启动。</Callout>}
          {result.warnings.map((warning) => <Callout key={warning} tone="warning">{warning}</Callout>)}
        </> : info && <>
          <HostConfigFields value={config} onChange={(value) => { setConfig(value); setError(null); }} disabled={busy} />
          {canReimport && <Callout tone="info">路径未变化，可重新导入宿主 MCP 配置；新配置在下次启动 Claude 时生效，当前会话继续运行。</Callout>}
          {changed && <Callout tone="warning">
            Docker 调整挂载需要重建容器{info.running ? `，会结束该容器内的 tmux 会话和后台进程${info.affectedSessions ? `（登记终端 ${info.affectedSessions} 个）` : ""}` : ""}。
            应用前保存原容器文件快照，保留凭证卷、项目挂载和会话历史。
          </Callout>}
          {needsCheck && !invalid && !precheck && <p className="font-ui text-body-sm text-outline">正在检查路径、镜像和 MCP 配置…</p>}
          {errors.map((message) => <Callout key={message} tone="danger">{message}</Callout>)}
          {precheck?.warnings.map((message) => <Callout key={message} tone="warning">{message}</Callout>)}
        </>}
      </div>
    </Modal>
  );
}
