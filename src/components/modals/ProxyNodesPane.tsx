/**
 * 设置 → 代理节点：节点库 CRUD。
 * 节点地址（订阅链接 / vless 链接 / SOCKS5 地址与认证）只写入 Windows 凭据管理器，列表中只显示后端生成的摘要，不回显密钥。
 */
import { useEffect, useState } from "react";
import type { ProxyEngine, ProxyNode, ProxyNodeKind, ProxyNodeView } from "../../api/types";
import { errorText, isTauri, proxyNodeDelete, proxyNodeList, proxyNodeSave } from "../../api/commands";
import { useUiStore } from "../../store/uiStore";
import { DEMO_PROXY_NODES } from "../../lib/demo";
import { buildSocks5Uri, type Socks5Fields } from "../../lib/validators";
import { Button, Callout, CardRadio, Field, Icon, Input, Select, TextArea } from "../ui/controls";

/** 节点类型的展示文案 */
const KIND_LABEL: Record<ProxyNodeKind, string> = { subscription: "订阅", vless: "vless", socks5: "SOCKS5" };
/** 节点类型图标 */
const KIND_ICON: Record<ProxyNodeKind, string> = { subscription: "rss_feed", vless: "link", socks5: "router" };
/** 空的 SOCKS5 表单 */
const EMPTY_SOCKS: Socks5Fields = { host: "", port: "", username: "", password: "" };

/**
 * 代理节点管理页。
 * @returns JSX
 */
