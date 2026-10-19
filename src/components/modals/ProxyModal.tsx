/**
 * 单容器代理弹框：开关代理、选择节点 / 静态中转 / 出口、局域网直连，展示容器内实际状态与自检结果。
 * 期望状态保存在桌面端并推入容器；实际状态来自 fleet 轮询的 proxy-status.json。
 */
import { useEffect, useState } from "react";
import type { ProxyApplyResult, ProxyBinding, ProxyInfo, ProxyNodeView } from "../../api/types";
import {
  errorText,
  isTauri,
  proxyApply,
  proxyCapabilityApply,
  proxyDelay,
  proxyGet,
  proxyNodeList,
  proxyNodes,
  proxyOff,
  proxyRefresh,
  proxySelect,
} from "../../api/commands";
import { useUiStore } from "../../store/uiStore";
import { useEntry } from "../../store/fleetStore";
import { DEMO_PROXY_NODES } from "../../lib/demo";
import { EMPTY_PROXY_BINDING as EMPTY_BINDING, patchProxyBinding, proxyBindingError } from "../../lib/proxyBinding";
import { DEFAULT_LAN_CIDRS } from "../../lib/proxyLan";
import { PROXY_CHECK_LABELS as CHECK_LABEL } from "../../lib/proxyChecks";
import { ProxyBindingFields } from "./ProxyBindingFields";
import { Modal } from "../ui/Modal";
import { Button, Callout, Icon, Section, Switch } from "../ui/controls";

/** 状态徽标：文案、颜色与说明 */
export const PROXY_STATE_META: Record<string, { label: string; color: string; desc: string }> = {
  off: { label: "未开启", color: "text-outline", desc: "容器直连网络" },
  starting: { label: "启动中", color: "text-st-warn", desc: "内核正在建立 TUN，此期间网络不通" },
  ok: { label: "运行中", color: "text-st-ok", desc: "公网流量经节点，DNS 经代理解析" },
  blackhole: { label: "已断网", color: "text-st-bad", desc: "代理不可用，兜底规则已阻断所有直连（失败即断网）" },
  leak: { label: "兜底缺失", color: "text-st-bad", desc: "代理已启用但兜底规则不完整，流量可能绕过代理" },
};

/**
 * 代理弹框。
 * @param props container 容器名
 * @returns JSX
 */
