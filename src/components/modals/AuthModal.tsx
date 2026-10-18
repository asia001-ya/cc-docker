/**
 * 弹框 2：Claude 账号授权绑定。
 * 显示当前账号；方式 A 在容器终端内登录；方式 B 导入 .credentials.json；方式 C 切换为 API 供应商（CC Switch 风格）。
 */
import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AccountInfo, ProviderView } from "../../api/types";
import { containerAccount, containerImportCredentials, containerSetProvider, errorText, isTauri, providerList } from "../../api/commands";
import { useUiStore } from "../../store/uiStore";
import { useEntry } from "../../store/fleetStore";
import { DEMO_PROVIDERS } from "../../lib/demo";
import { Modal } from "../ui/Modal";
import { Button, Callout, CardRadio, Icon, Kbd } from "../ui/controls";

interface Props {
  container: string;
  /** 在该容器中新开会话并执行命令（用于登录） */
  onRunInTerminal: (container: string, title: string, mode: "claude" | "bash", args: string[]) => void;
}

/**
 * 授权弹框。
 * @param props 容器名与"在终端中执行"回调
 * @returns JSX
 */
export function AuthModal({ container, onRunInTerminal }: Props) {
  const close = useUiStore((s) => s.closeModal);
  const toast = useUiStore((s) => s.toast);
  const openModal = useUiStore((s) => s.openModal);
  const entry = useEntry(container);
  const [account, setAccount] = useState<AccountInfo | null>(entry?.account ?? null);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const currentMode = entry?.provider?.mode === "api" ? "api" : "subscription";
  const [method, setMethod] = useState<"login" | "import" | "api">(currentMode === "api" ? "api" : "login");
  const [providerId, setProviderId] = useState<string | null>(entry?.container.providerId ?? null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isTauri()) {
      setProviders(DEMO_PROVIDERS);
      return;
    }
    containerAccount(container).then(setAccount).catch(() => undefined);
    providerList().then(setProviders).catch(() => undefined);
  }, [container]);

  /**
   * 执行所选方式。
   * @returns Promise
   */
  const apply = async () => {
    if (!isTauri()) {
      toast("info", "演示模式：未连接后端");
      return close();
    }
    setBusy(true);
    try {
      if (method === "login") {
        // 订阅模式：先确保 provider-settings 为空 env，再开终端运行 claude（未登录时 Claude Code 会进入登录流程）
        if (currentMode === "api") await containerSetProvider(container, null);
        onRunInTerminal(container, "账号登录", "claude", []);
        toast("info", "已在新会话中启动 claude：选择登录方式后，按住 Ctrl 点击终端中的链接在浏览器授权，再把授权码粘贴回终端（Ctrl+Shift+V）");
        close();
      } else if (method === "import") {
        const path = await openDialog({ title: "选择 Claude Code 凭证文件（.credentials.json）", filters: [{ name: "JSON", extensions: ["json"] }] });
        if (typeof path !== "string") return;
        await containerImportCredentials(container, path);
        if (currentMode === "api") await containerSetProvider(container, null);
        toast("success", "凭证已导入，新开的 claude 会话即使用该账号");
        close();
      } else {
        if (!providerId) return toast("warning", "请选择供应商");
        await containerSetProvider(container, providerId);
        toast("success", "已切换为 API 供应商模式；已打开的 claude 会话需重启后生效");
        close();
      }
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Claude 账号授权 · ${container}`}
      icon="key"
      width={720}
      onClose={close}
      onSubmit={() => void apply()}
      footerLeft={<span className="font-ui text-label-md text-on-surface-variant">更改授权后，已运行的 claude 会话需要重启才会生效</span>}
      footer={
        <>
          <Button onClick={close}>取消</Button>
          <Button variant="primary" icon={method === "api" ? "swap_horiz" : method === "import" ? "upload_file" : "login"} kbd="Ctrl+Enter" disabled={busy} onClick={() => void apply()}>
            {method === "login" ? "在终端中登录" : method === "import" ? "选择凭证文件…" : "切换到该供应商"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
          <span className={`flex h-10 w-10 items-center justify-center rounded-full ${account?.logged_in ? "bg-st-ok/15 text-st-ok" : "bg-white/[0.06] text-outline"}`}>
            <Icon name={currentMode === "api" ? "api" : account?.logged_in ? "verified_user" : "person_off"} size={22} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="font-ui text-headline-sm text-on-surface">
              {currentMode === "api" ? `API 模式 · ${entry?.provider?.base_url ?? "官方 API"}` : account?.logged_in ? (account.email ?? "已登录（未读取到邮箱）") : "尚未登录"}
            </span>
            <span className="font-ui text-body-sm text-on-surface-variant">
              {currentMode === "api"
                ? `模型：${entry?.provider?.model ?? "默认"}`
                : account?.organization_type
                  ? `套餐：${account.organization_type.replace("claude_", "Claude ").replace(/_/g, " ")}${account.rate_limit_tier ? ` · ${account.rate_limit_tier}` : ""}`
                  : "凭证保存在容器独立卷 tdc_home_" + container}
            </span>
          </div>
        </div>

        <CardRadio
          columns={3}
          value={method}
          onChange={setMethod}
          options={[
            { value: "login", icon: "open_in_browser", title: "终端内登录", desc: "新开会话运行 claude，按提示在浏览器授权并粘贴授权码" },
            { value: "import", icon: "upload_file", title: "导入凭证文件", desc: "从其它机器复制 ~/.claude/.credentials.json" },
            { value: "api", icon: "api", title: "API 供应商", desc: "Base URL + Token，按量计费（CC Switch 风格）" },
          ]}
        />

        {method === "login" && (
          <Callout tone="info">
            容器内没有浏览器：claude 会输出授权链接，按住 <Kbd>Ctrl</Kbd> 点击即可用系统浏览器打开；授权后把页面上的代码粘贴回终端（<Kbd>Ctrl+Shift+V</Kbd>）。
          </Callout>
        )}
        {method === "import" && (
          <Callout tone="warning">
            同一个账号导入到多个容器会<strong>共用同一份额度</strong>，热切换对它们无意义。凭证以 600 权限写入容器卷，不会出现在命令行参数中。
          </Callout>
        )}
        {method === "api" && (
          <div className="flex flex-col gap-1.5">
            {providers.length === 0 && <Callout tone="info">还没有供应商。</Callout>}
            {providers.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setProviderId(p.id)}
                className={`flex items-center justify-between rounded-lg border p-2.5 text-left ${providerId === p.id ? "border-accent/60 bg-accent/[0.10]" : "border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.06]"}`}
              >
                <span className="flex flex-col">
                  <span className="font-ui text-headline-sm text-on-surface">{p.name}</span>
                  <span className="font-mono text-code-sm text-on-surface-variant">
                    {p.baseUrl || "https://api.anthropic.com（官方）"} · {p.model || "默认模型"} · {p.tokenEnv}
                  </span>
                </span>
                <span className={`font-ui text-label-sm ${p.hasToken ? "text-st-ok" : "text-st-warn"}`}>{p.hasToken ? "Token 已保存" : "未保存 Token"}</span>
              </button>
            ))}
            <Button variant="subtle" icon="add" className="self-start" onClick={() => openModal({ kind: "settings", tab: "providers" })}>
              管理供应商…
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