export function ProxyNodesPane({ onChanged }: { onChanged?: (nodes: ProxyNodeView[]) => void }) {
  const toast = useUiStore((s) => s.toast);
  const [list, setList] = useState<ProxyNodeView[]>([]);
  const [edit, setEdit] = useState<ProxyNode | null>(null);
  const [secret, setSecret] = useState("");
  const [socks, setSocks] = useState<Socks5Fields>(EMPTY_SOCKS);
  const [busy, setBusy] = useState(false);

  /**
   * 打开编辑表单（清空上次输入的密钥）。
   * @param node 待编辑节点；null 关闭表单
   * @returns 无
   */
  const openEdit = (node: ProxyNode | null) => {
    setEdit(node);
    setSecret("");
    setSocks(EMPTY_SOCKS);
  };

  /**
   * 计算要提交的密钥：SOCKS5 由表单拼接，其余类型取文本框。
   * 编辑已有节点时全部留空表示不修改（返回 null）。
   * @returns { secret } 或带 error 的结果
   */
  const pendingSecret = (): { secret: string | null; error?: string } => {
    if (edit?.kind !== "socks5") return { secret: secret.trim() || null };
    const touched = Object.values(socks).some((v) => v.trim() !== "");
    if (!touched) return edit.id ? { secret: null } : { secret: null, error: "请填写主机与端口" };
    const r = buildSocks5Uri(socks);
    return r.uri ? { secret: r.uri } : { secret: null, error: r.error };
  };

  /**
   * 刷新列表。
   * @returns 无
   */
  const reload = () => {
    const update = (nodes: ProxyNodeView[]) => { setList(nodes); onChanged?.(nodes); };
    if (!isTauri()) return update(DEMO_PROXY_NODES);
    proxyNodeList().then(update).catch((e) => toast("error", errorText(e)));
  };
  useEffect(reload, [toast, onChanged]);

  /**
   * 保存当前编辑项（地址由后端校验并生成摘要）。
   * @returns Promise
   */
  const save = async () => {
    if (!edit) return;
    if (!edit.name.trim()) return toast("warning", "请填写节点名称");
    const pending = pendingSecret();
    if (pending.error) return toast("warning", pending.error);
    if (!edit.id && !pending.secret) return toast("warning", edit.kind === "subscription" ? "请填写订阅地址" : "请粘贴 vless 链接");
    if (!isTauri()) return toast("info", "演示模式：未连接后端");
    setBusy(true);
    try {
      const saved = await proxyNodeSave(edit, pending.secret);
      toast("success", `节点「${saved.name}」已保存（${saved.display}）`);
      openEdit(null);
      reload();
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 删除节点（仍被容器使用时后端拒绝并说明是哪些容器）。
   * @param id 节点 ID
   * @returns Promise
   */
  const del = async (id: string) => {
    if (!isTauri()) return;
    try {
      await proxyNodeDelete(id);
      reload();
    } catch (e) {
      toast("error", errorText(e));
    }
  };

  if (edit) {
    const isNew = !edit.id;
    return (
      <div className="flex flex-col gap-3">
        <CardRadio
          columns={3}
          value={edit.kind}
          onChange={(kind) => setEdit({ ...edit, kind })}
          options={[
            { value: "subscription", icon: KIND_ICON.subscription, title: "订阅链接", desc: "http(s) 地址，容器内定时拉取；Mihomo 支持 Clash 格式与分享链接列表" },
            { value: "vless", icon: KIND_ICON.vless, title: "单条 vless", desc: "vless://… 分享链接；可作为节点，也可作为静态中转" },
            { value: "socks5", icon: KIND_ICON.socks5, title: "SOCKS5", desc: "可作为节点（如宿主 v2rayN），也可作为出口（固定落地 IP）" },
          ]}
        />
        <Field label="名称" required>
          <Input
            value={edit.name}
            onChange={(e) => setEdit({ ...edit, name: e.target.value })}
            placeholder="填写节点名称"
            data-autofocus
          />
        </Field>
        <Field label="代理内核" hint={edit.engine === "xray"
          ? "支持 VLESS / REALITY（含 DMIT）、SOCKS5；订阅需为分享链接或 Base64 格式。作为主节点时整条链路使用该内核"
          : "支持 Clash YAML、分享链接与 Base64 订阅。作为主节点时整条链路使用该内核"}>
          <Select aria-label="代理内核" value={edit.engine} onChange={(e) => setEdit({ ...edit, engine: e.target.value as ProxyEngine })}>
            <option value="mihomo">Mihomo</option>
            <option value="xray">Xray（适用于新版 REALITY）</option>
          </Select>
        </Field>
        {edit.kind === "socks5" ? (
          <Socks5Form value={socks} onChange={setSocks} isNew={isNew} display={edit.display} />
        ) : (
          <Field
            label={edit.kind === "subscription" ? "订阅地址" : "vless 链接"}
            required={isNew}
            hint={isNew ? "保存到 Windows 凭据管理器，不写入配置文件" : `留空表示不修改（当前：${edit.display}）`}
          >
            <TextArea
              rows={3}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={edit.kind === "subscription" ? "粘贴订阅 URL" : "粘贴完整的 vless:// 分享链接"}
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={() => openEdit(null)}>返回</Button>
          <Button variant="primary" icon="save" disabled={busy} onClick={() => void save()}>
            保存节点
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Callout tone="info">
        节点库供所有容器共用；可在新建容器时或容器右键菜单「代理…」中开启代理并选择节点。静态中转只能使用单条 vless 节点，出口只能使用 SOCKS5 节点。
      </Callout>
      {list.length === 0 && <span className="font-ui text-body-sm text-on-surface-variant">还没有节点。</span>}
      {list.map((n) => (
        <div key={n.id} className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.03] p-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <Icon name={KIND_ICON[n.kind]} size={18} className="text-accent" />
            <div className="flex min-w-0 flex-col">
              <span className="font-ui text-headline-sm text-on-surface">
                {n.name}
                <span className="ml-2 rounded bg-white/[0.06] px-1.5 py-px font-ui text-label-sm text-on-surface-variant">{KIND_LABEL[n.kind]}</span>
                {n.engine === "xray" && <span className="ml-1 rounded bg-accent/15 px-1.5 py-px font-ui text-label-sm text-accent">Xray</span>}
              </span>
              <span className="truncate font-mono text-code-sm text-on-surface-variant">{n.display}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!n.hasSecret && <span className="font-ui text-label-sm text-st-warn">地址缺失</span>}
            <Button
              variant="subtle"
              icon="edit"
              className="h-7"
              onClick={() => openEdit({ id: n.id, name: n.name, kind: n.kind, engine: n.engine ?? "mihomo", display: n.display })}
            >
              编辑
            </Button>
            <Button variant="subtle" icon="delete" className="h-7 hover:!text-st-bad" onClick={() => void del(n.id)}>
              删除
            </Button>
          </div>
        </div>
      ))}
      <Button
        icon="add"
        className="self-start"
        onClick={() => openEdit({ id: "", name: "", kind: "subscription", engine: "mihomo", display: "" })}
      >
        新增节点
      </Button>
    </div>
  );
}

/**
 * SOCKS5 分字段表单：主机、端口必填，用户名与密码可选。
 * 编辑已有节点时四项都留空表示不修改；改动任一项需四项完整重填（凭据管理器不回显旧值）。
 * @param props value 表单值；onChange 修改回调；isNew 是否新建；display 当前摘要
 * @returns JSX
 */
function Socks5Form({ value, onChange, isNew, display }: { value: Socks5Fields; onChange: (v: Socks5Fields) => void; isNew: boolean; display: string }) {
  /**
   * 生成单个字段的 onChange。
   * @param k 字段名
   * @returns 事件处理函数
   */
  const set = (k: keyof Socks5Fields) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[1fr_120px] gap-3">
        <Field label="主机" required={isNew}>
          <Input mono value={value.host} onChange={set("host")} placeholder="填写代理服务器地址" spellCheck={false} autoComplete="off" />
        </Field>
        <Field label="端口" required={isNew}>
          <Input mono value={value.port} onChange={set("port")} placeholder="1080" inputMode="numeric" autoComplete="off" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="用户名">
          <Input mono value={value.username} onChange={set("username")} placeholder="无认证可留空" spellCheck={false} autoComplete="off" />
        </Field>
        <Field label="密码">
          <Input mono type="password" value={value.password} onChange={set("password")} placeholder="无认证可留空" autoComplete="new-password" />
        </Field>
      </div>
      <span className="font-ui text-body-sm text-on-surface-variant">
        {isNew ? "保存到 Windows 凭据管理器，不写入配置文件。" : `四项都留空表示不修改（当前：${display}）；修改任一项需全部重填。`}
        指向宿主上的代理软件（如 v2rayN 的 10808）时主机填 host.docker.internal；Docker Desktop 会转发到宿主 127.0.0.1，无需开启「允许局域网连接」。
      </span>
    </div>
  );
}