export function ProxyModal({ container }: { container: string }) {
  const close = useUiStore((s) => s.closeModal);
  const toast = useUiStore((s) => s.toast);
  const openModal = useUiStore((s) => s.openModal);
  const status = useEntry(container)?.proxy ?? null;
  const [info, setInfo] = useState<ProxyInfo | null>(null);
  const [nodes, setNodes] = useState<ProxyNodeView[]>([]);
  const [draft, setDraft] = useState<ProxyBinding>(EMPTY_BINDING);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ProxyApplyResult | null>(null);
  const [group, setGroup] = useState<{ now: string | null; all: string[] } | null>(null);
  const [delays, setDelays] = useState<Record<string, number>>({});
  const [confirmRebuild, setConfirmRebuild] = useState(false);

  /**
   * 加载容器代理视图与节点库。
   * @returns 无
   */
  const load = () => {
    if (!isTauri()) {
      setNodes(DEMO_PROXY_NODES);
      setInfo({ binding: null, capability: { imageSupported: true, granted: true, rootEntry: true, xray: true }, running: true });
      return;
    }
    proxyGet(container)
      .then((i) => {
        setInfo(i);
        // 旧版绑定没有 exitId 字段，补齐默认值
        if (i.binding) setDraft({ ...EMPTY_BINDING, ...i.binding });
      })
      .catch((e) => toast("error", errorText(e)));
    proxyNodeList().then(setNodes).catch((e) => toast("error", errorText(e)));
  };
  useEffect(load, [container, toast]);

  const node = nodes.find((n) => n.id === draft.nodeId) ?? null;
  const cap = info?.capability;
  const ready = !!cap && cap.imageSupported && cap.granted && cap.rootEntry;
  const running = info?.running ?? false;
  const live = status?.state === "ok";
  const subscriptionLive = live && node?.kind === "subscription";

  // 订阅节点运行中时加载节点列表，供手动选择
  useEffect(() => {
    if (!subscriptionLive || !isTauri()) return setGroup(null);
    proxyNodes(container).then(setGroup).catch(() => setGroup(null));
  }, [subscriptionLive, container, status?.selected]);

  /**
   * 修改期望状态。
   * @param p 部分字段
   * @returns 无
   */
  const patch = (p: Partial<ProxyBinding>) => {
    setDraft(patchProxyBinding(draft, p));
  };

  /**
   * 应用：开启时写配置并在容器内自检；关闭时恢复直连。
   * @returns Promise
   */
  const apply = async () => {
    if (!isTauri()) return toast("info", "演示模式：未连接后端");
    const validationError = proxyBindingError(draft, nodes);
    if (validationError) return toast("warning", validationError);
    setBusy("apply");
    setResult(null);
    try {
      const r = await proxyApply(container, draft);
      setResult(r);
      if (!draft.enabled) toast("success", `${container} 已关闭代理，恢复直连`);
      else if (r.ok) toast("success", `${container} 代理已生效，自检全部通过`);
      else toast("error", `代理未生效（${r.stage}）：${r.error ?? "自检未通过"}。网络保持断开，可修改后重试或关闭代理`);
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setBusy(null);
    }
  };

  /**
   * 救援：关闭代理并恢复直连（不依赖容器网络）。
   * @returns Promise
   */
  const rescue = async () => {
    if (!isTauri()) return;
    setBusy("off");
    try {
      await proxyOff(container);
      setDraft({ ...draft, enabled: false });
      setResult(null);
      toast("success", `${container} 已关闭代理，恢复直连`);
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setBusy(null);
    }
  };

  /**
   * 重建容器以授予代理能力。
   * @returns Promise
   */
  const rebuild = async () => {
    if (!isTauri()) return;
    setBusy("rebuild");
    try {
      await proxyCapabilityApply(container);
      toast("success", `${container} 已重建并授予代理能力`);
      setConfirmRebuild(false);
      load();
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setBusy(null);
    }
  };

  /**
   * 手动切换订阅节点。
   * @param name 节点名
   * @returns Promise
   */
  const select = async (name: string) => {
    try {
      await proxySelect(container, name);
      setGroup((g) => (g ? { ...g, now: name } : g));
      setDraft({ ...draft, selected: name });
    } catch (e) {
      toast("error", errorText(e));
    }
  };

  /**
   * 测延迟。
   * @returns Promise
   */
  const testDelay = async () => {
    setBusy("delay");
    try {
      setDelays((await proxyDelay(container)).delays);
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setBusy(null);
    }
  };

  /**
   * 刷新订阅。
   * @returns Promise
   */
  const refresh = async () => {
    setBusy("refresh");
    try {
      const r = await proxyRefresh(container);
      toast("success", r.refreshed.length ? "订阅已刷新" : "没有可刷新的订阅");
      setGroup(await proxyNodes(container));
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const meta = PROXY_STATE_META[status?.state ?? "off"] ?? PROXY_STATE_META.off;
  const canApply = ready && running && !busy && !proxyBindingError(draft, nodes);

  return (
    <Modal
      title={`容器代理 · ${container}`}
      icon="vpn_lock"
      width={760}
      onClose={close}
      onSubmit={canApply ? () => void apply() : undefined}
      footerLeft={
        status?.enabled || status?.guard ? (
          <Button variant="danger" icon="link_off" disabled={!!busy} onClick={() => void rescue()}>
            关闭代理（恢复直连）
          </Button>
        ) : (
          <span className="font-ui text-label-md text-on-surface-variant">公网经节点；代理不可用时阻断公网，不会回退直连</span>
        )
      }
      footer={
        <>
          <Button onClick={close}>取消</Button>
          <Button variant="primary" icon={draft.enabled ? "shield" : "link_off"} kbd="Ctrl+Enter" disabled={!canApply} onClick={() => void apply()}>
            {busy === "apply" ? "应用中…" : draft.enabled ? "应用并自检" : "关闭代理"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {info && !ready && (
          <Callout tone="warning" icon="build">
            <div className="flex flex-col gap-2">
              <span>
                {!cap?.imageSupported
                  ? "该容器的镜像不支持代理。请先在 docker 目录重新构建镜像，再重建容器。"
                  : !cap?.rootEntry
                    ? "该容器以非 root 用户启动，无法施加代理兜底规则，需要重建。"
                    : "该容器创建时未授予代理能力（NET_ADMIN + /dev/net/tun），需要重建。"}
                重建会保留凭证卷与会话历史，但会断开该容器的全部终端会话。
              </span>
              {confirmRebuild ? (
                <span className="flex gap-2">
                  <Button variant="danger" icon="autorenew" disabled={!!busy} onClick={() => void rebuild()}>
                    {busy === "rebuild" ? "重建中…" : "确认重建"}
                  </Button>
                  <Button onClick={() => setConfirmRebuild(false)}>取消</Button>
                </span>
              ) : (
                <Button icon="autorenew" className="self-start" onClick={() => setConfirmRebuild(true)}>
                  授予代理能力（重建容器）…
                </Button>
              )}
            </div>
          </Callout>
        )}
        {info && ready && !running && <Callout tone="info">容器未运行。启动后容器会按上次保存的代理设置自动恢复。</Callout>}
        {info && ready && draft.enabled && node?.engine === "xray" && !cap?.xray && (
          <Callout tone="warning" icon="build">
            节点「{node.name}」使用 Xray 内核，但该容器的镜像未内置 Xray。请用最新 docker/Dockerfile 重新构建镜像后重建容器，或在节点编辑中把内核改回 Mihomo。
          </Callout>
        )}

        <div className="flex items-start gap-3 rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
          <Icon name={status?.state === "ok" ? "verified_user" : status && status.state !== "off" ? "gpp_maybe" : "shield"} size={26} className={meta.color} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className={`font-ui text-headline-sm ${meta.color}`}>
              {meta.label}
              {status?.selected && <span className="ml-2 font-mono text-code-md text-on-surface">· {status.selected}</span>}
            </span>
            <span className="font-ui text-body-sm text-on-surface-variant">
              {meta.desc}
              {status?.enabled && ` · ${status.engine === "xray" ? "Xray" : "Mihomo"}`}
              {status && status.restarts > 0 && ` · 内核已自动重启 ${status.restarts} 次`}
              {status?.enabled && status.allow_lan && " · 已允许指定内网直连"}
            </span>
            {status?.enabled && status.allow_lan && <span className="break-words font-mono text-code-sm text-on-surface-variant">
              直连列表：{(status.lan_cidrs ?? DEFAULT_LAN_CIDRS).join("、") || "无有效网段"}
            </span>}
            {status?.last_error && <span className="break-all font-mono text-code-sm text-st-bad">{status.last_error}</span>}
            {status?.warnings.map((w) => (
              <span key={w} className="font-ui text-body-sm text-st-warn">
                {w}
              </span>
            ))}
            {status?.providers.map((p) => (
              <span key={p.name} className="font-ui text-body-sm text-on-surface-variant">
                订阅：{p.count} 个节点{p.updated_at ? ` · 更新于 ${new Date(p.updated_at * 1000).toLocaleString()}` : ""}
              </span>
            ))}
          </div>
        </div>

        <Section title="代理设置" icon="tune" aside={<Switch checked={draft.enabled} onChange={(v) => patch({ enabled: v })} label={draft.enabled ? "开启" : "关闭"} />}>
          <ProxyBindingFields value={draft} nodes={nodes} onChange={setDraft} disabled={!!busy}
            onManage={() => openModal({ kind: "settings", tab: "proxy" })} />
        </Section>

        {subscriptionLive && group && (
          <Section
            title="订阅节点"
            icon="hub"
            aside={
              <span className="flex gap-1.5">
                <Button variant="subtle" icon="speed" className="h-7" disabled={!!busy} onClick={() => void testDelay()}>
                  {busy === "delay" ? "测试中…" : "测延迟"}
                </Button>
                <Button variant="subtle" icon="refresh" className="h-7" disabled={!!busy} onClick={() => void refresh()}>
                  刷新订阅
                </Button>
              </span>
            }
          >
            <div className="grid max-h-48 grid-cols-2 gap-1.5 overflow-y-auto">
              {group.all.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => void select(name)}
                  className={`flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-left ${group.now === name ? "border-accent/60 bg-accent/[0.10]" : "border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.06]"}`}
                >
                  <span className="truncate font-ui text-body-md text-on-surface">{name}</span>
                  {delays[name] !== undefined ? (
                    <span className={`font-mono text-code-sm ${delays[name] < 300 ? "text-st-ok" : delays[name] < 800 ? "text-st-warn" : "text-st-bad"}`}>{delays[name]}ms</span>
                  ) : (
                    Object.keys(delays).length > 0 && <span className="font-mono text-code-sm text-outline">超时</span>
                  )}
                </button>
              ))}
            </div>
            <span className="font-ui text-body-sm text-on-surface-variant">手动选择的节点会被记住；该节点不可用时容器断网，不会自动换节点。</span>
          </Section>
        )}

        {result?.checks && (
          <Section title="自检结果" icon="fact_check">
            <div className="rounded-lg bg-black/20 p-3">
              <span className="font-ui text-body-sm text-on-surface-variant">出口 IP：</span>
              <span className="select-text break-all font-mono text-body-md text-accent">{result.exitIp ?? "未获取"}</span>
              {result.exitIpError && <div className="mt-1 font-ui text-body-sm text-outline">{result.exitIpError}</div>}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {Object.entries(result.checks).map(([k, v]) => (
                <span key={k} className="flex items-center gap-1.5 font-ui text-body-md">
                  <Icon name={v ? "check_circle" : "cancel"} size={16} className={v ? "text-st-ok" : "text-st-bad"} />
                  {CHECK_LABEL[k] ?? k}
                </span>
              ))}
            </div>
          </Section>
        )}
        {result && !result.ok && !result.checks && result.error && <Callout tone="danger">{result.error}</Callout>}
      </div>
    </Modal>
  );
}
