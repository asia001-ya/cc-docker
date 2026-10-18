//! 额度数据模型：与容器内 statusline.mjs / tdc-ctl snapshot 输出的协议 1 对应。

use serde::{Deserialize, Serialize};

/// 单个额度窗口（5 小时 / 7 天）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuotaWindow {
    /// 已用百分比 0~100
    pub used_percentage: f64,
    /// 重置时间（epoch 秒）
    #[serde(default)]
    pub resets_at: Option<i64>,
}

/// 模型信息。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ModelInfo {
    /// 模型 ID
    #[serde(default)]
    pub id: Option<String>,
    /// 显示名
    #[serde(default)]
    pub display_name: Option<String>,
}

/// quota.json 内容。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct QuotaSnapshot {
    /// 最后一次 statusline 刷新时间
    #[serde(default)]
    pub updated_at: Option<i64>,
    /// 最后一次拿到 rate_limits 的时间
    #[serde(default)]
    pub rate_limits_updated_at: Option<i64>,
    /// 5 小时窗口
    #[serde(default)]
    pub five_hour: Option<QuotaWindow>,
    /// 7 天窗口
    #[serde(default)]
    pub seven_day: Option<QuotaWindow>,
    /// 模型
    #[serde(default)]
    pub model: Option<ModelInfo>,
    /// Claude Code 版本
    #[serde(default)]
    pub claude_version: Option<String>,
}

/// 端口监听项（ports.json）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ListenPort {
    /// 容器内端口
    pub port: u16,
    /// 绑定地址
    #[serde(default)]
    pub binds: Vec<String>,
    /// 是否仅绑定环回地址（宿主机无法通过端口映射访问）
    #[serde(default)]
    pub loopback_only: bool,
    /// 进程名
    #[serde(default)]
    pub process: Option<String>,
}

/// ports.json 内容。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct PortsFile {
    /// 刷新时间
    #[serde(default)]
    pub updated_at: Option<i64>,
    /// 监听端口
    #[serde(default)]
    pub ports: Vec<ListenPort>,
}

/// 会话快照（sessions/<id>.json）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct SessionSnapshot {
    /// 刷新时间
    #[serde(default)]
    pub updated_at: Option<i64>,
    /// tdc 会话 ID
    #[serde(default)]
    pub tdc_session_id: Option<String>,
    /// Claude 会话 ID（--resume 用）
    #[serde(default)]
    pub session_id: Option<String>,
    /// Claude 历史中的可读标题，旧镜像或空会话可能没有。
    #[serde(default)]
    pub title: Option<String>,
    /// 当前目录
    #[serde(default)]
    pub cwd: Option<String>,
    /// 模型
    #[serde(default)]
    pub model: Option<ModelInfo>,
    /// 上下文占用百分比
    #[serde(default)]
    pub context_used_percentage: Option<f64>,
    #[serde(default)]
    pub context_window_size: Option<u64>,
    #[serde(default)]
    pub effort_level: Option<String>,
    #[serde(default)]
    pub thinking_enabled: Option<bool>,
    #[serde(default)]
    pub git_branch: Option<String>,
}

/// 账号概要（不含令牌）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct AccountInfo {
    /// 是否已登录
    #[serde(default)]
    pub logged_in: bool,
    /// 邮箱
    #[serde(default)]
    pub email: Option<String>,
    /// 显示名
    #[serde(default)]
    pub display_name: Option<String>,
    /// 组织类型（claude_max / claude_pro ...）
    #[serde(default)]
    pub organization_type: Option<String>,
    /// 限额档位
    #[serde(default)]
    pub rate_limit_tier: Option<String>,
}

/// 容器内 provider-settings 的概要。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ProviderSummary {
    /// subscription / api
    #[serde(default)]
    pub mode: String,
    /// API Base URL
    #[serde(default)]
    pub base_url: Option<String>,
    /// 模型覆盖
    #[serde(default)]
    pub model: Option<String>,
}

