//! 宿主配置预检与显式重建：原容器只在候选准备完成后停止，失败恢复原容器。
use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use bollard::models::{
    ContainerCreateBody, ContainerInspectResponse, EndpointSettings, HealthConfig, HostConfig, Mount, MountType,
    NetworkingConfig,
};
use bollard::query_parameters::{CommitContainerOptions, RenameContainerOptions};
use serde::Serialize;
use tauri::State;

use super::container_cmds::{recreate_request, Precheck};
use crate::docker::client::DockerClient;
use crate::docker::host_config::{self, HostClaudeConfig, HostConfigPrepared, HOST_CONFIG_ROOT};
use crate::docker::spec::{self, CreateContainerRequest};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Serialize)]
pub struct HostConfigDefaults {
    pub config: HostClaudeConfig,
}

#[tauri::command]
pub fn host_config_defaults() -> HostConfigDefaults {
    HostConfigDefaults { config: host_config::defaults() }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConfigView {
    pub host_config: HostClaudeConfig,
    pub running: bool,
    pub container_id: String,
    pub affected_sessions: usize,
}

#[tauri::command]
pub async fn container_host_config_get(state: State<'_, AppState>, name: String) -> AppResult<HostConfigView> {
    let inspect = state.docker()?.inspect(&name).await?;
    let request = recreate_request(&name, &inspect)?;
    Ok(HostConfigView {
        host_config: request.host_config.unwrap_or_default(),
        running: inspect.state.and_then(|s| s.running).unwrap_or(false),
        container_id: inspect.id.unwrap_or_default(),
        affected_sessions: state.sessions.list().iter().filter(|s| s.record.container == name && s.alive).count(),
    })
}

pub(crate) fn require_local(docker: &DockerClient) -> AppResult<()> {
    if docker.accepts_local_paths() {
        Ok(())
    } else {
        Err(AppError::Invalid("宿主 Claude 配置仅支持本机 Docker；远端引擎不能挂载本机配置路径".into()))
    }
}

/// 只读检查，不创建导出目录；新建始终要求镜像明确声明支持。
pub(crate) async fn check_new_host_config(
    docker: &DockerClient,
    req: &CreateContainerRequest,
) -> AppResult<Option<HostConfigPrepared>> {
    let Some(config) = req.host_config.as_ref().filter(|config| !config.is_empty()) else { return Ok(None) };
    require_local(docker)?;
    let prepared = host_config::validate(config)?;
    if !docker.image_supports_host_config(&req.image).await {
        return Err(AppError::Invalid("镜像不支持宿主 Claude 配置，请先构建最新版标准镜像".into()));
    }
    let mut check = req.clone();
    check.host_config = Some(prepared.config.clone());
    check.host_mcp_dir = Some("/precheck-only".into());
    spec::build_create_body(&check)?;
    Ok(Some(prepared))
}

/// 只在提交阶段生成独立 MCP 世代，预检不会改动当前挂载。
pub(crate) async fn prepare_new_host_config(
    docker: &DockerClient,
    req: &mut CreateContainerRequest,
    root: &Path,
) -> AppResult<()> {
    if let Some(prepared) = check_new_host_config(docker, req).await? {
        req.host_mcp_dir = prepared.persist_mcp(root)?.map(|path| path.to_string_lossy().into_owned());
        req.host_config = Some(prepared.config);
    }
    Ok(())
}

fn labels(inspect: &ContainerInspectResponse) -> HashMap<String, String> {
    inspect.config.as_ref().and_then(|config| config.labels.clone()).unwrap_or_default()
}

/// 旧版标准镜像可只在候选容器中更新脚本；自定义入口不做猜测性改写。
pub(super) fn validate_rebuild_shape(inspect: &ContainerInspectResponse) -> AppResult<bool> {
    let cfg = inspect.config.as_ref().ok_or_else(|| AppError::Invalid("容器缺少创建配置".into()))?;
    let labels = labels(inspect);
    let standard = labels.get("tdc.image").is_some_and(|value| value == "claude-dev")
        && labels.get("tdc.protocol").is_some_and(|value| value == "1");
    let expected = ["/usr/bin/tini", "--", "/opt/tdc/entrypoint.sh"];
    let entrypoint_ok = cfg.entrypoint.as_ref().is_some_and(|value| value.iter().map(String::as_str).eq(expected));
    let root = matches!(cfg.user.as_deref(), None | Some("" | "root" | "0"));
    if !standard || !entrypoint_ok || !root {
        return Err(AppError::Invalid(
            "仅支持标准 tdc 镜像的 root/tini 入口；自定义容器请基于最新版标准镜像新建".into(),
        ));
    }
    if inspect.host_config.as_ref().is_some_and(|host| host.readonly_rootfs == Some(true)) {
        return Err(AppError::Invalid("容器根文件系统只读，无法安全安装宿主配置支持脚本".into()));
    }
    for mount in inspect.mounts.as_deref().unwrap_or_default() {
        let target = mount.destination.as_deref().unwrap_or("");
        if spec::host_config_runtime_overlap(target) {
            return Err(AppError::Invalid("容器挂载覆盖了运行时脚本或 Claude 入口目录，无法安全重建".into()));
        }
    }
    if cfg
        .env
        .as_ref()
        .is_some_and(|env| env.iter().any(|entry| entry.starts_with("TDC_APP_USER=") && entry != "TDC_APP_USER=node"))
    {
        return Err(AppError::Invalid("自定义 TDC_APP_USER 与标准宿主配置权限不兼容".into()));
    }
    if inspect
        .network_settings
        .as_ref()
        .and_then(|network| network.networks.as_ref())
        .is_some_and(|networks| networks.len() > 1 || networks.values().any(|endpoint| endpoint.ipam_config.is_some()))
    {
        return Err(AppError::Invalid("多网络或固定 IP 容器暂不支持自动重建，请保留原容器并手工迁移".into()));
    }
    Ok(!labels.get(spec::LABEL_HOST_CONFIG_IMAGE).is_some_and(|value| value == "1"))
}

/// 将 inspect 中未出现在 HostConfig 的匿名卷也固定到原卷名，避免重建分配新空卷。
pub(super) fn complete_host_config(inspect: &ContainerInspectResponse) -> AppResult<HostConfig> {
    let mut host = inspect.host_config.clone().unwrap_or_default();
    let mut represented: std::collections::HashSet<String> = host
        .binds
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter_map(|bind| {
            super::container_cmds::split_bind(bind).map(|(_, tail)| tail.split(':').next().unwrap_or("").to_string())
        })
        .collect();
    represented.extend(host.mounts.as_deref().unwrap_or_default().iter().filter_map(|mount| mount.target.clone()));
    represented.extend(host.tmpfs.as_ref().into_iter().flat_map(|values| values.keys().cloned()));
    for mount in inspect.mounts.as_deref().unwrap_or_default() {
        let Some(target) = mount.destination.as_ref() else { continue };
        if represented.contains(target) {
            continue;
        }
        let (kind, source) = match mount.typ.as_deref() {
            Some("volume") => (MountType::VOLUME, mount.name.clone()),
            Some("bind") => (MountType::BIND, mount.source.clone()),
            Some("tmpfs") => continue,
            _ => return Err(AppError::Invalid("容器包含无法完整还原的挂载类型，未进行重建".into())),
        };
        let source = source
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::Invalid("容器挂载缺少原始来源，未进行重建".into()))?;
        host.mounts.get_or_insert_with(Vec::new).push(Mount {
            target: Some(target.clone()),
            source: Some(source),
            typ: Some(kind),
            read_only: Some(mount.rw == Some(false)),
            ..Default::default()
        });
        represented.insert(target.clone());
    }
    Ok(host)
}

