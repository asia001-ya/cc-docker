/**
 * 前后端共享类型（与 src-tauri 中 serde 结构一一对应）。
 */

/** 后端错误 */
export interface AppError {
  code: "DOCKER_UNAVAILABLE" | "DOCKER_ERROR" | "NOT_FOUND" | "INVALID" | "IO_ERROR" | "CREDENTIAL_ERROR" | "OTHER";
  message: string;
}

/** 容器挂载 */
export interface MountInfo {
  kind: string;
  source: string;
  destination: string;
  rw: boolean;
}

/** 容器基本信息 */
export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  running: boolean;
  slot: number;
  authMode: "subscription" | "api" | string;
  providerId: string | null;
  sharedGroup: string;
  /** [容器端口, 宿主端口] */
  ports: [number, number][];
  mounts: MountInfo[];
}

/** 额度窗口 */
export interface QuotaWindow {
  used_percentage: number;
  resets_at: number | null;
}

/** 模型信息 */
export interface ModelInfo {
  id: string | null;
  display_name: string | null;
}

/** quota.json */
export interface QuotaSnapshot {
  updated_at?: number | null;
  rate_limits_updated_at?: number | null;
  five_hour?: QuotaWindow | null;
  seven_day?: QuotaWindow | null;
  model?: ModelInfo | null;
  claude_version?: string | null;
}

/** 会话快照 */
export interface SessionSnapshot {
  updated_at?: number | null;
  tdc_session_id?: string | null;
  session_id?: string | null;
  /** Claude 的会话标题、摘要或首条用户消息。旧镜像可能不提供。 */
  title?: string | null;
  cwd?: string | null;
  model?: ModelInfo | null;
  context_used_percentage?: number | null;
  context_window_size?: number | null;
  effort_level?: string | null;
  thinking_enabled?: boolean | null;
  git_branch?: string | null;
}

/** 账号概要 */
export interface AccountInfo {
  logged_in: boolean;
  email: string | null;
  display_name: string | null;
  organization_type: string | null;
  rate_limit_tier: string | null;
}

/** 容器内供应商模式 */
export interface ProviderSummary {
  mode: string;
  base_url: string | null;
  model: string | null;
}

/** 端口链接 */
export interface PortLink {
  containerPort: number;
  hostPort: number | null;
  url: string | null;
  process: string | null;
  hint: string | null;
}

/** 健康状态 */
export type Health = "stopped" | "api" | "unknown" | "healthy" | "warning" | "exhausted";

/** 剩余额度 */
export interface Remaining {
  remaining: number;
  inferred: boolean;
}

/** 单容器汇总 */
export interface FleetEntry {
  container: ContainerInfo;
  health: Health;
  remaining: Remaining | null;
  quota: QuotaSnapshot | null;
  blockedUntil: number | null;
  account: AccountInfo | null;
  provider: ProviderSummary | null;
  ports: PortLink[];
  sessions: SessionSnapshot[];
  error: string | null;
  limitHit: boolean;
  /** 容器内代理实际状态（旧镜像为 null） */
  proxy: ProxyStatus | null;
}

/** 全部容器汇总 */
export interface FleetState {
  engineOk: boolean;
  engineError: string | null;
  latencyMs: number | null;
  engineVersion: string | null;
  entries: FleetEntry[];
  generatedAt: number;
}

/** 引擎信息 */
export interface EngineInfo {
  version: string;
  apiVersion: string;
  latencyMs: number;
  host: string;
}

