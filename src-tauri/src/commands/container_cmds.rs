//! 容器相关命令：引擎状态、列表、创建 / 启停 / 删除、授权与供应商切换、共享卷重建。

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::proxy_cmds::{
    ensure_engine_supported, image_has_xray, push_proxy_files, validate_proxy_image, write_bundle,
};
use crate::docker::client::{ContainerInfo, DockerClient, EngineInfo};
use crate::docker::spec::{self, CreateContainerRequest, PortMapping, PROVIDER_FILE};
use crate::error::{AppError, AppResult};
use crate::ports;
use crate::quota::model::AccountInfo;
use crate::quota::poller::FleetState;
use crate::state::AppState;

fn usage_snapshot_path(running: bool) -> &'static str {
    if running {
        crate::usage::PROVIDER_USAGE_PENDING_FILE
    } else {
        crate::usage::PROVIDER_USAGE_FILE
    }
}

async fn write_usage_snapshot(docker: &DockerClient, name: &str, body: &[u8], running: bool) -> AppResult<()> {
    if !running {
        // Write pending first.  If the second upload fails, the next Claude
        // launch can still promote this fresh pending snapshot instead of
        // promoting an older pending file over a new active snapshot.
        docker.write_file(name, crate::usage::PROVIDER_USAGE_PENDING_FILE, body, 0o600).await?;
    }
    docker.write_file(name, usage_snapshot_path(running), body, 0o600).await?;
    Ok(())
}

/// 查询引擎信息。参数：state——全局状态；返回：引擎概要。
#[tauri::command]
pub async fn engine_info(state: State<'_, AppState>) -> AppResult<EngineInfo> {
    state.docker()?.engine_info().await
}

/// 读取最近一次汇总（不触发采集）。参数：state——全局状态；返回：汇总。
#[tauri::command]
pub fn fleet_get(state: State<'_, AppState>) -> FleetState {
    state.poller.lock().fleet.clone()
}

/// 立即触发一轮采集。参数：state——全局状态；返回：无。
#[tauri::command]
pub fn fleet_refresh(state: State<'_, AppState>) {
    state.wake.notify_one();
}

/// 列出容器。参数：state——全局状态；include_unmanaged——是否包含非 tdc 容器；返回：容器列表。
#[tauri::command]
pub async fn container_list(state: State<'_, AppState>, include_unmanaged: bool) -> AppResult<Vec<ContainerInfo>> {
    state.docker()?.list(include_unmanaged).await
}

/// 新建容器表单的默认值与预检结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDefaults {
    /// 建议容器名
    pub name: String,
    /// 建议槽位
    pub slot: u16,
    /// 默认镜像
    pub image: String,
    /// 镜像是否已在本地
    pub image_ready: bool,
    /// 建议端口映射
    pub ports: Vec<PortMapping>,
}

/// 计算新建容器的默认值（下一个空闲槽位 + 端口分配）。
/// 参数：state——全局状态；返回：默认值。
#[tauri::command]
pub async fn container_defaults(state: State<'_, AppState>) -> AppResult<CreateDefaults> {
    let docker = state.docker()?;
    let list = docker.list(true).await?;
    let used_slots: HashSet<u16> = list.iter().map(|c| c.slot).collect();
    let slot = (1..100).find(|s| !used_slots.contains(s)).unwrap_or(99);
    let reserved: HashSet<u16> = list.iter().flat_map(|c| c.ports.iter().map(|p| p.1)).collect();
    let image = state.config.settings().docker.default_image;
    let alloc = ports::allocate(&[3000, 5173, 8080], slot, &reserved, ports::host_port_free);
    let labels = ["Web 预览 (Next/React)", "Vite 开发服务", "API 服务"];
    Ok(CreateDefaults {
        name: format!("claude-dev-{slot:02}"),
        slot,
        image_ready: docker.image_exists(&image).await,
        image,
        ports: alloc
            .into_iter()
            .zip(labels)
            .map(|((c, h), l)| PortMapping { container_port: c, host_port: h, label: l.into() })
            .collect(),
    })
}

/// 预检结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Precheck {
    /// 是否可创建
    pub ok: bool,
    /// 问题列表（阻断）
    pub errors: Vec<String>,
    /// 提示列表（不阻断）
    pub warnings: Vec<String>,
}

