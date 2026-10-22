/**
 * Tauri 命令与事件封装。终端高频输出走 Channel，不经事件总线。
 * 在纯浏览器（npm run dev，无 Tauri 后端）中运行时，isTauri() 为 false，调用方据此进入演示模式。
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AccountInfo,
  Candidate,
  ContainerInfo,
  ContainerEdit,
  ContainerEditView,
  ContainerDirectories,
  CreateContainerRequest,
  CreateDefaults,
  EngineInfo,
  ExhaustedPayload,
  FleetEntry,
  FleetState,
  HostClaudeConfig,
  HostConfigDefaults,
  ContainerHostConfig,
  HostConfigApplyResult,
  ImageStatus,
  MemoryReclaimResult,
  MemoryReclaimStatus,
  OpenRequest,
  OutputSnapshot,
  Precheck,
  ProviderProfile,
  ProviderView,
  ProxyAlertPayload,
  ProxyApplyResult,
  ProxyBinding,
  ProxyInfo,
  ProxyNode,
  ProxyNodeView,
  QuotaSnapshot,
  SessionRecord,
  Settings,
  WallpaperAsset,
  SharedGroupRequest,
  SwitchResult,
  TermMsg,
  ScrollbackState,
  UsageQuery,
  UsageResult,
} from "./types";

/**
 * 是否运行在 Tauri WebView 中。
 * @returns 有 Tauri 内部对象时为 true
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// ---- 引擎与容器 ----
export const wallpaperImport = (path: string, kind: WallpaperAsset["kind"]) => invoke<WallpaperAsset>("wallpaper_import", { path, kind });
export const wallpaperResolve = (fileName: string) => invoke<string>("wallpaper_resolve", { fileName });
export const wallpaperDelete = (fileName: string) => invoke<void>("wallpaper_delete", { fileName });

export const engineInfo = () => invoke<EngineInfo>("engine_info");
export const memoryReclaimStatus = () => invoke<MemoryReclaimStatus>("memory_reclaim_status");
export const memoryReclaim = () => invoke<MemoryReclaimResult>("memory_reclaim");
export const memoryCompact = () => invoke<MemoryReclaimResult>("memory_compact");
export const fleetGet = () => invoke<FleetState>("fleet_get");
export const fleetRefresh = () => invoke<void>("fleet_refresh");
export const containerQuotaRefresh = (name: string) => invoke<FleetEntry>("container_quota_refresh", { name });
export const containerEditGet = (name: string) => invoke<ContainerEditView>("container_edit_get", { name });
export const containerEditPrecheck = (name: string, config: ContainerEdit) => invoke<Precheck>("container_edit_precheck", { name, config });
export const containerEditApply = (name: string, config: ContainerEdit, expectedContainerId: string) =>
  invoke<HostConfigApplyResult>("container_edit_apply", { name, config, expectedContainerId });
export const containerDirectories = (name: string, path: string) => invoke<ContainerDirectories>("container_directories", { name, path });
export const containerList = (includeUnmanaged: boolean) => invoke<ContainerInfo[]>("container_list", { includeUnmanaged });
export const containerWorkingDir = (name: string) => invoke<string>("container_working_dir", { name });
export const containerDefaults = () => invoke<CreateDefaults>("container_defaults");
export const containerPrecheck = (req: CreateContainerRequest) => invoke<Precheck>("container_precheck", { req });
export const containerCreate = (req: CreateContainerRequest, start: boolean) =>
  invoke<string>("container_create", { req, start });
export const containerAction = (name: string, action: "start" | "stop" | "restart" | "kill") =>
  invoke<void>("container_action", { name, action });
export const containerRemove = (name: string, confirmName: string, removeHome: boolean) =>
  invoke<void>("container_remove", { name, confirmName, removeHome });
export const containerAccount = (name: string) => invoke<AccountInfo>("container_account", { name });
export const containerSetProvider = (name: string, providerId: string | null) =>
  invoke<void>("container_set_provider", { name, providerId });
export const containerImportCredentials = (name: string, path: string) =>
  invoke<void>("container_import_credentials", { name, path });
export const sharedGroupApply = (req: SharedGroupRequest) => invoke<string[]>("shared_group_apply", { req });
export const hostConfigDefaults = () => invoke<HostConfigDefaults>("host_config_defaults");
export const containerHostConfigGet = (name: string) => invoke<ContainerHostConfig>("container_host_config_get", { name });
export const containerHostConfigPrecheck = (name: string, hostConfig: HostClaudeConfig) =>
  invoke<Precheck>("container_host_config_precheck", { name, hostConfig });
export const containerHostConfigApply = (name: string, hostConfig: HostClaudeConfig, expectedContainerId: string) =>
  invoke<HostConfigApplyResult>("container_host_config_apply", { name, hostConfig, expectedContainerId });

export const containerGitGet = (name: string) => invoke<import("./types").GitSharingView>("container_git_get", { name });
export const containerGitApply = (name: string, expectedContainerId: string, config: import("./types").GitSharing) =>
  invoke<import("./types").GitSharingView>("container_git_apply", { name, expectedContainerId, config });

// ---- 终端 ----
export const termOpen = (req: OpenRequest) => invoke<SessionRecord>("term_open", { req });
export const termWrite = (id: string, data: string) => invoke<void>("term_write", { id, data });
/** 粘贴图片：原始字节作请求体，返回容器内文件路径 */
export const termPasteImage = (id: string, mime: string, bytes: Uint8Array) =>
  invoke<string>("term_paste_image", bytes, { headers: { "x-session-id": id, "x-mime": mime } });