fn inspect_precheck(inspect: &ContainerInspectResponse, prepared: &HostConfigPrepared) -> AppResult<Vec<String>> {
    let upgrade = validate_rebuild_shape(inspect)?;
    let mut warnings = prepared.warnings.clone();
    if upgrade {
        warnings.push("将仅在候选容器中更新标准宿主配置脚本，原容器保留到验证成功".into());
    }
    if inspect.state.as_ref().and_then(|state| state.running).unwrap_or(false) {
        warnings.push("应用并重建会结束该容器的终端、tmux 和后台进程；凭证、历史及容器文件保留".into());
    }
    Ok(warnings)
}

#[tauri::command]
pub async fn container_host_config_precheck(
    state: State<'_, AppState>,
    name: String,
    host_config: HostClaudeConfig,
) -> AppResult<Precheck> {
    let docker = state.docker()?;
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let checked: AppResult<()> = async {
        require_local(&docker)?;
        let inspect = docker.inspect(&name).await?;
        let prepared = host_config::validate(&host_config)?;
        let mut req = recreate_request(&name, &inspect)?;
        warnings = inspect_precheck(&inspect, &prepared)?;
        if req.host_config.clone().unwrap_or_default().normalized() == prepared.config
            && !prepared.config.mcp_configs.is_empty()
        {
            warnings.retain(|warning| !warning.starts_with("应用并重建会结束"));
            warnings.push("重新导入 MCP 不重建容器；新配置在下次启动 Claude 时生效，当前终端保持运行".into());
        }
        req.host_config = Some(prepared.config);
        req.host_mcp_dir = Some("/precheck-only".into());
        spec::build_create_body(&req)?;
        Ok(())
    }
    .await;
    if let Err(error) = checked {
        errors.push(error.to_string());
    }
    Ok(Precheck { ok: errors.is_empty(), errors, warnings })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConfigApplyResult {
    pub container_id: String,
    pub backup_container: Option<String>,
    pub snapshot_image: Option<String>,
    pub restarted: bool,
    pub mcp_refreshed: bool,
    pub warnings: Vec<String>,
}

/// 全局串行化重建，避免同一容器在两个提交中同时被改名。
pub(super) fn rebuild_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// 代理/共享组重建沿用已有 MCP 导出，不隐式重新导入宿主文件。
pub(crate) async fn recreate_with_host_config(
    state: &AppState,
    name: &str,
    inspect: &ContainerInspectResponse,
    request: &CreateContainerRequest,
) -> AppResult<()> {
    let _guard = rebuild_lock().lock().await;
    let docker = state.docker()?;
    require_local(&docker)?;
    let fresh = docker.inspect(name).await?;
    check_expected_id(&fresh, inspect.id.as_deref().unwrap_or(""))?;
    let config = request.host_config.clone().unwrap_or_default();
    let mut directories = config.clone();
    directories.mcp_configs.clear();
    host_config::validate(&directories)?;
    if !config.mcp_configs.is_empty() {
        let directory =
            request.host_mcp_dir.as_ref().ok_or_else(|| AppError::Invalid("MCP 导出目录缺失，未进行重建".into()))?;
        read_previous_export(Path::new(directory), &state.config.dir().join("host-config"), &config)?;
    }
    rebuild_candidate(&docker, name, &fresh, request, Vec::new(), || state.sessions.drop_container(name)).await?;
    Ok(())
}

#[tauri::command]
pub async fn container_host_config_apply(
    state: State<'_, AppState>,
    name: String,
    host_config: HostClaudeConfig,
    expected_container_id: String,
) -> AppResult<HostConfigApplyResult> {
    let _guard = rebuild_lock().lock().await;
    let docker = state.docker()?;
    require_local(&docker)?;
    let inspect = docker.inspect(&name).await?;
    check_expected_id(&inspect, &expected_container_id)?;
    let prepared = host_config::validate(&host_config)?;
    let warnings = inspect_precheck(&inspect, &prepared)?;
    let mut req = recreate_request(&name, &inspect)?;
    let unchanged = req.host_config.clone().unwrap_or_default().normalized() == prepared.config;
    if unchanged && !prepared.config.mcp_configs.is_empty() {
        let directory = req
            .host_mcp_dir
            .as_ref()
            .ok_or_else(|| AppError::Invalid("缺少受控 MCP 导出目录，请重新选择配置后应用并重建".into()))?;
        let running = inspect.state.as_ref().and_then(|state| state.running).unwrap_or(false);
        refresh_mcp(
            &docker,
            &expected_container_id,
            running,
            &prepared,
            Path::new(directory),
            &state.config.dir().join("host-config"),
        )
        .await?;
        return Ok(HostConfigApplyResult {
            container_id: expected_container_id,
            backup_container: None,
            snapshot_image: None,
            restarted: false,
            mcp_refreshed: true,
            warnings: prepared.warnings,
        });
    }
    if unchanged {
        return Ok(HostConfigApplyResult {
            container_id: expected_container_id,
            backup_container: None,
            snapshot_image: None,
            restarted: false,
            mcp_refreshed: false,
            warnings: vec!["配置未变化，容器与当前会话保持运行状态".into()],
        });
    }
    req.host_mcp_dir =
        prepared.persist_mcp(&state.config.dir().join("host-config"))?.map(|path| path.to_string_lossy().into_owned());
    req.host_config = Some(prepared.config);
    let result =
        rebuild_candidate(&docker, &name, &inspect, &req, warnings, || state.sessions.drop_container(&name)).await;
    state.wake.notify_one();
    result
}

pub(super) fn check_expected_id(inspect: &ContainerInspectResponse, expected: &str) -> AppResult<()> {
    if expected.is_empty() || inspect.id.as_deref() != Some(expected) {
        Err(AppError::Invalid("容器已变化，请重新打开配置窗口后再应用".into()))
    } else {
        Ok(())
    }
}

fn read_previous_export(directory: &Path, root: &Path, config: &HostClaudeConfig) -> AppResult<HostConfigPrepared> {
    let invalid = || AppError::Invalid("MCP 导出目录不属于本应用，拒绝修改".into());
    let canonical = directory.canonicalize().map_err(|_| invalid())?;
    let root = root.canonicalize().map_err(|_| invalid())?;
    if canonical.parent() != Some(root.as_path())
        || canonical
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| uuid::Uuid::parse_str(name).ok())
            .is_none()
    {
        return Err(invalid());
    }
    let file = canonical.join("mcp.json");
    let metadata = std::fs::symlink_metadata(&file).map_err(|_| invalid())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4 * 1024 * 1024 {
        return Err(invalid());
    }
    let bytes = std::fs::read(&file).map_err(|_| invalid())?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let servers = value.get("mcpServers").and_then(|servers| servers.as_object()).cloned().ok_or_else(invalid)?;
    Ok(HostConfigPrepared { config: config.clone(), mcp_servers: servers, warnings: Vec::new() })
}