/// 创建前预检：名称、重名、镜像、端口占用、Windows 路径性能。
/// 参数：state——全局状态；req——表单；返回：预检结果。
#[tauri::command]
pub async fn container_precheck(state: State<'_, AppState>, req: CreateContainerRequest) -> AppResult<Precheck> {
    let docker = state.docker()?;
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    if let Err(e) = spec::validate_name(&req.name) {
        errors.push(e.to_string());
    }
    if let Err(e) = spec::validate_region(&req) {
        errors.push(e.to_string());
    }
    match super::host_config_cmds::check_new_host_config(&docker, &req).await {
        Ok(Some(prepared)) => warnings.extend(prepared.warnings),
        Ok(None) => {}
        Err(error) => errors.push(error.to_string()),
    }
    if let Err(e) = prepare_create_proxy(&state.proxies, &docker, &req).await {
        errors.push(e.to_string());
    }
    let list = docker.list(true).await?;
    if list.iter().any(|c| c.name == req.name) {
        errors.push(format!("已存在同名容器 {}", req.name));
    }
    if !docker.image_exists(&req.image).await {
        errors.push(format!("本地没有镜像 {}，请先构建（默认镜像可在应用内一键构建）", req.image));
    } else if req.proxy_capable && !docker.image_supports_proxy(&req.image).await {
        warnings.push(format!(
            "镜像 {} 不支持代理（不是用当前 docker/Dockerfile 构建的），创建后无法开启代理；请先执行 docker build -t {} .",
            req.image, req.image
        ));
    }
    if req.locale.as_deref().is_some_and(|l| !l.is_empty() && l != "C.UTF-8")
        && !docker.image_supports_locales(&req.image).await
    {
        warnings.push("所选语言需要对应的 locale；旧版或自定义镜像可能未包含，请使用最新标准镜像（docker build -t tdc/claude-dev:latest docker）".into());
    }
    let reserved: HashSet<u16> = list.iter().flat_map(|c| c.ports.iter().map(|p| p.1)).collect();
    let mut seen = HashSet::new();
    for p in &req.ports {
        if !seen.insert(p.host_port) {
            errors.push(format!("宿主端口 {} 重复", p.host_port));
        } else if reserved.contains(&p.host_port) || !ports::host_port_free(p.host_port) {
            errors.push(format!("宿主端口 {} 已被占用", p.host_port));
        }
    }
    for m in &req.mounts {
        if spec::is_windows_drive_path(&m.host_path) {
            warnings.push(format!(
                "{} 位于 Windows 盘符，容器内 I/O 较慢且文件监听不可靠，建议放到 WSL2 文件系统",
                m.host_path
            ));
        }
    }
    if req.auth_mode == "api" && req.provider_id.is_none() {
        errors.push("API 模式需要选择供应商".into());
    }
    if req.shared_group && req.mounts.is_empty() {
        warnings.push("未挂载项目目录：热切换要求各容器在相同路径挂载同一项目".into());
    }
    Ok(Precheck { ok: errors.is_empty(), errors, warnings })
}

/// 创建容器；在首次启动前写入代理配置并保存绑定。
/// 参数：state——全局状态；req——表单；start——是否立即启动；返回：容器 ID。
#[tauri::command]
pub async fn container_create(
    state: State<'_, AppState>,
    req: CreateContainerRequest,
    start: bool,
) -> AppResult<String> {
    let docker = state.docker()?;
    let result = create_configured(
        &docker,
        &state.proxies,
        &state.providers,
        &req,
        start,
        &state.config.dir().join("host-config"),
    )
    .await;
    state.wake.notify_one();
    result
}

/// 预检和提交共用校验；渲染失败时还没有创建容器。
async fn prepare_create_proxy(
    proxies: &crate::proxy::ProxyStore,
    docker: &DockerClient,
    req: &CreateContainerRequest,
) -> AppResult<Option<crate::proxy::render::Rendered>> {
    let Some(binding) = req.proxy.as_ref().filter(|b| b.enabled) else { return Ok(None) };
    if !req.proxy_capable {
        return Err(AppError::Invalid("开启代理需要授予容器内代理能力".into()));
    }
    validate_proxy_image(docker, &req.image).await?;
    let rendered = proxies.render(binding)?;
    ensure_engine_supported(&rendered, image_has_xray(docker, &req.image).await)?;
    Ok(Some(rendered))
}

