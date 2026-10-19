//! 容器创建规格：把前端表单（新建容器弹框）转换为 Docker API 的 ContainerCreateBody。
//! 纯函数，便于单测；与 docker/docker-compose.yml 的卷 / 标签约定保持一致。

use std::collections::HashMap;
use std::sync::OnceLock;

use bollard::models::{
    ContainerCreateBody, ContainerInspectResponse, DeviceMapping, HostConfig, Mount, MountBindOptions, MountType,
    PortBinding, RestartPolicy, RestartPolicyNameEnum,
};
use regex::Regex;
use serde::{Deserialize, Serialize};

use super::host_config::{HostClaudeConfig, HOST_CONFIG_ROOT, HOST_MCP_TARGET};
use crate::error::{AppError, AppResult};

/// 镜像内 Claude 配置目录（CLAUDE_CONFIG_DIR）。
pub const CLAUDE_DIR: &str = "/home/node/.claude";
/// 共享会话卷挂载点。
pub const PROJECTS_DIR: &str = "/home/node/.claude/projects";
/// 共享记忆卷挂载点。
pub const SHARED_DIR: &str = "/home/node/.claude-shared";
/// 容器内状态目录。
pub const STATE_DIR: &str = "/home/node/.claude/tdc/state";
/// provider-settings 文件路径。
pub const PROVIDER_FILE: &str = "/home/node/.claude/tdc/provider-settings.json";
/// 交互进程的运行用户（镜像入口以 root 运行，所有 docker exec 必须显式降权到该用户）。
pub const APP_USER: &str = "node";
/// 代理配置目录（容器层，root 0700）。
pub const PROXY_DIR: &str = "/var/lib/tdc/proxy";
/// mihomo 配置文件。
pub const PROXY_CONFIG: &str = "/var/lib/tdc/proxy/config.yaml";
/// 代理期望状态文件。
pub const PROXY_INTENT: &str = "/var/lib/tdc/proxy/intent.json";
/// TUN 设备在宿主上的路径。
pub const TUN_DEVICE_PATH: &str = "/dev/net/tun";

/// 标签：由 tdc 管理。
pub const LABEL_MANAGED: &str = "tdc.managed";
/// 标签：槽位号。
pub const LABEL_SLOT: &str = "tdc.slot";
/// 标签：授权模式。
pub const LABEL_AUTH: &str = "tdc.auth_mode";
/// 标签：API 供应商 ID。
pub const LABEL_PROVIDER: &str = "tdc.provider_id";
/// 标签：共享组。
pub const LABEL_GROUP: &str = "tdc.shared_group";
/// 镜像标签：镜像支持容器内代理（mihomo + root 入口）。
pub const LABEL_PROXY_IMAGE: &str = "tdc.proxy";
/// 镜像标签：镜像已内置 Xray 内核（运行时不下载）。
pub const LABEL_XRAY_IMAGE: &str = "tdc.xray";
pub const LABEL_LOCALES_IMAGE: &str = "tdc.locales";
pub const LABEL_HOST_CONFIG_IMAGE: &str = "tdc.host_config";
pub const LABEL_HOST_CONFIG_SOURCES: &str = "tdc.host_config.sources";

/// 项目挂载项。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMount {
    /// 宿主路径（Windows 路径或 \\wsl$ 路径）
    pub host_path: String,
    /// 容器内路径（/workspace/<名>）
    pub container_path: String,
    /// 只读
    #[serde(default)]
    pub read_only: bool,
}

/// 端口映射项。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortMapping {
    /// 容器端口
    pub container_port: u16,
    /// 宿主端口
    pub host_port: u16,
    /// 描述
    #[serde(default)]
    pub label: String,
}

