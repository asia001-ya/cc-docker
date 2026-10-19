import type { ProxyBinding, ProxyNodeView } from "../../api/types";
import { patchProxyBinding, proxyBindingEngine, proxyNodeBindingError } from "../../lib/proxyBinding";
import { DEFAULT_LAN_CIDRS, MAX_LAN_CIDRS, lanCidrsError } from "../../lib/proxyLan";
import { Button, Checkbox, Field, IconButton, Input, Select } from "../ui/controls";

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
            <Field label="节点" required error={proxyNodeBindingError(value, nodes)}>
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
          label="允许直连指定内网"
          desc="仅填写的 IP 或网段直连；Claude 等公网请求和 DNS 继续走代理" />
        {value.allowLan && <Field label="允许直连的 IP / 网段" required error={lanCidrsError(value.lanCidrs)}
          hint="每行一个私有 IPv4 地址或 CIDR；宿主机地址也需包含在列表中">
          <div className="flex flex-col gap-2">
            {value.lanCidrs.map((cidr, index) => <div key={index} className="flex min-w-0 items-center gap-2">
              <Input mono className="min-w-0 flex-1" aria-label={`内网地址或网段 ${index + 1}`} value={cidr}
                placeholder="192.168.1.20 或 10.20.0.0/16" spellCheck={false}
                onChange={(e) => patch({ lanCidrs: value.lanCidrs.map((v, i) => i === index ? e.target.value : v) })} />
              <IconButton icon="delete" title={`删除内网网段 ${index + 1}`} className="shrink-0"
                onClick={() => patch({ lanCidrs: value.lanCidrs.filter((_, i) => i !== index) })} />
            </div>)}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="subtle" icon="add" disabled={value.lanCidrs.length >= MAX_LAN_CIDRS}
                onClick={() => patch({ lanCidrs: [...value.lanCidrs, ""] })}>添加 IP / 网段</Button>
              <Button variant="subtle" onClick={() => patch({ lanCidrs: [...DEFAULT_LAN_CIDRS] })}>恢复默认网段</Button>
            </div>
            <p className="font-ui text-body-sm text-on-surface-variant">支持 10/8、172.16/12、192.168/16 内的地址。未列出的内网仍被阻断，公网不允许加入直连列表。</p>
          </div>
        </Field>}
      </fieldset>
      <div className="flex items-center gap-2">
        {nodes.length === 0 && <span className="font-ui text-body-sm text-st-warn">节点库为空。</span>}
        <Button variant="subtle" icon="add" disabled={disabled} onClick={onManage}>管理节点…</Button>
      </div>
    </>
  );
}