/// 独立于 Tauri 的创建流程，保证配置落盘后才允许首次启动。
async fn create_configured(
    docker: &DockerClient,
    proxies: &crate::proxy::ProxyStore,
    providers: &crate::providers::ProviderStore,
    req: &CreateContainerRequest,
    start: bool,
    host_config_root: &std::path::Path,
) -> AppResult<String> {
    let mut req = req.clone();
    super::host_config_cmds::prepare_new_host_config(docker, &mut req, host_config_root).await?;
    let proxy = prepare_create_proxy(proxies, docker, &req).await?;
    let provider_id = (req.auth_mode == "api").then_some(req.provider_id.as_deref()).flatten();
    let provider_body = if req.auth_mode == "api" { Some(providers.render_settings(provider_id)?) } else { None };
    create_prepared(docker, proxies, providers, &req, start, proxy, provider_body).await
}

/// 所有密钥解析完成后，执行 Docker 写入与启动；便于验证失败时不会启动容器。
async fn create_prepared(
    docker: &DockerClient,
    proxies: &crate::proxy::ProxyStore,
    providers: &crate::providers::ProviderStore,
    req: &CreateContainerRequest,
    start: bool,
    proxy: Option<crate::proxy::render::Rendered>,
    provider_body: Option<Vec<u8>>,
) -> AppResult<String> {
    let provider_id = (req.auth_mode == "api").then_some(req.provider_id.as_deref()).flatten();
    let id = docker.create(req, false).await?;
    let previous_proxy = proxies.binding_of(&req.name);
    let previous_provider = providers.binding_of(&req.name);
    let configured: AppResult<()> = async {
        if let Some(rendered) = &proxy {
            write_bundle(docker, &id, &rendered.config, &rendered.intent).await?;
        }
        // 即使同名旧容器曾在应用外被删除，也不能意外继承它的代理/供应商。
        proxies.bind(&req.name, req.proxy.clone().filter(|b| b.enabled).unwrap_or_default())?;
        providers.bind(&req.name, provider_id)?;
        if start {
            // Write all startup files while the container is still stopped so
            // any failure follows the same cleanup path as proxy setup.
            if let Some(body) = provider_body.as_deref() {
                docker.write_file(&id, PROVIDER_FILE, body, 0o600).await?;
            }
            let usage_body = providers.render_usage_settings(provider_id)?;
            write_usage_snapshot(docker, &id, &usage_body, false).await?;
        }
        Ok(())
    }
    .await;
    if let Err(error) = configured {
        // 只移除本次返回的容器 ID，所有命名卷都保留，避免误删既有凭证或共享数据。
        if let Err(cleanup) = docker.remove(&id, false).await {
            return Err(AppError::Other(format!(
                "容器 {} 配置失败且清理失败，尚未启动：{error}；{cleanup}。请删除该未启动容器后重试",
                req.name
            )));
        }
        let restored_proxy = match previous_proxy {
            Some(binding) => proxies.bind(&req.name, binding),
            None => proxies.unbind(&req.name),
        };
        let restored_provider = providers.bind(&req.name, previous_provider.as_deref());
        if let Err(restore) = restored_proxy.and(restored_provider) {
            return Err(AppError::Other(format!(
                "配置失败，已移除本次未启动容器；绑定恢复失败：{restore}。原错误：{error}"
            )));
        }
        return Err(AppError::Other(format!("配置失败，已移除本次未启动容器，可修改后重试：{error}")));
    }
    if start {
        // All provider and usage files were written before this point.  Start
        // only after the complete configuration is durable in the new volume.
        docker.start(&id).await.map_err(|e| {
            AppError::Other(format!("容器 {} 已创建并保存配置，但启动失败：{e}。请在容器列表中重试启动", req.name))
        })?;
        if req.host_config.as_ref().is_some_and(|config| !config.is_empty()) {
            super::host_config_cmds::verify_started(
                docker,
                &id,
                req.host_config.as_ref().is_some_and(|config| !config.mcp_configs.is_empty()),
            )
            .await
            .map_err(|error| {
                AppError::Other(format!(
                    "容器 {} 已创建，但宿主配置初始化失败：{error}。容器和命名卷已保留，请修正配置后重试",
                    req.name
                ))
            })?;
        }
    }
    Ok(id)
}