async fn refresh_private_mcp(docker: &DockerClient, container: &str) -> AppResult<()> {
    let gid = docker.exec_as(container, "root", &["id", "-g", "node"], None, Duration::from_secs(5)).await?;
    let group = gid.stdout.trim();
    if gid.exit_code != Some(0) || group.is_empty() || !group.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(AppError::Other("无法确认容器 node 用户组，MCP 未重新导入".into()));
    }
    let output = docker
        .exec_as(
            container,
            "root",
            &["node", "/opt/tdc/tdc-host-config.mjs", "refresh-mcp", group],
            None,
            Duration::from_secs(10),
        )
        .await?;
    let result = serde_json::from_str::<serde_json::Value>(&output.stdout).ok();
    if output.exit_code != Some(0)
        || result.as_ref().and_then(|value| value.get("prepared")).and_then(|value| value.as_bool()) != Some(true)
    {
        return Err(AppError::Other("容器 MCP 私有副本刷新失败".into()));
    }
    let readable = docker.exec(container, &["test", "-r", "/var/lib/tdc/host-config/mcp.json"], None).await?;
    if readable.exit_code != Some(0) {
        return Err(AppError::Other("容器 node 用户无法读取 MCP 私有副本".into()));
    }
    Ok(())
}

async fn refresh_mcp(
    docker: &DockerClient,
    container: &str,
    running: bool,
    prepared: &HostConfigPrepared,
    directory: &Path,
    root: &Path,
) -> AppResult<()> {
    let old = read_previous_export(directory, root, &prepared.config)?;
    prepared.replace_mcp_export(directory, root)?;
    if running {
        if let Err(error) = refresh_private_mcp(docker, container).await {
            let restored = old.replace_mcp_export(directory, root);
            let runtime = if restored.is_ok() {
                refresh_private_mcp(docker, container).await
            } else {
                Err(AppError::Other("旧导出恢复失败".into()))
            };
            if restored.is_err() || runtime.is_err() {
                return Err(AppError::Other(format!(
                    "MCP 重新导入失败，旧配置恢复未完成；当前终端未关闭，请检查配置：{error}"
                )));
            }
            return Err(AppError::Other(format!("MCP 重新导入失败，已恢复旧配置；当前终端未关闭：{error}")));
        }
    }
    Ok(())
}

