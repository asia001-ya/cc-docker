/** Synthetic IPC fixture: no Docker access, credentials, or real container mutations. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SessionModal } from "../src/components/modals/SessionModal";
import { EditContainerModal } from "../src/components/modals/EditContainerModal";
import { SettingsModal } from "../src/components/modals/SettingsModal";
import { UsageModal } from "../src/components/modals/UsageModal";
import { ProxyModal } from "../src/components/modals/ProxyModal";
import { QuotaFlyout } from "../src/components/shell/QuotaFlyout";
import { SidebarDrawer } from "../src/components/shell/SidebarDrawer";
import { useUiStore } from "../src/store/uiStore";
import { useFleetStore } from "../src/store/fleetStore";
import { DEFAULT_SETTINGS } from "../src/lib/demo";
import { queryUsageDemo } from "../src/lib/usageDemo";
import { EMPTY_PROXY_BINDING } from "../src/lib/proxyBinding";
import { normalizeLanCidrs } from "../src/lib/proxyLan";
import type { ContainerEdit, FleetEntry, ProxyBinding, Settings } from "../src/api/types";
import "../src/styles.css";
import "material-symbols/outlined.css";

const now = Math.floor(Date.now() / 1000);
const entry: FleetEntry = {
  container: { id: "fixture-id", name: "fixture", image: "tdc/claude-dev:fixture", state: "running", status: "Up", running: true,
    slot: 1, authMode: "subscription", providerId: null, sharedGroup: "default", ports: [], mounts: [
      { kind: "bind", source: "D:/fixture", destination: "/workspace/app", rw: true },
    ] },
  health: "warning", remaining: { remaining: 25, inferred: false }, blockedUntil: null,
  quota: { five_hour: { used_percentage: 75, resets_at: now + 3600 }, seven_day: { used_percentage: 40, resets_at: now + 86400 }, rate_limits_updated_at: now },
  account: null, provider: { mode: "subscription", base_url: null, model: null }, ports: [], sessions: [], error: null, limitHit: false, proxy: null,
};
let config: ContainerEdit = { mounts: [{ hostPath: "D:/fixture", containerPath: "/workspace/app", readOnly: false }], cpus: 4, memoryMb: 8192, workingDir: "/workspace/app" };
let settings = structuredClone(DEFAULT_SETTINGS);
let proxyBinding = { ...structuredClone(EMPTY_PROXY_BINDING), enabled: true, nodeId: "fixture-node" };
const calls: { command: string; args: Record<string, unknown> }[] = [];
Object.assign(window, {
  fixtureCalls: calls,
  __TAURI_INTERNALS__: {
    invoke: async (command: string, args: Record<string, unknown> = {}) => {
      calls.push({ command, args });
      switch (command) {
        case "container_list": return [entry.container];
        case "container_directories": {
          const path = String(args.path);
          return { path, parent: path.slice(0, path.lastIndexOf("/")) || "/", truncated: false,
            directories: path.endsWith("/子目录") ? [] : [{ name: "子目录", path: path.replace(/\/$/, "") + "/子目录" }] };
        }
        case "container_edit_get": return { config, containerId: "fixture-id", running: true, affectedSessions: 2, image: entry.container.image };
        case "container_edit_precheck": return { ok: true, errors: [], warnings: [] };
        case "container_edit_apply":
          config = args.config as ContainerEdit;
          return { containerId: "fixture-new", restarted: true, warnings: [], snapshotImage: "fixture:backup", backupContainer: null, mcpRefreshed: false };
        case "container_quota_refresh":
          await new Promise((resolve) => setTimeout(resolve, 600));
          if ((window as unknown as { quotaFailure?: boolean }).quotaFailure) throw new Error("测试网络不可用");
          return { ...entry, health: "healthy", remaining: { remaining: 80, inferred: false }, limitHit: false, blockedUntil: null,
            quota: { five_hour: { used_percentage: 10, resets_at: now + 3600 }, seven_day: { used_percentage: 20, resets_at: now + 86400 }, rate_limits_updated_at: now + 1 } };
        case "settings_set": settings = args.settings as Settings; return;
        case "settings_get": return settings;
        case "provider_list": return [];
        case "proxy_get": return { binding: proxyBinding, capability: { imageSupported: true, granted: true, rootEntry: true, xray: true }, running: true };
        case "proxy_node_list": return [{ id: "fixture-node", name: "测试节点", kind: "socks5", engine: "mihomo", display: "example.test:1080", hasSecret: true }];
        case "proxy_apply": {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const draft = args.binding as ProxyBinding;
          proxyBinding = { ...draft, nodeId: draft.nodeId!, lanCidrs: normalizeLanCidrs(draft.lanCidrs) };
          const fleet = useFleetStore.getState().fleet!;
          useFleetStore.setState({ fleet: { ...fleet, entries: fleet.entries.map((item) => ({ ...item, proxy: {
            updated_at: now, state: "ok", enabled: true, allow_lan: draft.allowLan, lan_cidrs: proxyBinding.lanCidrs,
            guard: true, tun: true, core_pid: 1, engine: "mihomo", restarts: 0, selected: "测试节点", providers: [], warnings: [], last_error: null,
          } })) } });
          return { ok: true, stage: "done", checks: { core: true, guard: true, proxied: true }, state: "ok", exitIp: "203.0.113.10" };
        }
        case "usage_query": return queryUsageDemo(args.query as Parameters<typeof queryUsageDemo>[0]);
        case "usage_refresh": return;
        case "plugin:dialog|open": return "D:/selected-fixture";
        default: throw new Error("Unexpected fixture command: " + command);
      }
    },
  },
});
useFleetStore.setState({ fleet: { engineOk: true, engineError: null, engineVersion: "fixture", latencyMs: 1, generatedAt: now, entries: [entry] } });
useUiStore.setState({ sidebarOpen: true, sidebarPinned: true });

function Fixture() {
  const [failedQuota, setFailedQuota] = useState(false);
  const [recorded, setRecorded] = useState("");
  const modal = useUiStore((state) => state.modal);
  const open = useUiStore((state) => state.openModal);
  const close = useUiStore((state) => state.closeModal);
  return <main className="flex h-screen bg-surface text-on-surface">
    <SidebarDrawer onOpenIn={() => open({ kind: "session", mode: "new", container: "fixture" })} onSmartSwitch={() => undefined} />
    <div className="min-w-0 flex-1 p-6">
      <div className="space-x-4">
      <button onClick={() => open({ kind: "session", mode: "new", container: "fixture" })}>新建会话</button>
      <button onClick={() => open({ kind: "editContainer", container: "fixture" })}>编辑容器</button>
      <button onClick={() => open({ kind: "settings", tab: "pricing" })}>默认定价</button>
      <button onClick={() => open({ kind: "usage" })}>使用趋势</button>
      <button onClick={() => open({ kind: "proxy", container: "fixture" })}>容器代理</button>
      <button onClick={() => useUiStore.getState().setQuotaFlyout(true)}>额度总览</button>
      </div>
      <div className="mt-6 space-x-4 text-sm">
        <label><input type="checkbox" checked={failedQuota} onChange={(event) => {
          setFailedQuota(event.target.checked);
          Object.assign(window, { quotaFailure: event.target.checked });
        }} />模拟额度刷新失败</label>
        <button onClick={() => setRecorded(JSON.stringify(calls.slice(-8), null, 2))}>显示最近调用</button>
      </div>
      <pre className="mt-4 max-h-[65vh] overflow-auto text-xs" aria-label="测试调用记录">{recorded}</pre>
    </div>
    <QuotaFlyout onSwitch={() => undefined} />
    {modal?.kind === "session" && <SessionModal mode="new" container="fixture" onCreate={async (spec) => {
      calls.push({ command: "fixture_session_submit", args: { spec } }); close();
    }} />}
    {modal?.kind === "editContainer" && <EditContainerModal container="fixture" />}
    {modal?.kind === "settings" && <SettingsModal tab="pricing" />}
    {modal?.kind === "usage" && <UsageModal onClose={close} />}
    {modal?.kind === "proxy" && <ProxyModal container="fixture" />}
  </main>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
import.meta.hot?.dispose(() => root.unmount());