/// 容器生命周期动作：start / stop / restart / kill。
/// 参数：state——全局状态；name——容器名；action——动作；返回：成功与否。
#[tauri::command]
pub async fn container_action(state: State<'_, AppState>, name: String, action: String) -> AppResult<()> {
    let docker = state.docker()?;
    match action.as_str() {
        "start" => start_with_config(&state, &docker, &name).await?,
        "stop" => {
            state.sessions.drop_container(&name);
            docker.stop(&name, false).await?
        }
        "kill" => {
            state.sessions.drop_container(&name);
            docker.stop(&name, true).await?
        }
        "restart" => {
            state.sessions.drop_container(&name);
            docker.stop(&name, false).await?;
            start_with_config(&state, &docker, &name).await?
        }
        other => return Err(AppError::Invalid(format!("未知动作 {other}"))),
    }
    state.wake.notify_one();
    Ok(())
}

/// 启动容器并同步应用侧配置。
/// 代理配置在启动前推送（订阅地址可能已更换），entrypoint 据此在任何用户进程之前施加兜底；
/// 推送失败时容器仍启动（容器层保留着上次的配置），错误在启动后报告给前端。
/// 参数：state——全局状态；docker——客户端；name——容器名；返回：成功与否。
async fn start_with_config(state: &AppState, docker: &DockerClient, name: &str) -> AppResult<()> {
    let pushed = push_proxy_files(state, docker, name).await;
    // Apply both settings snapshots while the container is stopped.  A
    // pending snapshot belongs to a still-running Claude process and is only
    // promoted by tdc-claude.sh at the next process boundary.
    let provider_id = state.providers.binding_of(name);
    let provider_body = state.providers.render_settings(provider_id.as_deref())?;
    docker.write_file(name, PROVIDER_FILE, &provider_body, 0o600).await?;
    let usage_body = state.providers.render_usage_settings(provider_id.as_deref())?;
    write_usage_snapshot(docker, name, &usage_body, false).await?;
    docker.start(name).await?;
    super::host_config_cmds::verify_configured_start(docker, name).await.map_err(|error| {
        AppError::Other(format!("容器已启动，但宿主配置初始化失败：{error}。容器和数据已保留，请修正配置后重试"))
    })?;
    pushed.map(|_| ()).map_err(|e| AppError::Other(format!("容器已启动，但代理配置更新失败（沿用上次配置）：{e}")))
}

/// 删除容器（危险操作，前端需二次输入容器名确认）。
/// 参数：state——全局状态；name——容器名；confirm_name——用户输入的确认名；remove_home——是否删除凭证卷；返回：成功与否。
#[tauri::command]
pub async fn container_remove(
    state: State<'_, AppState>,
    name: String,
    confirm_name: String,
    remove_home: bool,
) -> AppResult<()> {
    if name != confirm_name {
        return Err(AppError::Invalid("确认名称与容器名不一致".into()));
    }
    let docker = state.docker()?;
    state.sessions.drop_container(&name);
    docker.remove(&name, remove_home).await?;
    state.config.remove_sessions_of(&name)?;
    let _ = state.providers.bind(&name, None);
    let _ = state.proxies.unbind(&name);
    state.wake.notify_one();
    Ok(())
}

/// 读取容器账号概要。参数：state——全局状态；name——容器名；返回：账号信息。
#[tauri::command]
pub async fn container_account(state: State<'_, AppState>, name: String) -> AppResult<AccountInfo> {
    let v = state.docker()?.tdc_ctl(&name, &["account"]).await?;
    Ok(serde_json::from_value(v)?)
}

/// 切换容器授权模式：订阅（provider_id = None）或 API 供应商。
/// 参数：state——全局状态；name——容器名；provider_id——供应商 ID；返回：成功与否。
#[tauri::command]
pub async fn container_set_provider(
    state: State<'_, AppState>,
    name: String,
    provider_id: Option<String>,
) -> AppResult<()> {
    let docker = state.docker()?;
    let info = docker.get(&name).await?;
    let body = state.providers.render_settings(provider_id.as_deref())?;
    docker.write_file(&name, PROVIDER_FILE, &body, 0o600).await?;
    let usage_body = state.providers.render_usage_settings(provider_id.as_deref())?;
    write_usage_snapshot(&docker, &name, &usage_body, info.running).await?;
    state.providers.bind(&name, provider_id.as_deref())?;
    state.wake.notify_one();
    Ok(())
}

