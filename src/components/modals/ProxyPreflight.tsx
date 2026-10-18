import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProxyApplyResult, ProxyBinding, ProxyNodeView } from "../../api/types";
import { errorText, isTauri, proxyPreflight } from "../../api/commands";
import { proxyBindingEngine, proxyBindingError } from "../../lib/proxyBinding";
import { PROXY_CHECK_LABELS } from "../../lib/proxyChecks";
import { Button, Callout, Icon } from "../ui/controls";
import { Modal } from "../ui/Modal";

/** 在新建表单内执行真实代理自检；更改配置或节点库后丢弃旧结果。 */
export function ProxyPreflight({ image, binding, nodes, disabled, onCheckingChange }: {
  image: string;
  binding: ProxyBinding;
  nodes: ProxyNodeView[];
  disabled: boolean;
  onCheckingChange: (checking: boolean) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<ProxyApplyResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setResult(null);
    setNotice(null);
    setShowDetails(false);
    return () => { generation.current += 1; };
  }, [image, binding, nodes]);

  const check = async () => {
    if (checking || disabled || !binding.enabled) return;
    setResult(null);
    setNotice(null);
    setShowDetails(true);
    const invalid = proxyBindingError(binding, nodes);
    if (invalid) return setResult({ ok: false, stage: "config", error: invalid });
    if (!isTauri()) return setNotice("演示模式未连接 Docker，无法执行真实代理自检。请在桌面工具中点击此按钮。");
    const run = generation.current;
    setChecking(true);
    onCheckingChange(true);
    try {
      const checked = await proxyPreflight(image, binding);
      if (run === generation.current) setResult(checked);
    } catch (e) {
      if (run === generation.current) setResult({ ok: false, stage: "check", error: errorText(e) });
    } finally {
      setChecking(false);
      onCheckingChange(false);
    }
  };

  return <>
    <div className="flex h-8 items-center gap-2" aria-live="polite" aria-busy={checking}>
      <Button icon={checking ? "progress_activity" : "fact_check"} disabled={disabled || checking || !binding.enabled || !image.trim()}
        onClick={() => void check()}>{checking ? "自检中…" : "校验自检"}</Button>
      {checking || result || notice ? <Button variant="subtle" onClick={() => setShowDetails(true)}>
        {checking ? "查看进度" : result?.ok ? "已通过 · 查看结果" : "查看结果"}
      </Button> : <span className="font-ui text-label-sm text-outline">检查网络、DNS 与断网保护</span>}
    </div>
    {showDetails && createPortal(<Modal title="代理自检结果" icon="fact_check" width={560}
      onClose={() => setShowDetails(false)} footer={<Button onClick={() => setShowDetails(false)}>返回配置</Button>}>
      <div className="flex flex-col gap-4" aria-live="polite" aria-busy={checking}>
        {checking && <Callout tone="info">正在临时容器内检查代理链路和出口 IP，通常需要 10–40 秒，结束后自动清理…{proxyBindingEngine(binding, nodes) === "xray" && "旧镜像首次使用 Xray 时需要下载内核，可能稍久。"}</Callout>}
        {notice && <Callout tone="info">{notice}</Callout>}
        {result && <>
          <Callout tone={result.ok ? "success" : "danger"}>
            {result.ok ? "自检通过，当前代理链路可用。" : `自检未通过${result.error ? `：${result.error}` : "，请检查下方失败项后重试。"}`}
          </Callout>
          <div className="rounded-lg border border-white/10 bg-black/20 p-3">
            <div className="font-ui text-label-md text-on-surface-variant">出口 IP</div>
            <div className="mt-1 select-text break-all font-mono text-lg text-accent">{result.exitIp ?? "未获取"}</div>
            <div className="mt-1 font-ui text-body-sm text-outline">{result.exitIp ? "经当前代理链路查询" : result.exitIpError ?? "本次自检未获取出口地址"}</div>
          </div>
        </>}
        {result?.checks && <div className="grid grid-cols-1 gap-2">
          {Object.entries(result.checks).map(([key, ok]) => <span key={key} className="flex items-center gap-1.5 font-ui text-body-md">
            <Icon name={ok ? "check_circle" : "cancel"} className={ok ? "text-st-ok" : "text-st-bad"} />
            {PROXY_CHECK_LABELS[key] ?? key}
          </span>)}
        </div>}
      </div>
    </Modal>, document.body)}
  </>;
}