export const termResize = (id: string, cols: number, rows: number) => invoke<void>("term_resize", { id, cols, rows });
/** 不传 offsetRows 时只查询；0 返回实时输出，正数进入 tmux 历史。 */
export const termScrollback = (id: string, offsetRows?: number) => invoke<ScrollbackState>("term_scrollback", { id, offsetRows });
export const termDetach = (id: string) => invoke<void>("term_detach", { id });
export const termClose = (id: string) => invoke<void>("term_close", { id });
export const termRename = (id: string, title: string) => invoke<SessionRecord>("term_rename", { id, title });
export const termRecords = () => invoke<SessionRecord[]>("term_records");
export const termOutputs = (id: string, revision?: string | null) => invoke<OutputSnapshot>("term_outputs", { id, revision });

/**
 * 附着终端输出。后端先发 snapshot（回放）再发 data，同一 Channel 内有序。
 * @param id 会话 ID
 * @param onMsg 消息回调
 * @returns Promise，附着失败时 reject
 */
export function termAttach(id: string, onMsg: (m: TermMsg) => void): Promise<void> {
  const channel = new Channel<TermMsg>();
  channel.onmessage = onMsg;
  return invoke<void>("term_attach", { id, channel });
}

// ---- 热切换 ----
export const switchCandidates = (source: string) => invoke<Candidate[]>("switch_candidates", { source });
export const switchExecute = (sessionId: string, target: string, cols: number, rows: number) =>
  invoke<SwitchResult>("switch_execute", { req: { sessionId, target, cols, rows } });
export const debugInjectQuota = (container: string, quota: QuotaSnapshot | null) =>
  invoke<void>("debug_inject_quota", { container, quota });

// ---- 设置与供应商 ----
export const settingsGet = () => invoke<Settings>("settings_get");
export const settingsSet = (settings: Settings) => invoke<void>("settings_set", { settings });
export const dockerTest = (host: string) => invoke<EngineInfo>("docker_test", { host });
export const providerList = () => invoke<ProviderView[]>("provider_list");
export const providerSave = (profile: ProviderProfile, token: string | null) =>
  invoke<ProviderProfile>("provider_save", { profile, token });
export const providerDelete = (id: string) => invoke<void>("provider_delete", { id });