/// 导入宿主机凭证文件（.credentials.json）到容器 home 卷。
/// 参数：state——全局状态；name——容器名；path——宿主机文件路径；返回：成功与否。
#[tauri::command]
pub async fn container_import_credentials(state: State<'_, AppState>, name: String, path: String) -> AppResult<()> {
    let content = std::fs::read(&path)?;
    let parsed: serde_json::Value =
        serde_json::from_slice(&content).map_err(|_| AppError::Invalid("凭证文件不是有效的 JSON".into()))?;
    if parsed.get("claudeAiOauth").is_none() {
        return Err(AppError::Invalid("文件中没有 claudeAiOauth 字段，不是 Claude Code 凭证文件".into()));
    }
    state.docker()?.write_file(&name, &format!("{}/.credentials.json", spec::CLAUDE_DIR), &content, 0o600).await?;
    state.wake.notify_one();
    Ok(())
}

/// 共享卷设置请求。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedGroupRequest {
    /// 共享组名（default 或自定义）
    pub group: String,
    /// 需要加入该组的容器
    pub members: Vec<String>,
    /// 需要退出共享的容器
    pub remove: Vec<String>,
}

/// 应用共享卷设置：Docker 不能修改已有容器的挂载，因此按原配置重建容器（home 卷保留，凭证不丢）。
/// 参数：state——全局状态；req——设置；返回：被重建的容器名。
#[tauri::command]
pub async fn shared_group_apply(state: State<'_, AppState>, req: SharedGroupRequest) -> AppResult<Vec<String>> {
    let mut rebuilt = Vec::new();
    let targets: Vec<(String, bool)> =
        req.members.iter().map(|m| (m.clone(), true)).chain(req.remove.iter().map(|m| (m.clone(), false))).collect();
    for (name, join) in targets {
        recreate_container(&state, &name, |create| {
            create.shared_group = join;
            create.group_name = join.then(|| req.group.clone());
        })
        .await?;
        rebuilt.push(name);
    }
    state.wake.notify_one();
    Ok(rebuilt)
}

/// 按原配置重建容器（home 卷保留，凭证不丢），mutate 修改需要变更的字段。
/// 顺序：删除 → 创建但不启动 → 推送代理配置 → 按原状态启动。代理已启用时若配置推送失败，
/// 容器保持未启动（新容器层没有 intent，启动即直连，违背"失败即断网"）。
/// 参数：state——全局状态；name——容器名；mutate——修改表单的函数；返回：成功与否。
pub async fn recreate_container(
    state: &AppState,
    name: &str,
    mutate: impl FnOnce(&mut CreateContainerRequest),
) -> AppResult<()> {
    let docker = state.docker()?;
    let inspect = docker.inspect(name).await?;
    let mut create = recreate_request(name, &inspect)?;
    mutate(&mut create);
    if create.host_config.as_ref().is_some_and(|config| !config.is_empty()) {
        // 宿主资源容器必须保留可写层和已安装脚本，不能回到旧镜像后丢失资源入口。
        return super::host_config_cmds::recreate_with_host_config(state, name, &inspect, &create).await;
    }
    let was_running = inspect.state.and_then(|s| s.running).unwrap_or(false);
    state.sessions.drop_container(name);
    docker.remove(name, false).await?;
    docker.create(&create, false).await?;
    if let Err(e) = push_proxy_files(state, &docker, name).await {
        return Err(AppError::Other(format!("容器已重建但未启动：代理配置写入失败（{e}），修复后请手动启动")));
    }
    if was_running {
        let provider_id = state.providers.binding_of(name);
        let provider_body = state.providers.render_settings(provider_id.as_deref())?;
        docker.write_file(name, PROVIDER_FILE, &provider_body, 0o600).await?;
        let usage_body = state.providers.render_usage_settings(provider_id.as_deref())?;
        write_usage_snapshot(&docker, name, &usage_body, false).await?;
        docker.start(name).await?;
    }
    Ok(())
}