/// 克隆完整原配置，仅修改本功能与已有共享组/代理重建所管理的字段。
fn candidate_body(
    inspect: &ContainerInspectResponse,
    req: &CreateContainerRequest,
    snapshot: &str,
) -> AppResult<ContainerCreateBody> {
    let generated = spec::build_create_body(req)?;
    let mut body: ContainerCreateBody =
        serde_json::from_value(serde_json::to_value(inspect.config.clone().unwrap_or_default())?)?;
    let mut host = complete_host_config(inspect)?;
    // home 始终沿用原始挂载；只有切换共享组时才替换共享卷。
    let old_labels = labels(inspect);
    let old_group = old_labels.get(spec::LABEL_GROUP).map(String::as_str).unwrap_or("default");
    let new_group = generated
        .labels
        .as_ref()
        .and_then(|labels| labels.get(spec::LABEL_GROUP))
        .map(String::as_str)
        .unwrap_or("default");
    let shared_changed = old_group != new_group;
    let managed = |target: &str| {
        (shared_changed && matches!(target, spec::PROJECTS_DIR | spec::SHARED_DIR))
            || target == HOST_CONFIG_ROOT
            || target.starts_with(&format!("{HOST_CONFIG_ROOT}/"))
    };
    let mut binds = host.binds.take().unwrap_or_default();
    binds.retain(|bind| {
        super::container_cmds::split_bind(bind)
            .map(|(_, tail)| !managed(tail.split(':').next().unwrap_or("")))
            .unwrap_or(true)
    });
    for bind in generated.host_config.as_ref().and_then(|host| host.binds.as_ref()).into_iter().flatten() {
        if shared_changed
            && super::container_cmds::split_bind(bind).is_some_and(|(_, tail)| {
                matches!(tail.split(':').next().unwrap_or(""), spec::PROJECTS_DIR | spec::SHARED_DIR)
            })
        {
            binds.push(bind.clone());
        }
    }
    host.binds = Some(binds);
    let mut mounts = host.mounts.take().unwrap_or_default();
    mounts.retain(|mount| !managed(mount.target.as_deref().unwrap_or("")));
    mounts.extend(generated.host_config.as_ref().and_then(|host| host.mounts.clone()).unwrap_or_default());
    host.mounts = (!mounts.is_empty()).then_some(mounts);
    if req.proxy_capable {
        let caps = host.cap_add.get_or_insert_with(Default::default);
        if !caps.iter().any(|cap| cap.eq_ignore_ascii_case("NET_ADMIN") || cap.eq_ignore_ascii_case("CAP_NET_ADMIN")) {
            caps.push("NET_ADMIN".into());
        }
        let generated_host = generated.host_config.as_ref().expect("host config");
        let devices = host.devices.get_or_insert_with(Default::default);
        for device in generated_host.devices.as_deref().unwrap_or_default() {
            if !devices.iter().any(|old| old.path_in_container == device.path_in_container) {
                devices.push(device.clone());
            }
        }
        host.sysctls.get_or_insert_with(Default::default).extend(generated_host.sysctls.clone().unwrap_or_default());
    }
    let mut labels = body.labels.take().unwrap_or_default();
    labels.insert(spec::LABEL_HOST_CONFIG_IMAGE.into(), "1".into());
    labels.remove(spec::LABEL_HOST_CONFIG_SOURCES);
    for key in [spec::LABEL_HOST_CONFIG_SOURCES, spec::LABEL_GROUP] {
        if let Some(value) = generated.labels.as_ref().and_then(|labels| labels.get(key)) {
            labels.insert(key.into(), value.clone());
        }
    }
    body.labels = Some(labels);
    body.image = Some(snapshot.into());
    body.host_config = Some(host);
    // inspect 中的动态 IP/端点 ID 不能回填；用户网络的别名和驱动选项需要显式保留。
    if let Some(networks) = inspect.network_settings.as_ref().and_then(|settings| settings.networks.as_ref()) {
        let endpoints: HashMap<_, _> = networks
            .iter()
            .filter(|(name, _)| !matches!(name.as_str(), "bridge" | "host" | "none"))
            .map(|(name, endpoint)| {
                let id = inspect.id.as_deref().unwrap_or("");
                let aliases = endpoint.aliases.as_ref().map(|aliases| {
                    aliases
                        .iter()
                        .filter(|alias| alias.as_str() != id && alias.as_str() != &id[..id.len().min(12)])
                        .cloned()
                        .collect()
                });
                (
                    name.clone(),
                    EndpointSettings {
                        aliases,
                        links: endpoint.links.clone(),
                        driver_opts: endpoint.driver_opts.clone(),
                        gw_priority: endpoint.gw_priority,
                        ..Default::default()
                    },
                )
            })
            .collect();
        if !endpoints.is_empty() {
            body.networking_config = Some(NetworkingConfig { endpoints_config: Some(endpoints) });
        }
    }
    Ok(body)
}