/// tmux 会话项。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct TmuxSession {
    /// 会话 ID（去掉 tdc- 前缀）
    pub id: String,
    /// 创建时间
    #[serde(default)]
    pub created_at: i64,
    /// 已附着客户端数
    #[serde(default)]
    pub attached: i64,
    /// 当前目录
    #[serde(default)]
    pub cwd: String,
    /// 前台命令
    #[serde(default)]
    pub command: String,
}

/// 代理订阅 provider 摘要。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ProxyProviderInfo {
    /// provider 名
    #[serde(default)]
    pub name: String,
    /// 已拉取的节点数
    #[serde(default)]
    pub count: i64,
    /// 最近一次拉取时间（epoch 秒）
    #[serde(default)]
    pub updated_at: Option<i64>,
}

/// 容器内代理实际状态（/var/lib/tdc/proxy-status.json，协议 1）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ProxyStatus {
    /// 写入时间
    #[serde(default)]
    pub updated_at: i64,
    /// off / starting / ok / blackhole / leak
    #[serde(default)]
    pub state: String,
    /// intent 是否启用
    #[serde(default)]
    pub enabled: bool,
    /// 是否放行宿主与局域网
    #[serde(default)]
    pub allow_lan: bool,
    /// 兜底规则是否完整
    #[serde(default)]
    pub guard: bool,
    /// TUN 设备是否存在
    #[serde(default)]
    pub tun: bool,
    /// 内核 PID
    #[serde(default)]
    pub core_pid: Option<i64>,
    /// 节点连接内核（旧状态文件默认 mihomo）。
    #[serde(default)]
    pub engine: crate::proxy::ProxyEngine,
    /// Xray 运行进程；mihomo 模式为空。
    #[serde(default)]
    pub xray_pid: Option<i64>,
    /// 守护自动重启内核的次数
    #[serde(default)]
    pub restarts: i64,
    /// 当前选中的节点
    #[serde(default)]
    pub selected: Option<String>,
    /// 订阅摘要
    #[serde(default)]
    pub providers: Vec<ProxyProviderInfo>,
    /// 非致命提示（订阅为空、期望节点不可用）
    #[serde(default)]
    pub warnings: Vec<String>,
    /// 最近一次错误
    #[serde(default)]
    pub last_error: Option<String>,
}

impl ProxyStatus {
    /// 是否处于需要告警的状态（已断网或可能泄露）。参数：无；返回：是否告警。
    pub fn alarming(&self) -> bool {
        self.state == "blackhole" || self.state == "leak"
    }
}

/// `tdc-ctl snapshot` 的完整输出。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ContainerSnapshot {
    /// 容器内当前时间
    #[serde(default)]
    pub now: i64,
    /// 额度
    #[serde(default)]
    pub quota: Option<QuotaSnapshot>,
    /// 端口
    #[serde(default)]
    pub ports: Option<PortsFile>,
    /// 供应商模式
    #[serde(default)]
    pub provider: Option<ProviderSummary>,
    /// 账号
    #[serde(default)]
    pub account: Option<AccountInfo>,
    /// 会话快照
    #[serde(default)]
    pub sessions: Vec<SessionSnapshot>,
    /// tmux 会话
    #[serde(default)]
    pub tmux: Vec<TmuxSession>,
    /// 代理状态（旧镜像没有该字段）
    #[serde(default)]
    pub proxy: Option<ProxyStatus>,
}

/// 容器健康状态（决定状态灯颜色）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Health {
    /// 未运行（灰）
    Stopped,
    /// API 模式（蓝，无订阅额度概念）
    Api,
    /// 运行中但无额度数据（灰）
    Unknown,
    /// 额度充足（绿）
    Healthy,
    /// 额度预警（黄）
    Warning,
    /// 额度耗尽 / 检测到限额（红）
    Exhausted,
}