/// 从 inspect 结果还原创建表单（用于重建）。
/// 参数：name——容器名；ins——inspect 结果；返回：表单。
pub fn recreate_request(
    name: &str,
    ins: &bollard::models::ContainerInspectResponse,
) -> AppResult<CreateContainerRequest> {
    let cfg = ins.config.clone().unwrap_or_default();
    let hc = ins.host_config.clone().unwrap_or_default();
    let labels = cfg.labels.clone().unwrap_or_default();
    let host_config = labels
        .get(spec::LABEL_HOST_CONFIG_SOURCES)
        .map(|value| {
            serde_json::from_str(value).map_err(|_| AppError::Invalid("容器的宿主配置元数据无效，未进行重建".into()))
        })
        .transpose()?;
    let host_mcp_dir = hc
        .mounts
        .as_ref()
        .and_then(|mounts| {
            mounts.iter().find(|mount| mount.target.as_deref() == Some(crate::docker::host_config::HOST_MCP_TARGET))
        })
        .and_then(|mount| mount.source.clone());
    let mounts = hc
        .binds
        .unwrap_or_default()
        .into_iter()
        .filter_map(|b| {
            // 只保留宿主路径 bind（命名卷由 spec 重新生成）
            let (src, rest) = split_bind(&b)?;
            if !src.contains('/') && !src.contains('\\') {
                return None;
            }
            let (dst, mode) = rest
                .split_once(':')
                .map(|(d, m)| (d.to_string(), m.to_string()))
                .unwrap_or((rest.to_string(), String::new()));
            if dst == crate::docker::host_config::HOST_CONFIG_ROOT
                || dst.starts_with(&format!("{}/", crate::docker::host_config::HOST_CONFIG_ROOT))
            {
                return None;
            }
            Some(spec::ProjectMount { host_path: src, container_path: dst, read_only: mode.contains("ro") })
        })
        .collect();
    let ports = hc
        .port_bindings
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(k, v)| {
            let cp: u16 = k.split('/').next()?.parse().ok()?;
            let hp: u16 = v?.first()?.host_port.as_ref()?.parse().ok()?;
            Some(PortMapping { container_port: cp, host_port: hp, label: String::new() })
        })
        .collect();
    let env = cfg
        .env
        .unwrap_or_default()
        .into_iter()
        .filter(|e| {
            !e.starts_with("TDC_CONTAINER_NAME=")
                && !e.starts_with("TDC_SLOT=")
                && !e.starts_with("TERM=")
                && !e.starts_with("COLORTERM=")
                && !e.starts_with("PATH=")
                && !e.starts_with("NODE_VERSION=")
                && !e.starts_with("YARN_VERSION=")
        })
        .collect();
    Ok(CreateContainerRequest {
        // inspect 中的实际 TZ / LANG / LC_* 已保留在 env，重建时不以新默认值覆盖。
        timezone: None,
        locale: None,
        name: name.to_string(),
        image: cfg.image.unwrap_or_default(),
        cpus: hc.nano_cpus.map(|n| n as f64 / 1e9).unwrap_or(0.0),
        memory_mb: hc.memory.map(|m| (m / 1024 / 1024) as u64).unwrap_or(0),
        auth_mode: labels.get(spec::LABEL_AUTH).cloned().unwrap_or_else(|| "subscription".into()),
        provider_id: labels.get(spec::LABEL_PROVIDER).cloned(),
        mounts,
        // 标签为空串表示未加入共享组；缺失（旧容器）按默认组处理
        shared_group: !labels.get(spec::LABEL_GROUP).is_some_and(|g| g.is_empty()),
        group_name: labels.get(spec::LABEL_GROUP).filter(|g| !g.is_empty() && *g != "default").cloned(),
        ports,
        env,
        slot: labels.get(spec::LABEL_SLOT).and_then(|s| s.parse().ok()).unwrap_or(0),
        working_dir: cfg.working_dir,
        proxy_capable: spec::proxy_capability(ins).granted,
        // 重建沿用 ProxyStore 的绑定，由 push_proxy_files 恢复。
        proxy: None,
        host_config,
        host_mcp_dir,
    })
}

/// 拆分 bind 字符串的源与剩余部分，兼容 Windows 盘符（D:/x:/workspace/app:ro）。
/// 参数：b——bind 字符串；返回：(源, 目标[:模式])。
pub(crate) fn split_bind(b: &str) -> Option<(String, &str)> {
    let bytes = b.as_bytes();
    let start = if bytes.len() > 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' { 2 } else { 0 };
    let idx = b[start..].find(':')? + start;
    Some((b[..idx].to_string(), &b[idx + 1..]))
}

#[cfg(test)]
mod tests {
    use super::{recreate_request, split_bind, usage_snapshot_path};
    use crate::docker::spec::{build_create_body, CreateContainerRequest};

    /// 用创建体模拟 inspect 结果。参数：req——表单；返回：inspect。
    fn inspect_of(req: &CreateContainerRequest) -> bollard::models::ContainerInspectResponse {
        let body = build_create_body(req).unwrap();
        bollard::models::ContainerInspectResponse {
            config: Some(bollard::models::ContainerConfig {
                image: body.image.clone(),
                labels: body.labels.clone(),
                env: body.env.clone(),
                working_dir: body.working_dir.clone(),
                ..Default::default()
            }),
            host_config: body.host_config,
            ..Default::default()
        }
    }

