import type { ProxyBinding, ProxyNodeView } from "../../api/types";
import { patchProxyBinding, proxyBindingEngine, proxyBindingError } from "../../lib/proxyBinding";
import { Button, Checkbox, Field, Select } from "../ui/controls";

const KIND_PREFIX = { subscription: "[订阅] ", vless: "[vless] ", socks5: "[SOCKS5] " };

/** 新建容器与右键代理共用同一套链路字段、候选过滤和更新规则；内核在节点编辑中设置，由主节点决定。 */
export function ProxyBindingFields({ value, nodes, onChange, onManage, disabled = false, compact = false }: {
  value: ProxyBinding;
  nodes: ProxyNodeView[];
  onChange: (value: ProxyBinding) => void;
  onManage: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const patch = (p: Partial<ProxyBinding>) => onChange(patchProxyBinding(value, p));
  const node = nodes.find((n) => n.id === value.nodeId);
  const relay = nodes.find((n) => n.id === value.staticId);
  const exit = nodes.find((n) => n.id === value.exitId);
  const engine = proxyBindingEngine(value, nodes);
  return (
    <>
      <fieldset disabled={disabled || !value.enabled} className={`flex min-w-0 flex-col gap-3 ${value.enabled ? "" : "opacity-40"}`}>
        <div className={`grid gap-2 ${compact ? "grid-cols-2" : "grid-cols-3"}`}>
          <Field label="静态中转（可选）" hint="第一跳，只能是 vless">
            <Select aria-label="静态中转" value={value.staticId ?? ""} onChange={(e) => patch({ staticId: e.target.value || null })}>
              <option value="">不使用（直连节点）</option>
              {nodes.filter((n) => n.kind === "vless" && n.id !== value.nodeId).map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </Select>
          </Field>
          <div className={compact ? "order-first col-span-2 min-w-0" : "min-w-0"}>
            <Field label="节点" required error={proxyBindingError(value, nodes)}>
              <Select aria-label="代理节点" value={value.nodeId ?? ""} onChange={(e) => patch({ nodeId: e.target.value || null })}>
                <option value="">请选择…</option>
                {nodes.map((n) => <option key={n.id} value={n.id}>{KIND_PREFIX[n.kind]}{n.name}{n.engine === "xray" ? " · Xray" : ""}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="出口（可选）" hint="最后一跳，只能是 SOCKS5">
            <Select aria-label="代理出口" value={value.exitId ?? ""} onChange={(e) => patch({ exitId: e.target.value || null })}>
              <option value="">不使用（节点直达目标）</option>
              {nodes.filter((n) => n.kind === "socks5" && n.id !== value.nodeId).map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </Select>
          </Field>
        </div>
        {node && <span className="flex flex-col gap-0.5 break-words font-mono text-code-sm text-on-surface-variant">
          <span>链路：容器 → {relay ? `${relay.name} → ` : ""}{node.name} → {exit ? `${exit.name} → ` : ""}目标 · 内核 {engine === "xray" ? "Xray" : "Mihomo"}</span>
          {!compact && <span>节点 {node.display}{exit && ` · 出口 ${exit.display}`}</span>}
        </span>}
        <Checkbox checked={value.allowLan} onChange={(v) => patch({ allowLan: v })}
          label="允许直连宿主机与局域网（10/8、172.16/12、192.168/16）"
          desc="默认禁止。开启后可访问 host.docker.internal 与局域网服务，DNS 仍经代理解析" />
      </fieldset>
      <div className="flex items-center gap-2">
        {nodes.length === 0 && <span className="font-ui text-body-sm text-st-warn">节点库为空。</span>}
        <Button variant="subtle" icon="add" disabled={disabled} onClick={onManage}>管理节点…</Button>
      </div>
    </>
  );
}