/// 新建容器表单。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateContainerRequest {
    /// None / 缺省沿用镜像或 env，兼容旧表单与重建。
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub locale: Option<String>,
    /// 容器名（[a-z0-9_-]）
    pub name: String,
    /// 镜像
    pub image: String,
    /// CPU 核数（0 表示不限制）
    #[serde(default)]
    pub cpus: f64,
    /// 内存上限 MB（0 表示不限制）
    #[serde(default)]
    pub memory_mb: u64,
    /// 授权模式：subscription / api
    pub auth_mode: String,
    /// API 模式下的供应商 ID
    #[serde(default)]
    pub provider_id: Option<String>,
    /// 项目挂载
    #[serde(default)]
    pub mounts: Vec<ProjectMount>,
    /// 加入共享会话组（挂载共享 projects 卷与共享记忆卷）
    #[serde(default = "default_true")]
    pub shared_group: bool,
    /// 共享组名称（决定共享卷名 tdc_shared_projects[_<组>]）
    #[serde(default)]
    pub group_name: Option<String>,
    /// 端口映射
    #[serde(default)]
    pub ports: Vec<PortMapping>,
    /// 额外环境变量 K=V
    #[serde(default)]
    pub env: Vec<String>,
    /// 槽位号
    #[serde(default)]
    pub slot: u16,
    /// 默认工作目录
    #[serde(default)]
    pub working_dir: Option<String>,
    /// 授予代理所需能力（NET_ADMIN + /dev/net/tun + 关闭 IPv6），创建后不可更改
    #[serde(default = "default_true")]
    pub proxy_capable: bool,
    /// 新建时应用的代理绑定；旧请求省略时保持关闭。
    #[serde(default)]
    pub proxy: Option<crate::proxy::ProxyBinding>,
    /// 可选宿主 Claude 资源；缺省/空配置保持容器自身配置。
    #[serde(default)]
    pub host_config: Option<HostClaudeConfig>,
    /// 后端准备的 MCP 导出目录，禁止前端注入未过滤的原始配置。
    #[serde(skip)]
    pub host_mcp_dir: Option<String>,
}

/// 宿主资源使用专用只读挂载，缺失源由 Docker 拒绝，不自动创建目录。
pub fn host_config_mounts(config: &HostClaudeConfig, mcp_dir: Option<&str>) -> AppResult<Vec<Mount>> {
    let mut sources = vec![
        (config.skills.as_deref(), format!("{HOST_CONFIG_ROOT}/skills")),
        (config.commands.as_deref(), format!("{HOST_CONFIG_ROOT}/commands")),
        (config.agents.as_deref(), format!("{HOST_CONFIG_ROOT}/agents")),
        (config.claude_md.as_deref(), format!("{HOST_CONFIG_ROOT}/CLAUDE.md")),
    ];
    if !config.mcp_configs.is_empty() {
        let exported = mcp_dir
            .filter(|path| !path.trim().is_empty())
            .ok_or_else(|| AppError::Invalid("MCP 配置尚未安全导出，请重新预检后提交".into()))?;
        sources.push((Some(exported), HOST_MCP_TARGET.to_string()));
    }
    Ok(sources
        .into_iter()
        .filter_map(|(source, target)| {
            source.filter(|s| !s.is_empty()).map(|source| Mount {
                target: Some(target),
                source: Some(normalize_host_path(source)),
                typ: Some(MountType::BIND),
                read_only: Some(true),
                bind_options: Some(MountBindOptions { create_mountpoint: Some(false), ..Default::default() }),
                ..Default::default()
            })
        })
        .collect())
}

/// serde 默认值 true。参数：无；返回：true。
fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
struct RegionChoice {
    value: String,
    #[serde(default)]
    language: String,
}

#[derive(Deserialize)]
struct RegionOptions {
    timezones: Vec<RegionChoice>,
    locales: Vec<RegionChoice>,
}

fn region_options() -> &'static RegionOptions {
    static OPTIONS: OnceLock<RegionOptions> = OnceLock::new();
    OPTIONS.get_or_init(|| {
        serde_json::from_str(include_str!("../../../docker/rootfs/opt/tdc/region-options.json")).expect("内置区域选项")
    })
}

