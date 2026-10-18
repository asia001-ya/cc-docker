import { useEffect, useRef, useState } from "react";
import type { GitSharingView } from "../../api/types";
import { containerGitApply, containerGitGet, errorText, isTauri } from "../../api/commands";
import { useUiStore } from "../../store/uiStore";
import { Modal } from "../ui/Modal";
import { Button, Callout, Input, Switch } from "../ui/controls";

export function GitSharingModal({ container }: { container: string }) {
  const close = useUiStore(s => s.closeModal);
  const [info, setInfo] = useState<GitSharingView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [hosts, setHosts] = useState("");
  const [syncIdentity, setSyncIdentity] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const inFlight = useRef(false);
  const applyInfo = (value: GitSharingView) => {
    setInfo(value); setEnabled(value.config.enabled); setHosts(value.config.allowedHosts.join(", ")); setSyncIdentity(value.config.syncIdentity);
  };
  useEffect(() => {
    let active = true;
    if (!isTauri()) {
      applyInfo({ config: { enabled: false, allowedHosts: [], syncIdentity: false }, containerId: "demo", running: true, connected: false, gitAvailable: true, helperConfigured: true, identity: { name: null, email: null } });
      return;
    }
    containerGitGet(container).then(value => { if (active) applyInfo(value); }).catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [container]);
  const allowedHosts = [...new Set(hosts.split(/[\s,，;；]+/).map(value => value.trim().toLowerCase()).filter(Boolean))];
  const validHosts = allowedHosts.length > 0 && allowedHosts.length <= 16 && allowedHosts.every(host => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?$/.test(host));
  const save = async () => {
    if (!info || inFlight.current || (enabled && (!validHosts || !info.running || !info.gitAvailable))) return;
    inFlight.current = true; setBusy(true); setError(""); setSaved(false);
    const config = { enabled, allowedHosts, syncIdentity };
    try {
      const value = isTauri() ? await containerGitApply(container, info.containerId, config) : { ...info, config, connected: enabled };
      applyInfo(value); setSaved(true);
    } catch (cause) { setError(errorText(cause)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const edit = () => setSaved(false);
  return <Modal title="Git 凭据" icon="key" badge={container} width={660} onClose={() => { if (!busy) close(); }} onSubmit={save}
    footerLeft={<span className="font-ui text-body-sm text-outline">{!isTauri() ? "界面预览 · 合成状态" : info?.connected ? "宿主凭据连接正常" : info?.config.enabled ? "等待连接宿主" : "使用容器自身配置"}</span>}
    footer={<><Button disabled={busy} onClick={close}>关闭</Button><Button variant="primary" disabled={!info || busy || (enabled && (!validHosts || !info.running || !info.gitAvailable))} onClick={save}>{busy ? "正在应用…" : "应用"}</Button></>}>
    <div className="flex flex-col gap-5">
      {error && <Callout tone="danger">{error}</Callout>}
      {saved && <Callout tone="success">{enabled ? "宿主 Git 凭据已启用，当前终端即可使用。" : "宿主 Git 凭据已关闭。"}</Callout>}
      {!info ? <p className="text-body-md text-outline">正在检查宿主 Git…</p> : <>
        <div className="rounded-lg border border-white/[0.08] bg-black/10 p-4">
          <p className="mb-2 font-ui text-body-md text-on-surface">宿主机 Git</p>
          <p className="font-ui text-body-sm text-on-surface-variant">{!info.gitAvailable ? "未检测到 Git，请先安装并加入 PATH。" : info.helperConfigured ? "已检测到凭据管理器，使用宿主机已保存的 HTTPS 登录。" : "已安装 Git，尚未检测到默认凭据管理器。请先在宿主机登录目标 Git 服务。"}</p>
        </div>
        <div className="flex flex-col gap-2">
          <Switch checked={enabled} onChange={value => { edit(); setEnabled(value); }} disabled={busy} label="使用宿主机 Git 凭据" />
          <p className="font-ui text-body-sm text-outline">仅对下面的 Git 服务生效。使用期间保持桌面应用运行。</p>
        </div>
        {enabled && <label className="flex flex-col gap-2 font-ui text-body-md text-on-surface">
          允许访问的 Git 服务
          <Input mono aria-label="允许访问的 Git 服务" value={hosts} disabled={busy} placeholder="gitee.com, github.com" onChange={event => { edit(); setHosts(event.target.value); }} invalid={hosts.length > 0 && !validHosts} />
          <span className="text-body-sm text-outline">填写域名，用逗号分隔；支持 HTTPS，可附带端口。</span>
        </label>}
        {enabled && !info.running && <Callout tone="warning">请先启动容器，再启用宿主 Git 凭据。</Callout>}
        <div className="flex flex-col gap-2 border-t border-white/[0.08] pt-4">
          <Switch checked={syncIdentity} onChange={value => { edit(); setSyncIdentity(value); }} disabled={!enabled || busy} label="同步宿主机的提交姓名和邮箱" />
          <p className="font-ui text-body-sm text-on-surface-variant">姓名：{info.identity.name || "未配置"}　邮箱：{info.identity.email || "未配置"}</p>
          <p className="font-ui text-body-sm text-outline">未配置的项沿用容器原值；项目内的 Git 配置优先。</p>
        </div>
      </>}
    </div>
  </Modal>;
}