    #[test]
    fn 重建表单保留代理能力与共享组() {
        let mut req: CreateContainerRequest = serde_json::from_value(serde_json::json!({
            "name": "claude-dev-07", "image": "tdc/claude-dev:latest", "authMode": "subscription",
            "groupName": "team-a", "slot": 7
        }))
        .unwrap();
        let r = recreate_request("claude-dev-07", &inspect_of(&req)).unwrap();
        assert!(r.proxy_capable, "默认授予的代理能力在重建后必须保留");
        assert!(r.shared_group);
        assert_eq!(r.group_name.as_deref(), Some("team-a"));

        req.proxy_capable = false;
        req.shared_group = false;
        let r = recreate_request("claude-dev-07", &inspect_of(&req)).unwrap();
        assert!(!r.proxy_capable);
        assert!(!r.shared_group, "未加入共享组的容器重建后不应被加入默认组");
    }

    #[test]
    fn 重建保留时区语言且不产生重复覆盖() {
        let req: CreateContainerRequest = serde_json::from_value(serde_json::json!({
            "name":"region-qa", "image":"tdc/claude-dev:latest", "authMode":"subscription",
            "timezone":"America/New_York", "locale":"en_US.UTF-8"
        }))
        .unwrap();
        let recreated = recreate_request("region-qa", &inspect_of(&req)).unwrap();
        let env = build_create_body(&recreated).unwrap().env.unwrap();
        for value in ["TZ=America/New_York", "LANG=en_US.UTF-8", "LC_ALL=en_US.UTF-8", "LANGUAGE=en_US:en"] {
            assert_eq!(env.iter().filter(|e| e.as_str() == value).count(), 1);
        }
    }

    #[test]
    fn 拆分_bind_兼容盘符() {
        assert_eq!(
            split_bind("D:/Projects/app:/workspace/app:ro"),
            Some(("D:/Projects/app".into(), "/workspace/app:ro"))
        );
        assert_eq!(split_bind("tdc_home_x:/home/node/.claude"), Some(("tdc_home_x".into(), "/home/node/.claude")));
        assert_eq!(split_bind("/home/me/app:/workspace/app"), Some(("/home/me/app".into(), "/workspace/app")));
    }

    #[test]
    fn 运行中用量快照写入待定文件() {
        assert_eq!(usage_snapshot_path(true), crate::usage::PROVIDER_USAGE_PENDING_FILE);
        assert_eq!(usage_snapshot_path(false), crate::usage::PROVIDER_USAGE_FILE);
    }

    #[test]
    fn 重建表单保留宿主来源和受控导出且不重复为项目挂载() {
        let mut req: CreateContainerRequest = serde_json::from_value(serde_json::json!({
            "name":"host-roundtrip", "image":"tdc/claude-dev:latest", "authMode":"subscription",
            "hostConfig":{"skills":"C:/Users/test/.claude/skills", "mcpConfigs":["C:/Users/test/.claude.json"]},
            "mounts":[{"hostPath":"D:/Projects/app", "containerPath":"/workspace/app", "readOnly":true}]
        }))
        .unwrap();
        req.host_mcp_dir = Some("C:/AppData/tdc/host-config/generation".into());
        let recreated = recreate_request(&req.name, &inspect_of(&req)).unwrap();
        assert_eq!(recreated.host_config, req.host_config);
        assert_eq!(recreated.host_mcp_dir, req.host_mcp_dir);
        assert_eq!(recreated.mounts, req.mounts);
        let body = build_create_body(&recreated).unwrap();
        let host = body.host_config.unwrap();
        assert_eq!(host.mounts.as_ref().unwrap().len(), 2);
        assert_eq!(
            host.mounts
                .as_ref()
                .unwrap()
                .iter()
                .filter(|mount| mount.target.as_deref() == Some(crate::docker::host_config::HOST_MCP_TARGET))
                .count(),
            1
        );
        assert!(!host.binds.unwrap().iter().any(|bind| bind.contains(crate::docker::host_config::HOST_CONFIG_ROOT)));
    }
}

#[cfg(test)]
#[path = "container_create_tests.rs"]
mod create_tests;