/// 显式选择与手写 env 不可同时覆盖同一个键，避免表单显示和实际运行不一致。
pub fn validate_region(req: &CreateContainerRequest) -> AppResult<()> {
    let timezone = req.timezone.as_deref().filter(|v| !v.is_empty());
    let locale = req.locale.as_deref().filter(|v| !v.is_empty());
    if timezone.is_some_and(|v| !region_options().timezones.iter().any(|o| o.value == v)) {
        return Err(AppError::Invalid("请选择有效的容器时区".into()));
    }
    if locale.is_some_and(|v| !region_options().locales.iter().any(|o| o.value == v)) {
        return Err(AppError::Invalid("请选择有效的系统语言".into()));
    }
    for entry in &req.env {
        let Some((key, _)) = entry.split_once('=') else { continue };
        if (timezone.is_some() && key == "TZ") || (locale.is_some() && matches!(key, "LANG" | "LC_ALL" | "LANGUAGE")) {
            return Err(AppError::Invalid(format!(
                "{key} 与时区或语言设置重复，请删除该变量，或将对应选项改为“沿用镜像”"
            )));
        }
    }
    Ok(())
}

/// 校验容器名。
/// 参数：name——容器名；返回：合法时 Ok，否则中文错误。
pub fn validate_name(name: &str) -> AppResult<()> {
    let re = Regex::new(r"^[a-z0-9][a-z0-9_-]{1,62}$").expect("静态正则");
    if re.is_match(name) {
        Ok(())
    } else {
        Err(AppError::Invalid("容器名需为 2~63 位小写字母、数字、- 或 _，且以字母或数字开头".into()))
    }
}

/// 每容器独立 home 卷名。参数：name——容器名；返回：卷名。
pub fn home_volume(name: &str) -> String {
    format!("tdc_home_{name}")
}

/// 共享 projects 卷名。参数：group——组名（None 或 default 为默认组）；返回：卷名。
pub fn shared_projects_volume(group: Option<&str>) -> String {
    match group.filter(|g| !g.is_empty() && *g != "default") {
        Some(g) => format!("tdc_shared_projects_{g}"),
        None => "tdc_shared_projects".into(),
    }
}

/// 共享记忆卷名。参数：group——组名；返回：卷名。
pub fn shared_memory_volume(group: Option<&str>) -> String {
    match group.filter(|g| !g.is_empty() && *g != "default") {
        Some(g) => format!("tdc_shared_memory_{g}"),
        None => "tdc_shared_memory".into(),
    }
}

/// 把 Windows 路径规整为 Docker Desktop 可识别的 bind 源（反斜杠转正斜杠，保留盘符）。
/// 参数：p——宿主路径；返回：规整后的路径。
pub fn normalize_host_path(p: &str) -> String {
    p.trim().replace('\\', "/")
}