/** 项目挂载 */
export interface ProjectMount {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

export interface ContainerEdit {
  mounts: ProjectMount[];
  cpus: number;
  memoryMb: number;
  workingDir: string;
}

export interface ContainerEditView {
  config: ContainerEdit;
  image: string;
  containerId: string;
  running: boolean;
  affectedSessions: number;
}

export interface ContainerDirectories {
  path: string;
  parent: string;
  directories: { name: string; path: string }[];
  truncated: boolean;
}

/** 端口映射 */
export interface PortMapping {
  containerPort: number;
  hostPort: number;
  label: string;
}

/** 可选的宿主 Claude 配置来源，前端只处理路径。 */
export interface GitSharing {
  enabled: boolean;
  allowedHosts: string[];
  syncIdentity: boolean;
}
export interface GitSharingView {
  config: GitSharing;
  containerId: string;
  running: boolean;
  connected: boolean;
  gitAvailable: boolean;
  helperConfigured: boolean;
  identity: { name: string | null; email: string | null };
}

export interface HostClaudeConfig {
  skills?: string | null;
  commands?: string | null;
  agents?: string | null;
  claudeMd?: string | null;
  /** 按顺序合并来源，只导出 MCP 配置；后面的同名项优先。 */
  mcpConfigs?: string[];
}

export interface HostConfigDefaults {
  config: HostClaudeConfig;
}

export interface ContainerHostConfig {
  hostConfig: HostClaudeConfig;
  running: boolean;
  containerId: string;
  affectedSessions: number;
}

export interface HostConfigApplyResult {
  containerId: string;
  backupContainer: string | null;
  snapshotImage: string | null;
  restarted: boolean;
  mcpRefreshed: boolean;
  warnings: string[];
}

/** 新建容器表单 */
export interface CreateContainerRequest {
  /** null / 缺省沿用镜像或自定义环境变量 */
  timezone?: string | null;
  locale?: string | null;
  name: string;
  image: string;
  cpus: number;
  memoryMb: number;
  authMode: "subscription" | "api";
  providerId: string | null;
  mounts: ProjectMount[];
  /** 未选择的条目继续使用容器自身配置。 */
  hostConfig?: HostClaudeConfig | null;
  sharedGroup: boolean;
  groupName: string | null;
  ports: PortMapping[];
  env: string[];
  slot: number;
  workingDir: string | null;
  /** 授予代理能力（NET_ADMIN + /dev/net/tun），创建后不可更改 */
  proxyCapable: boolean;
  /** 新建时写入的代理配置；省略或 null 表示关闭 */
  proxy?: ProxyBinding | null;
}

/** 新建容器默认值 */
export interface CreateDefaults {
  name: string;
  slot: number;
  image: string;
  imageReady: boolean;
  ports: PortMapping[];
}

/** 默认镜像状态（应用内构建） */
export interface ImageStatus {
  /** 设置中的默认镜像名 */
  image: string;
  exists: boolean;
  building: boolean;
  /** 最近的构建输出 */
  log: string[];
  /** 上次构建失败的原因 */
  error: string | null;
}

/** 预检结果 */
export interface Precheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** 会话模式 */
export type SessionMode = "claude" | "bash" | "cmd";

/** 会话元数据 */
export interface SessionRecord {
  id: string;
  container: string;
  title: string;
  cwd: string;
  mode: SessionMode;
  args: string[];
  env: string[];
  tmux: boolean;
  createdAt: number;
}

/** 打开会话请求 */
export interface OpenRequest {
  id?: string | null;
  container: string;
  title: string;
  cwd: string;
  mode: SessionMode;
  args: string[];
  env: string[];
  tmux: boolean;
  cols: number;
  rows: number;
}

/** 容器 tmux 的真实历史位置（距底部行数）。 */
export interface ScrollbackState {
  historyRows: number;
  offsetRows: number;
  viewportRows: number;
  inCopyMode: boolean;
  available: boolean;
  alternateScreen: boolean;
}

/** Claude 原始回答 / 计划快照，不包含终端控制序列或工具执行结果。 */
export interface OutputItem {
  id: string;
  kind: "plan" | "document";
  filePath: string;
  title: string;
  markdown: string;
  timestamp: string | null;
  truncated: boolean;
  revision: string;
}
export interface OutputSnapshot {
  conversationId: string | null;
  status: "ready" | "waiting" | "missing";
  revision: string | null;
  items: OutputItem[] | null;
  limited: boolean;
}

/** Channel 终端消息 */
export type TermMsg =
  | { kind: "snapshot"; data: string }
  | { kind: "data"; data: string }
  | { kind: "exit"; code: number | null };

/** 热切换候选 */
export interface Candidate {
  name: string;
  tier: number;
  remaining: number | null;
  reason: string;
}

/** 热切换结果 */
export interface SwitchResult {
  session: SessionRecord;
  resumed: string | null;
  stopMethod: string;
  notes: string[];
}

/** 耗尽事件 */
export interface ExhaustedPayload {
  container: string;
  blockedUntil: number | null;
  reason: "quota" | "limit_text";
}

/** 终端外观 */
export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  theme: string;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  webgl: boolean;
  ligatures: boolean;
  scrollback: number;
}

/** 额度设置 */
export interface QuotaSettings {
  refreshSecs: number;
  warnThreshold: number;
  criticalThreshold: number;
  switchThreshold: number;
  autoPrompt: boolean;
  allowApiFallback: boolean;
  includeStopped: boolean;
  limitPatterns: string[];
}

/** Docker 设置 */
export interface DockerSettings {
  host: string;
  defaultImage: string;
}

/** 全局设置 */
export interface WallpaperAsset {
  fileName: string;
  originalName: string;
  kind: "image" | "video";
}

export interface WallpaperSettings {
  asset: WallpaperAsset | null;
  fit: "cover" | "contain" | "fill" | "center" | "tile";
  opacity: number;
  blur: number;
  dim: number;
  terminalOpacity: number;
  panelOpacity: number;
  glassBlur: number;
}

export interface Settings {
  wallpaper: WallpaperSettings;
  terminal: TerminalSettings;
  quota: QuotaSettings;
  docker: DockerSettings;
  defaultPricing: DefaultPricing;
  sidebarShortcut: string;
}

/** API 供应商 */
export interface Pricing {
  /** USD / 百万 token */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface DefaultPricing {
  pricing: Pricing;
  modelPricing: Record<string, Pricing>;
}

export interface ProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  smallModel: string;
  tokenEnv: "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";
  extraEnv: Record<string, string>;
  pricing: Pricing;
  modelPricing: Record<string, Pricing>;
}