async fn install_runtime(docker: &DockerClient, candidate: &str) -> AppResult<()> {
    for (path, bytes) in [
        ("entrypoint.sh", include_str!("../../../docker/rootfs/opt/tdc/entrypoint.sh")),
        ("entrypoint-user.sh", include_str!("../../../docker/rootfs/opt/tdc/entrypoint-user.sh")),
        ("tdc-claude.sh", include_str!("../../../docker/rootfs/opt/tdc/tdc-claude.sh")),
        ("tdc-ctl.sh", include_str!("../../../docker/rootfs/opt/tdc/tdc-ctl.sh")),
        ("tdc-session.sh", include_str!("../../../docker/rootfs/opt/tdc/tdc-session.sh")),
        ("tdc-session-history.mjs", include_str!("../../../docker/rootfs/opt/tdc/tdc-session-history.mjs")),
        ("tdc-usage.mjs", include_str!("../../../docker/rootfs/opt/tdc/tdc-usage.mjs")),
        ("tdc-quota.mjs", include_str!("../../../docker/rootfs/opt/tdc/tdc-quota.mjs")),
        ("statusline.mjs", include_str!("../../../docker/rootfs/opt/tdc/statusline.mjs")),
        ("statusline-display.mjs", include_str!("../../../docker/rootfs/opt/tdc/statusline-display.mjs")),
        ("tdc-host-config.mjs", include_str!("../../../docker/rootfs/opt/tdc/tdc-host-config.mjs")),
    ] {
        docker
            .write_file_owned(candidate, &format!("/opt/tdc/{path}"), bytes.replace("\r\n", "\n").as_bytes(), 0o755, 0)
            .await?;
    }
    Ok(())
}