/// 判断宿主路径是否位于 Windows 盘符（I/O 慢、inotify 不可靠）。
/// 参数：p——宿主路径；返回：是 Windows 盘符路径返回 true。
pub fn is_windows_drive_path(p: &str) -> bool {
    let b = p.trim().as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// Docker 会规整重复斜杠和点目录；校验使用相同目标，避免覆盖运行脚本。
fn normalized_container_path(path: &str) -> String {
    format!("/{}", path.split('/').filter(|part| !part.is_empty() && *part != ".").collect::<Vec<_>>().join("/"))
}

pub(crate) fn host_config_runtime_overlap(target: &str) -> bool {
    if target.is_empty() {
        return false;
    }
    let target = normalized_container_path(target);
    let protected = [
        "/opt/tdc/entrypoint.sh",
        "/opt/tdc/entrypoint-user.sh",
        "/opt/tdc/tdc-claude.sh",
        "/opt/tdc/tdc-ctl.sh",
        "/opt/tdc/tdc-session.sh",
        "/opt/tdc/tdc-session-history.mjs",
        "/opt/tdc/tdc-host-config.mjs",
        "/opt/tdc/statusline.mjs",
        "/opt/tdc/statusline-display.mjs",
        "/opt/tdc/tdc-quota.mjs",
        "/usr/local/bin/claude",
        "/usr/local/bin/tdc-claude-real",
        "/var/lib/tdc/host-config",
    ];
    target == "/"
        || protected.iter().any(|path| {
            target == *path || path.starts_with(&format!("{target}/")) || target.starts_with(&format!("{path}/"))
        })
}

/// 生成 ContainerCreateBody。
/// 参数：req——表单；返回：创建体或校验错误。
pub fn build_create_body(req: &CreateContainerRequest) -> AppResult<ContainerCreateBody> {
    validate_name(&req.name)?;
    validate_region(req)?;
    if req.image.trim().is_empty() {
        return Err(AppError::Invalid("镜像不能为空".into()));
    }
    for m in &req.mounts {
        if !m.container_path.starts_with('/') || m.container_path.contains("..") {
            return Err(AppError::Invalid(format!("容器内路径必须为绝对路径：{}", m.container_path)));
        }
        let target = normalized_container_path(&m.container_path);
        if target == HOST_CONFIG_ROOT || target.starts_with(&format!("{HOST_CONFIG_ROOT}/")) {
            return Err(AppError::Invalid("宿主 Claude 配置目录由专用选项管理，不能作为项目挂载目标".into()));
        }
        if req.host_config.as_ref().is_some_and(|config| !config.is_empty()) && host_config_runtime_overlap(&target) {
            return Err(AppError::Invalid("项目挂载覆盖了宿主配置运行脚本或 Claude 入口目录，请更换容器内路径".into()));
        }
    }
    let group = req.group_name.as_deref();

    let mut binds = vec![format!("{}:{}", home_volume(&req.name), CLAUDE_DIR)];
    if req.shared_group {
        binds.push(format!("{}:{}", shared_projects_volume(group), PROJECTS_DIR));
        binds.push(format!("{}:{}", shared_memory_volume(group), SHARED_DIR));
    }
    for m in &req.mounts {
        let mode = if m.read_only { ":ro" } else { "" };
        binds.push(format!("{}:{}{}", normalize_host_path(&m.host_path), m.container_path, mode));
    }

    let mut port_bindings: HashMap<String, Option<Vec<PortBinding>>> = HashMap::new();
    let mut exposed: Vec<String> = Vec::new();
    for p in &req.ports {
        let key = format!("{}/tcp", p.container_port);
        exposed.push(key.clone());
        port_bindings.insert(
            key,
            Some(vec![PortBinding { host_ip: Some("127.0.0.1".into()), host_port: Some(p.host_port.to_string()) }]),
        );
    }

    let mut labels = HashMap::from([
        (LABEL_MANAGED.to_string(), "true".to_string()),
        (LABEL_SLOT.to_string(), format!("{:02}", req.slot)),
        (LABEL_AUTH.to_string(), req.auth_mode.clone()),
        (
            LABEL_GROUP.to_string(),
            if req.shared_group { group.unwrap_or("default").to_string() } else { String::new() },
        ),
    ]);
    if let Some(pid) = &req.provider_id {
        labels.insert(LABEL_PROVIDER.to_string(), pid.clone());
    }
    let host_mounts = if let Some(config) = req.host_config.as_ref().filter(|config| !config.is_empty()) {
        labels.insert(LABEL_HOST_CONFIG_SOURCES.to_string(), serde_json::to_string(config)?);
        host_config_mounts(config, req.host_mcp_dir.as_deref())?
    } else {
        Vec::new()
    };

    let mut env = vec![
        "TERM=xterm-256color".to_string(),
        "COLORTERM=truecolor".to_string(),
        format!("TDC_CONTAINER_NAME={}", req.name),
        format!("TDC_SLOT={:02}", req.slot),
    ];
    env.extend(req.env.iter().filter(|kv| kv.contains('=')).cloned());
    if let Some(tz) = req.timezone.as_deref().filter(|v| !v.is_empty()) {
        env.push(format!("TZ={tz}"));
    }
    if let Some(locale) = req.locale.as_deref().filter(|v| !v.is_empty()) {
        let choice = region_options().locales.iter().find(|o| o.value == locale).expect("已校验语言");
        // LC_ALL 的优先级高于 LANG；同时覆盖镜像默认值及 gettext 的 LANGUAGE。
        env.extend([format!("LANG={locale}"), format!("LC_ALL={locale}"), format!("LANGUAGE={}", choice.language)]);
    }

    let working_dir = req
        .working_dir
        .clone()
        .or_else(|| req.mounts.first().map(|m| m.container_path.clone()))
        .unwrap_or_else(|| "/workspace".into());

    Ok(ContainerCreateBody {
        image: Some(req.image.clone()),
        hostname: Some(req.name.clone()),
        env: Some(env),
        labels: Some(labels),
        working_dir: Some(working_dir),
        exposed_ports: if exposed.is_empty() { None } else { Some(exposed) },
        host_config: Some(HostConfig {
            binds: Some(binds),
            mounts: (!host_mounts.is_empty()).then_some(host_mounts),
            port_bindings: if port_bindings.is_empty() { None } else { Some(port_bindings) },
            nano_cpus: (req.cpus > 0.0).then_some((req.cpus * 1e9) as i64),
            memory: (req.memory_mb > 0).then_some((req.memory_mb as i64) * 1024 * 1024),
            restart_policy: Some(RestartPolicy {
                name: Some(RestartPolicyNameEnum::UNLESS_STOPPED),
                maximum_retry_count: None,
            }),
            // 代理能力：TUN 需要 NET_ADMIN 与 /dev/net/tun；关闭 IPv6，TUN 只配 IPv4（与 compose 保持一致）
            cap_add: req.proxy_capable.then(|| vec!["NET_ADMIN".to_string()]),
            devices: req.proxy_capable.then(|| {
                vec![DeviceMapping {
                    path_on_host: Some(TUN_DEVICE_PATH.into()),
                    path_in_container: Some(TUN_DEVICE_PATH.into()),
                    cgroup_permissions: Some("rwm".into()),
                }]
            }),
            sysctls: req.proxy_capable.then(|| {
                HashMap::from([
                    ("net.ipv6.conf.all.disable_ipv6".to_string(), "1".to_string()),
                    ("net.ipv6.conf.default.disable_ipv6".to_string(), "1".to_string()),
                ])
            }),
            ..Default::default()
        }),
        ..Default::default()
    })
}

/// 容器的代理能力。
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyCapability {
    /// 镜像支持代理（带 tdc.proxy 标签）
    pub image_supported: bool,
    /// 容器创建时已授予 NET_ADMIN 与 /dev/net/tun
    pub granted: bool,
    /// 入口以 root 运行（容器未被指定为非 root 用户）
    pub root_entry: bool,
    /// 镜像已内置 Xray 内核（带 tdc.xray 标签）；不影响 ready，仅 Xray 节点需要
    pub xray: bool,
}

impl ProxyCapability {
    /// 三项都满足才能开启代理。参数：无；返回：是否可用。
    pub fn ready(&self) -> bool {
        self.image_supported && self.granted && self.root_entry
    }
}

/// 从 inspect 结果判断代理能力。参数：ins——inspect 结果；返回：能力。
pub fn proxy_capability(ins: &ContainerInspectResponse) -> ProxyCapability {
    let cfg = ins.config.as_ref();
    let hc = ins.host_config.as_ref();
    let label = |key: &str| cfg.and_then(|c| c.labels.as_ref()).and_then(|l| l.get(key)).is_some_and(|v| v == "1");
    let image_supported = label(LABEL_PROXY_IMAGE);
    let xray = label(LABEL_XRAY_IMAGE);
    let cap = hc.and_then(|h| h.cap_add.as_ref()).is_some_and(|caps| {
        caps.iter().any(|c| c.eq_ignore_ascii_case("NET_ADMIN") || c.eq_ignore_ascii_case("CAP_NET_ADMIN"))
    });
    let dev = hc
        .and_then(|h| h.devices.as_ref())
        .is_some_and(|ds| ds.iter().any(|d| d.path_in_container.as_deref() == Some(TUN_DEVICE_PATH)));
    let root_entry = matches!(cfg.and_then(|c| c.user.as_deref()), None | Some("" | "root" | "0"));
    ProxyCapability { image_supported, granted: cap && dev, root_entry, xray }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造基础表单。参数：无；返回：表单。
    fn base() -> CreateContainerRequest {
        CreateContainerRequest {
            timezone: None,
            locale: None,
            name: "claude-dev-05".into(),
            image: "tdc/claude-dev:latest".into(),
            cpus: 4.0,
            memory_mb: 8192,
            auth_mode: "subscription".into(),
            provider_id: None,
            mounts: vec![ProjectMount {
                host_path: r"D:\Projects\app".into(),
                container_path: "/workspace/app".into(),
                read_only: false,
            }],
            shared_group: true,
            group_name: None,
            ports: vec![PortMapping { container_port: 3000, host_port: 3050, label: "Web".into() }],
            env: vec!["FOO=1".into(), "坏变量".into()],
            slot: 5,
            working_dir: None,
            proxy_capable: true,
            proxy: None,
            host_config: None,
            host_mcp_dir: None,
        }
    }

    #[test]
    fn 区域设置覆盖镜像的高优先级语言变量() {
        let mut req = base();
        req.timezone = Some("Asia/Tokyo".into());
        req.locale = Some("zh_CN.UTF-8".into());
        let env = build_create_body(&req).unwrap().env.unwrap();
        for value in ["TZ=Asia/Tokyo", "LANG=zh_CN.UTF-8", "LC_ALL=zh_CN.UTF-8", "LANGUAGE=zh_CN:zh"] {
            assert!(env.contains(&value.to_string()), "missing {value}");
        }
        req.locale = Some("C.UTF-8".into());
        assert!(build_create_body(&req).unwrap().env.unwrap().contains(&"LANGUAGE=".to_string()));
    }

    #[test]
    fn 区域设置校验与旧请求兼容() {
        let mut req: CreateContainerRequest = serde_json::from_value(serde_json::json!({
            "name":"region-qa", "image":"tdc/claude-dev:latest", "authMode":"subscription",
            "env":["TZ=Etc/GMT+5", "LANG=de_DE.UTF-8"]
        }))
        .unwrap();
        assert!(req.timezone.is_none() && req.locale.is_none());
        let env = build_create_body(&req).unwrap().env.unwrap();
        assert!(env.contains(&"TZ=Etc/GMT+5".to_string()));
        assert!(!env.iter().any(|e| e.starts_with("LC_ALL=")));
        req.timezone = Some("Asia/Shanghai".into());
        assert!(validate_region(&req).unwrap_err().to_string().contains("TZ"));
        req.env.clear();
        req.timezone = Some("../../etc/passwd".into());
        assert!(validate_region(&req).is_err());
        req.timezone = None;
        req.locale = Some("invalid".into());
        assert!(validate_region(&req).is_err());
        req.locale = Some("en_US.UTF-8".into());
        for key in ["LANG", "LC_ALL", "LANGUAGE"] {
            req.env = vec![format!("{key}=conflict")];
            assert!(validate_region(&req).unwrap_err().to_string().contains(key));
        }
    }

    #[test]
    fn 生成卷端口标签与资源限制() {
        let body = build_create_body(&base()).unwrap();
        let hc = body.host_config.unwrap();
        let binds = hc.binds.unwrap();
        assert_eq!(binds[0], "tdc_home_claude-dev-05:/home/node/.claude");
        assert_eq!(binds[1], "tdc_shared_projects:/home/node/.claude/projects");
        assert_eq!(binds[3], "D:/Projects/app:/workspace/app");
        let pb = hc.port_bindings.unwrap();
        let b = pb["3000/tcp"].as_ref().unwrap();
        assert_eq!(b[0].host_ip.as_deref(), Some("127.0.0.1"));
        assert_eq!(b[0].host_port.as_deref(), Some("3050"));
        assert_eq!(hc.nano_cpus, Some(4_000_000_000));
        assert_eq!(hc.memory, Some(8 * 1024 * 1024 * 1024));
        let labels = body.labels.unwrap();
        assert_eq!(labels["tdc.managed"], "true");
        assert_eq!(labels["tdc.slot"], "05");
        let env = body.env.unwrap();
        assert!(env.contains(&"COLORTERM=truecolor".to_string()));
        assert!(env.contains(&"FOO=1".to_string()));
        assert!(!env.iter().any(|e| e == "坏变量"));
        assert_eq!(body.working_dir.as_deref(), Some("/workspace/app"));
    }

    #[test]
    fn 代理能力_默认授予且可关闭() {
        let hc = build_create_body(&base()).unwrap().host_config.unwrap();
        assert_eq!(hc.cap_add, Some(vec!["NET_ADMIN".to_string()]));
        let dev = &hc.devices.as_ref().unwrap()[0];
        assert_eq!(dev.path_on_host.as_deref(), Some("/dev/net/tun"));
        assert_eq!(dev.cgroup_permissions.as_deref(), Some("rwm"));
        assert_eq!(hc.sysctls.as_ref().unwrap()["net.ipv6.conf.all.disable_ipv6"], "1");
        assert!(hc.security_opt.is_none(), "不得设置 no-new-privileges 等安全选项");

        let mut r = base();
        r.proxy_capable = false;
        let hc = build_create_body(&r).unwrap().host_config.unwrap();
        assert!(hc.cap_add.is_none() && hc.devices.is_none() && hc.sysctls.is_none());
    }

    #[test]
    fn 从_inspect_判断代理能力() {
        let body = build_create_body(&base()).unwrap();
        let mut labels = body.labels.clone().unwrap();
        labels.insert(LABEL_PROXY_IMAGE.into(), "1".into());
        let ins = ContainerInspectResponse {
            config: Some(bollard::models::ContainerConfig {
                labels: Some(labels),
                user: Some(String::new()),
                ..Default::default()
            }),
            host_config: body.host_config.clone(),
            ..Default::default()
        };
        assert!(proxy_capability(&ins).ready());

        let old_image = ContainerInspectResponse {
            config: Some(bollard::models::ContainerConfig { user: Some("node".into()), ..Default::default() }),
            host_config: body.host_config,
            ..Default::default()
        };
        let cap = proxy_capability(&old_image);
        assert!(!cap.image_supported && !cap.root_entry && cap.granted);
        assert!(!proxy_capability(&ContainerInspectResponse::default()).ready());
    }

    #[test]
    fn 校验名称与路径() {
        assert!(validate_name("claude-dev-01").is_ok());
        assert!(validate_name("Claude").is_err());
        assert!(validate_name("-x").is_err());
        let mut r = base();
        r.mounts[0].container_path = "workspace".into();
        assert!(build_create_body(&r).is_err());
    }

    #[test]
    fn 自定义共享组与不加入共享() {
        let mut r = base();
        r.group_name = Some("team-a".into());
        let binds = build_create_body(&r).unwrap().host_config.unwrap().binds.unwrap();
        assert!(binds.contains(&"tdc_shared_projects_team-a:/home/node/.claude/projects".to_string()));
        r.shared_group = false;
        let binds = build_create_body(&r).unwrap().host_config.unwrap().binds.unwrap();
        assert_eq!(binds.len(), 2);
        assert!(is_windows_drive_path(r"D:\x"));
        assert!(!is_windows_drive_path(r"\\wsl$\Ubuntu\home"));
    }

    #[test]
    fn 宿主配置缺省空值和空对象保留原生创建行为() {
        let original =
            serde_json::json!({"name":"native-host", "image":"tdc/claude-dev:latest", "authMode":"subscription"});
        let baseline = build_create_body(&serde_json::from_value(original.clone()).unwrap()).unwrap();
        for value in [
            serde_json::Value::Null,
            serde_json::json!({}),
            serde_json::json!({"skills":"  ", "commands":null, "mcpConfigs":[]}),
        ] {
            let mut input = original.clone();
            input["hostConfig"] = value;
            let req: CreateContainerRequest = serde_json::from_value(input).unwrap();
            assert_eq!(build_create_body(&req).unwrap(), baseline);
        }
        assert!(baseline.host_config.unwrap().mounts.is_none());
        assert!(!baseline.labels.unwrap().contains_key(LABEL_HOST_CONFIG_SOURCES));
    }

    #[test]
    fn 宿主资源固定只读挂载且_mcp_仅挂载后端导出目录() {
        let mut req = base();
        req.host_config = Some(HostClaudeConfig {
            skills: Some(r"C:\Users\test\.claude\skills".into()),
            commands: Some(r"C:\Users\test\.claude\commands".into()),
            agents: Some(r"C:\Users\test\.claude\agents".into()),
            claude_md: Some(r"C:\Users\test\.claude\CLAUDE.md".into()),
            mcp_configs: vec![r"C:\Users\test\.claude.json".into()],
        });
        req.host_mcp_dir = Some(r"C:\AppData\tdc\host-config\safe-generation".into());
        let body = build_create_body(&req).unwrap();
        let mounts = body.host_config.unwrap().mounts.unwrap();
        assert_eq!(mounts.len(), 5);
        for (mount, name) in mounts.iter().zip(["skills", "commands", "agents", "CLAUDE.md", "mcp"]) {
            assert_eq!(mount.target.as_deref(), Some(format!("{HOST_CONFIG_ROOT}/{name}").as_str()));
            assert_eq!(mount.typ, Some(MountType::BIND));
            assert_eq!(mount.read_only, Some(true));
            assert_eq!(mount.bind_options.as_ref().unwrap().create_mountpoint, Some(false));
            assert!(!mount.source.as_ref().unwrap().contains('\\'));
            assert!(!mount.source.as_ref().unwrap().ends_with(".claude.json"));
        }
        assert_eq!(mounts[4].source.as_deref(), Some("C:/AppData/tdc/host-config/safe-generation"));
        let metadata: HostClaudeConfig =
            serde_json::from_str(&body.labels.unwrap()[LABEL_HOST_CONFIG_SOURCES]).unwrap();
        assert_eq!(metadata, req.host_config.unwrap());
    }

    #[test]
    fn 调用者不能注入后端导出路径且未导出_mcp_不可创建() {
        let req: CreateContainerRequest = serde_json::from_value(serde_json::json!({
            "name":"raw-mcp", "image":"tdc/claude-dev:latest", "authMode":"subscription",
            "hostConfig":{"mcpConfigs":["C:/Users/test/.claude.json"]}, "hostMcpDir":"C:/Users/test"
        }))
        .unwrap();
        assert!(req.host_mcp_dir.is_none());
        assert!(!serde_json::to_value(&req).unwrap().as_object().unwrap().contains_key("hostMcpDir"));
        assert!(build_create_body(&req).unwrap_err().to_string().contains("尚未安全导出"));
        assert!(host_config_mounts(req.host_config.as_ref().unwrap(), Some("  ")).is_err());
    }

    #[test]
    fn 宿主资源启用时拒绝覆盖运行脚本与入口目录() {
        let mut req = base();
        req.host_config = Some(HostClaudeConfig { skills: Some("C:/skills".into()), ..Default::default() });
        for target in [
            "/",
            "/opt",
            "/opt/tdc",
            "/opt//./tdc/",
            "/opt/tdc/entrypoint.sh",
            "/usr/local/bin",
            "/usr/local/bin/claude",
            "/var/lib/tdc",
            "/var/lib/tdc/host-config/mcp.json",
            "/opt/tdc/host-config/skills",
            "/opt//tdc/./host-config",
        ] {
            req.mounts[0].container_path = target.into();
            assert!(build_create_body(&req).is_err(), "must reject {target}");
        }
        for target in ["/workspace/project", "/opt/data", "/usr/local/share"] {
            req.mounts[0].container_path = target.into();
            assert!(build_create_body(&req).is_ok(), "must allow {target}");
        }
        req.host_config = None;
        req.mounts[0].container_path = "/opt/tdc".into();
        assert!(build_create_body(&req).is_ok(), "native containers retain existing behavior");
    }
}