/** 供应商视图 */
export interface ProviderView extends ProviderProfile {
  hasToken: boolean;
}

/** 代理节点类型 */
export type ProxyNodeKind = "subscription" | "vless" | "socks5";

export type ProxyEngine = "mihomo" | "xray";

/** 代理节点（不含密钥） */
export interface ProxyNode {
  id: string;
  name: string;
  kind: ProxyNodeKind;
  /** 连接内核：作为主节点时决定整条链路的内核；旧节点默认 mihomo */
  engine: ProxyEngine;
  /** 摘要：订阅为 scheme://host，vless 为 host:port · 安全层/传输，socks5 为 host:port[ · 认证] */
  display: string;
}

/** 代理节点视图 */
export interface ProxyNodeView extends ProxyNode {
  hasSecret: boolean;
}

/** 单容器代理期望状态 */
export interface ProxyBinding {
  enabled: boolean;
  nodeId: string | null;
  staticId: string | null;
  /** 出口节点（必须是 socks5）：链路为 [静态中转 →] 节点 → 出口 → 目标 */
  exitId: string | null;
  allowLan: boolean;
  /** 仅允许私有 IPv4 地址或 CIDR 网段直连 */
  lanCidrs: string[];
  selected: string | null;
}

/** 容器代理能力 */
export interface ProxyCapability {
  imageSupported: boolean;
  granted: boolean;
  rootEntry: boolean;
  /** 镜像已内置 Xray 内核（仅 Xray 节点需要） */
  xray: boolean;
}

/** 单容器代理视图 */
export interface ProxyInfo {
  binding: ProxyBinding | null;
  capability: ProxyCapability;
  running: boolean;
}

/** 代理实际状态 */
export type ProxyState = "off" | "starting" | "ok" | "blackhole" | "leak";

/** proxy-status.json（协议 1） */
export interface ProxyStatus {
  updated_at: number;
  state: ProxyState | string;
  enabled: boolean;
  allow_lan: boolean;
  /** 旧版状态可能缺失，此时沿用默认私有网段 */
  lan_cidrs?: string[] | null;
  guard: boolean;
  tun: boolean;
  core_pid: number | null;
  engine?: ProxyEngine;
  xray_pid?: number | null;
  restarts: number;
  selected: string | null;
  providers: { name: string; count: number; updated_at: number | null }[];
  warnings: string[];
  last_error: string | null;
}

/** 容器内 apply 结果 */
export interface ProxyApplyResult {
  ok: boolean;
  stage: string;
  checks?: Record<string, boolean>;
  state?: string;
  error?: string | null;
  /** 通过当前代理链路查询到的公网出口地址 */
  exitIp?: string | null;
  exitIpError?: string | null;
}

/** 代理告警事件 */
export interface ProxyAlertPayload {
  container: string;
  state: string;
  lastError: string | null;
}

/** 共享组设置请求 */
export interface SharedGroupRequest {
  group: string;
  members: string[];
  remove: string[];
}

/** 用量统计：时间戳均为 Unix 秒，筛选区间为 [from, to)。 */
export type UsageAuthType = "api" | "authorization" | "unknown";
export type UsageGranularity = "day" | "hour";

export interface UsageQuery {
  granularity?: UsageGranularity;
  from?: number;
  to?: number;
  container?: string;
  authType?: UsageAuthType;
  providerId?: string;
  model?: string;
  page?: number;
  pageSize?: number;
  utcOffsetMinutes?: number;
}

export interface UsageMetrics {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  /** 加权缓存命中率，0–1。 */
  cacheHitRate: number;
}

export interface UsageCollectionContainer {
  container: string;
  status: "active" | "stopped" | "unsupported" | "error";
  lastCollectedAt: number | null;
  error: string | null;
  captureReady?: boolean;
}

export interface UsageLog {
  id: string;
  timestamp: number;
  container: string;
  sessionId: string;
  authType: UsageAuthType;
  providerId: string | null;
  providerName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number | null;
  speed: number | null;
  pricing: Pricing;
  /** 首次采集时冻结的阶梯规则；旧记录不含此字段。 */
  pricingTier?: { inputTokensThreshold: number; pricing: Pricing };
  attribution: "captured" | "historical";
  attributionSource?: "" | "local-history" | "unverified" | "ambiguous";
}

export interface UsageContainerSummary {
  container: string;
  metrics: UsageMetrics;
  collection: UsageCollectionContainer;
}

export interface UsageTrendPoint {
  date: string;
  metrics: UsageMetrics;
}

export interface UsageResult {
  generatedAt: number;
  totals: UsageMetrics;
  containers: UsageContainerSummary[];
  trend: UsageTrendPoint[];
  logs: UsageLog[];
  totalLogs: number;
  page: number;
  pageSize: number;
  providers: { id: string; name: string }[];
  models: string[];
  collection: {
    lastCollectedAt: number | null;
    containers: UsageCollectionContainer[];
    warnings: string[];
  };
}