/// 普通启动/重启也必须检查延迟启动的宿主资源容器，避免入口记录错误后表面启动成功。
pub(crate) async fn verify_configured_start(docker: &DockerClient, container: &str) -> AppResult<()> {
    let inspect = docker.inspect(container).await?;
    let metadata = labels(&inspect);
    let Some(source) = metadata.get(spec::LABEL_HOST_CONFIG_SOURCES) else { return Ok(()) };
    let config: HostClaudeConfig =
        serde_json::from_str(source).map_err(|_| AppError::Invalid("宿主配置元数据无效，无法确认初始化状态".into()))?;
    if config.is_empty() {
        return Ok(());
    }
    verify_started(docker, container, !config.mcp_configs.is_empty()).await
}

pub(crate) async fn verify_started(docker: &DockerClient, candidate: &str, mcp: bool) -> AppResult<()> {
    let mut command = "test -x /usr/local/bin/tdc-claude-real && test \"$(readlink /usr/local/bin/claude)\" = /opt/tdc/tdc-claude.sh && test \"$(readlink -f /usr/local/bin/tdc-claude-real)\" != \"$(readlink -f /opt/tdc/tdc-claude.sh)\"".to_string();
    if mcp {
        command.push_str(" && test -r /var/lib/tdc/host-config/mcp.json");
    }
    for _ in 0..20 {
        if docker.inspect(candidate).await?.state.and_then(|state| state.running) != Some(true) {
            return Err(AppError::Other("容器启动后退出".into()));
        }
        if docker
            .exec_as(candidate, "node", &["/bin/sh", "-c", &command], None, Duration::from_secs(3))
            .await
            .is_ok_and(|output| output.exit_code == Some(0))
        {
            let output = docker.exec(candidate, &["/opt/tdc/tdc-ctl.sh", "link-shared"], None).await?;
            let value: serde_json::Value = serde_json::from_str(&output.stdout)
                .map_err(|_| AppError::Other("宿主配置初始化未返回有效状态".into()))?;
            if output.exit_code != Some(0)
                || value.get("issues").and_then(|issues| issues.as_array()).map_or(true, |issues| !issues.is_empty())
            {
                return Err(AppError::Other("宿主资源初始化失败，请检查源目录权限、失效链接和配置目录权限".into()));
            }
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(AppError::Other("容器未完成宿主配置初始化".into()))
}

pub(crate) async fn rebuild_candidate(
    docker: &DockerClient,
    name: &str,
    inspect: &ContainerInspectResponse,
    req: &CreateContainerRequest,
    warnings: Vec<String>,
    detach: impl FnOnce(),
) -> AppResult<HostConfigApplyResult> {
    rebuild_candidate_with_edit(docker, name, inspect, req, warnings, None, detach).await
}

pub(super) async fn rebuild_candidate_with_edit(
    docker: &DockerClient,
    name: &str,
    inspect: &ContainerInspectResponse,
    req: &CreateContainerRequest,
    mut warnings: Vec<String>,
    edit: Option<&super::container_edit_cmds::ContainerEdit>,
    detach: impl FnOnce(),
) -> AppResult<HostConfigApplyResult> {
    validate_rebuild_shape(inspect)?;
    let build = |image: &str| -> AppResult<ContainerCreateBody> {
        let mut body = candidate_body(inspect, req, image)?;
        if let Some(edit) = edit {
            super::container_edit_cmds::apply_edit_to_body(inspect, &mut body, edit)?;
        }
        Ok(body)
    };
    // 完整构造先于 commit/stop；非法目标不会触碰运行中的容器。
    build("precheck")?;
    let original = inspect.id.as_deref().ok_or_else(|| AppError::Invalid("容器缺少 ID".into()))?;
    let was_running = inspect.state.as_ref().and_then(|state| state.running).unwrap_or(false);
    let token = uuid::Uuid::new_v4().simple().to_string();
    let backup = format!("tdc-backup-{}", &token[..12]);
    let temporary = format!("tdc-candidate-{}", &token[..12]);
    let snapshot = format!("tdc/host-config-backup:{token}");
    // 先验证 Docker 能解析只读挂载并接收脚本；这个候选不启动，也不写入数据卷。
    let base_image = inspect
        .image
        .as_deref()
        .or_else(|| inspect.config.as_ref().and_then(|config| config.image.as_deref()))
        .ok_or_else(|| AppError::Invalid("原容器缺少镜像记录".into()))?;
    let probe = docker.create_candidate(&temporary, build(base_image)?).await?;
    if let Err(error) = install_runtime(docker, &probe).await {
        let cleanup = docker.remove(&probe, false).await;
        return Err(AppError::Other(format!(
            "候选配置写入失败，原容器未停止：{error}{}",
            cleanup.err().map(|e| format!("；候选清理失败：{e}")).unwrap_or_default()
        )));
    }
    docker.remove(&probe, false).await?;
    // 停止后才做最终快照，包含预检期间产生的最后文件变更。
    if was_running {
        docker.stop(original, false).await?;
    }
    detach();
    let mut candidate_id: Option<String> = None;
    let prepare: AppResult<String> = async {
        docker
            .raw()
            .commit_container(
                CommitContainerOptions {
                    container: Some(original.into()),
                    repo: Some("tdc/host-config-backup".into()),
                    tag: Some(token),
                    pause: false,
                    comment: Some("TDC: preserve writable layer after graceful stop".into()),
                    ..Default::default()
                },
                inspect.config.clone().unwrap_or_default(),
            )
            .await?;
        let candidate = docker.create_candidate(&temporary, build(&snapshot)?).await?;
        candidate_id = Some(candidate.clone());
        install_runtime(docker, &candidate).await?;
        Ok(candidate)
    }
    .await;
    let candidate = match prepare {
        Ok(candidate) => candidate,
        Err(error) => {
            let mut issues = Vec::new();
            if let Some(candidate) = candidate_id {
                if let Err(cleanup) = docker.remove(&candidate, false).await {
                    issues.push(format!("候选清理失败：{cleanup}"));
                }
            }
            if was_running {
                if let Err(start) = docker.start(original).await {
                    issues.push(format!("原容器重新启动失败：{start}"));
                }
            }
            return Err(AppError::Other(format!(
                "候选准备失败，原容器及其文件未删除：{error}{}",
                if issues.is_empty() { String::new() } else { format!("；{}", issues.join("；")) }
            )));
        }
    };
    replace_prepared(
        docker,
        name,
        &candidate,
        &backup,
        req.host_config.as_ref().is_some_and(|config| !config.mcp_configs.is_empty()),
        inspect,
        &snapshot,
    )
    .await?;
    let backup_container = if let Err(error) = docker.remove(original, false).await {
        warnings.push(format!("新容器已就绪；旧备份 {backup} 删除失败，请仅用于手动回滚：{error}"));
        Some(backup)
    } else {
        None
    };
    Ok(HostConfigApplyResult {
        container_id: candidate,
        backup_container,
        snapshot_image: Some(snapshot),
        restarted: was_running,
        mcp_refreshed: false,
        warnings,
    })
}

async fn replace_prepared(
    docker: &DockerClient,
    name: &str,
    candidate: &str,
    backup: &str,
    has_mcp: bool,
    inspect: &ContainerInspectResponse,
    snapshot: &str,
) -> AppResult<()> {
    let original = inspect.id.as_deref().ok_or_else(|| AppError::Invalid("容器缺少 ID".into()))?;
    let was_running = inspect.state.as_ref().and_then(|state| state.running).unwrap_or(false);
    let mut original_renamed = false;
    let mut start_attempted = false;
    let transition: AppResult<()> = async {
        docker.raw().rename_container(original, RenameContainerOptions { name: backup.into() }).await?;
        original_renamed = true;
        docker.raw().rename_container(candidate, RenameContainerOptions { name: name.into() }).await?;
        if was_running {
            start_attempted = true;
            docker.start(candidate).await?;
            verify_started(docker, candidate, has_mcp).await?;
        }
        Ok(())
    }
    .await;
    if let Err(error) = transition {
        let mut rollback_errors = Vec::new();
        // 先移除候选释放原名称与端口；所有删除均使用本次候选 ID，绝不删除原容器。
        let cleaned = docker.remove(candidate, false).await;
        if let Err(cleanup) = &cleaned {
            rollback_errors.push(format!("候选清理失败：{cleanup}"));
        }
        let restored = if start_attempted && cleaned.is_ok() {
            restore_home_overlay(docker, inspect, snapshot).await
        } else {
            Ok(())
        };
        if let Err(restore) = &restored {
            rollback_errors.push(format!("原配置还原失败：{restore}"));
        }
        if original_renamed {
            if let Err(rename) =
                docker.raw().rename_container(original, RenameContainerOptions { name: name.into() }).await
            {
                rollback_errors.push(format!("原容器仍保留为 {backup}，恢复名称失败：{rename}"));
            }
        }
        if was_running && cleaned.is_ok() && restored.is_ok() {
            if let Err(start) = docker.start(original).await {
                rollback_errors.push(format!("原容器重新启动失败：{start}"));
            }
        }
        let status = if rollback_errors.is_empty() {
            "已恢复原容器；会话历史和文件保留".to_string()
        } else {
            format!("原容器未删除；{}", rollback_errors.join("；"))
        };
        return Err(AppError::Other(format!("重建未完成：{error}；{status}")));
    }
    Ok(())
}

/// 候选可能已经在共享 home 中安装了覆盖链接；用无网络、无普通入口的 helper 恢复原件。
async fn restore_home_overlay(
    docker: &DockerClient,
    inspect: &ContainerInspectResponse,
    snapshot: &str,
) -> AppResult<()> {
    let cfg = inspect.config.as_ref().cloned().unwrap_or_default();
    let env = cfg.env.unwrap_or_default();
    let value = |key: &str, fallback: &str| {
        env.iter().find_map(|entry| entry.strip_prefix(&format!("{key}="))).unwrap_or(fallback).to_string()
    };
    let config_dir = value("CLAUDE_CONFIG_DIR", spec::CLAUDE_DIR);
    let shared_dir = value("TDC_SHARED_DIR", spec::SHARED_DIR);
    let overlaps = |target: &str| {
        [&config_dir, &shared_dir].iter().any(|root| {
            target == root.as_str()
                || root.starts_with(&format!("{target}/"))
                || target.starts_with(&format!("{root}/"))
        })
    };
    let old_host = complete_host_config(inspect)?;
    let binds = old_host
        .binds
        .unwrap_or_default()
        .into_iter()
        .filter(|bind| {
            super::container_cmds::split_bind(bind)
                .is_some_and(|(_, tail)| overlaps(tail.split(':').next().unwrap_or("")))
        })
        .collect();
    let mounts = old_host
        .mounts
        .unwrap_or_default()
        .into_iter()
        .filter(|mount| overlaps(mount.target.as_deref().unwrap_or("")))
        .collect();
    let body = ContainerCreateBody {
        image: Some(snapshot.into()),
        user: Some("node".into()),
        working_dir: Some("/".into()),
        env: Some(env),
        entrypoint: Some(vec!["flock".into()]),
        cmd: Some(vec![
            format!("{config_dir}/tdc/host-config.lock"),
            "node".into(),
            "/opt/tdc/tdc-host-config.mjs".into(),
            "restore-only".into(),
        ]),
        labels: Some(HashMap::from([(spec::LABEL_MANAGED.into(), "false".into())])),
        healthcheck: Some(HealthConfig { test: Some(vec!["NONE".into()]), ..Default::default() }),
        host_config: Some(HostConfig {
            binds: Some(binds),
            mounts: Some(mounts),
            network_mode: Some("none".into()),
            cap_drop: Some(vec!["ALL".into()]),
            ..Default::default()
        }),
        ..Default::default()
    };
    let helper = docker.create_candidate(&format!("tdc-restore-{}", uuid::Uuid::new_v4().simple()), body).await?;
    let result: AppResult<()> = async {
        docker
            .write_file_owned(
                &helper,
                "/opt/tdc/tdc-host-config.mjs",
                include_str!("../../../docker/rootfs/opt/tdc/tdc-host-config.mjs").replace("\r\n", "\n").as_bytes(),
                0o755,
                0,
            )
            .await?;
        docker.start(&helper).await?;
        for _ in 0..40 {
            let state =
                docker.inspect(&helper).await?.state.ok_or_else(|| AppError::Other("还原辅助容器未返回状态".into()))?;
            if state.running != Some(true) {
                return if state.exit_code == Some(0) {
                    Ok(())
                } else {
                    Err(AppError::Other("宿主覆盖原件未能完整还原，备份仍保留在 home 卷".into()))
                };
            }
            tokio::time::sleep(Duration::from_millis(125)).await;
        }
        Err(AppError::Other("宿主配置还原超时".into()))
    }
    .await;
    let cleanup = docker.remove(&helper, false).await;
    result.and(cleanup)
}

#[cfg(test)]
#[path = "host_config_rebuild_tests.rs"]
mod tests;