// ---- 用量统计 ----
export const usageQuery = (query: UsageQuery) => invoke<UsageResult>("usage_query", { query });
export const usageRefresh = () => invoke<void>("usage_refresh");
export const usageEnable = (container: string) => invoke<void>("usage_enable", { container });

// ---- 代理 ----
export const proxyNodeList = () => invoke<ProxyNodeView[]>("proxy_node_list");
export const proxyNodeSave = (node: ProxyNode, secret: string | null) => invoke<ProxyNode>("proxy_node_save", { node, secret });
export const proxyNodeDelete = (id: string) => invoke<void>("proxy_node_delete", { id });
export const proxyGet = (container: string) => invoke<ProxyInfo>("proxy_get", { container });
export const proxyApply = (container: string, binding: ProxyBinding) => invoke<ProxyApplyResult>("proxy_apply", { container, binding });
export const proxyPreflight = (image: string, binding: ProxyBinding) => invoke<ProxyApplyResult>("proxy_preflight", { image, binding });
export const proxyOff = (container: string) => invoke<ProxyApplyResult>("proxy_off", { container });
export const proxyNodes = (container: string) => invoke<{ now: string | null; all: string[] }>("proxy_nodes", { container });
export const proxySelect = (container: string, name: string) => invoke<{ now: string }>("proxy_select", { container, name });
export const proxyDelay = (container: string) => invoke<{ delays: Record<string, number> }>("proxy_delay", { container });
export const proxyRefresh = (container: string) => invoke<{ refreshed: string[] }>("proxy_refresh", { container });
export const proxyCapabilityApply = (container: string) => invoke<void>("proxy_capability_apply", { container });

// ---- 标准镜像 ----
export const imageStatus = () => invoke<ImageStatus>("image_status");
export const imageBuild = () => invoke<void>("image_build");

/**
 * 订阅镜像构建输出（逐行）。
 * @param cb 回调
 * @returns 取消订阅函数
 */
export const onImageBuildLine = (cb: (line: string) => void): Promise<UnlistenFn> =>
  listen<{ line: string }>("image://build-line", (e) => cb(e.payload.line));

/**
 * 订阅镜像构建结束。
 * @param cb 回调
 * @returns 取消订阅函数
 */
export const onImageBuildDone = (cb: (p: { ok: boolean; error: string | null }) => void): Promise<UnlistenFn> =>
  listen<{ ok: boolean; error: string | null }>("image://build-done", (e) => cb(e.payload));

// ---- 事件 ----
/**
 * 订阅容器汇总更新。
 * @param cb 回调
 * @returns 取消订阅函数
 */
export const onFleet = (cb: (f: FleetState) => void): Promise<UnlistenFn> =>
  listen<FleetState>("fleet://update", (e) => cb(e.payload));

/**
 * 订阅额度耗尽事件。
 * @param cb 回调
 * @returns 取消订阅函数
 */
export const onExhausted = (cb: (p: ExhaustedPayload) => void): Promise<UnlistenFn> =>
  listen<ExhaustedPayload>("quota://exhausted", (e) => cb(e.payload));

/**
 * 订阅代理告警（进入断网 / 泄露状态）。
 * @param cb 回调
 * @returns 取消订阅函数
 */
export const onProxyAlert = (cb: (p: ProxyAlertPayload) => void): Promise<UnlistenFn> =>
  listen<ProxyAlertPayload>("proxy://alert", (e) => cb(e.payload));

/**
 * 订阅会话退出事件。
 * @param cb 回调
 * @returns 取消订阅函数
 */
export const onSessionExit = (cb: (p: { sessionId: string; container: string; code: number | null }) => void): Promise<UnlistenFn> =>
  listen<{ sessionId: string; container: string; code: number | null }>("term://exit", (e) => cb(e.payload));

/**
 * 把未知错误转为中文文本。
 * @param e 任意错误
 * @returns 可展示的错误信息
 */
export function errorText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
