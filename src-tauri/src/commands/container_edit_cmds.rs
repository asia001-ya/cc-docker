//! Edit only project mounts, resource limits and the working directory; preserve the full original Docker configuration.
use std::collections::HashSet;
use std::path::Path;

use bollard::models::{ContainerCreateBody, ContainerInspectResponse, Mount, MountBindOptions, MountType};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::container_cmds::{recreate_request, split_bind, Precheck};
use super::host_config_cmds::{self, complete_host_config, HostConfigApplyResult};
use crate::docker::spec::{self, ProjectMount};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContainerEdit {
    pub mounts: Vec<ProjectMount>,
    pub cpus: f64,
    pub memory_mb: u64,
    pub working_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerEditView {
    pub config: ContainerEdit,
    pub image: String,
    pub container_id: String,
    pub running: bool,
    pub affected_sessions: usize,
}

fn normalize_target(target: &str) -> String {
    format!("/{}", target.split('/').filter(|part| !part.is_empty() && *part != ".").collect::<Vec<_>>().join("/"))
}

fn project_target(target: &str) -> bool {
    let target = normalize_target(target);
    !spec::host_config_runtime_overlap(&target)
        && ![spec::CLAUDE_DIR, spec::SHARED_DIR, "/opt/tdc", "/var/lib/tdc", "/proc", "/sys", "/dev"].iter().any(
            |root| {
                target == *root || target.starts_with(&format!("{root}/")) || root.starts_with(&format!("{target}/"))
            },
        )
}

pub(super) fn read_edit(inspect: &ContainerInspectResponse) -> AppResult<ContainerEdit> {
    let host = complete_host_config(inspect)?;
    let mut mounts = Vec::new();
    for bind in host.binds.as_deref().unwrap_or_default() {
        let Some((source, tail)) = split_bind(bind) else { continue };
        let mut parts = tail.split(':');
        let target = parts.next().unwrap_or("");
        if (source.contains('/') || source.contains('\\')) && project_target(target) {
            mounts.push(ProjectMount {
                host_path: source,
                container_path: normalize_target(target),
                read_only: parts.next().is_some_and(|mode| mode.split(',').any(|option| option == "ro")),
            });
        }
    }
    for mount in host.mounts.as_deref().unwrap_or_default() {
        let target = mount.target.as_deref().unwrap_or("");
        if mount.typ == Some(MountType::BIND) && project_target(target) {
            mounts.push(ProjectMount {
                host_path: mount.source.clone().unwrap_or_default(),
                container_path: normalize_target(target),
                read_only: mount.read_only.unwrap_or(false),
            });
        }
    }
    mounts.sort_by(|a, b| a.container_path.cmp(&b.container_path));
    Ok(ContainerEdit {
        mounts,
        cpus: host.nano_cpus.unwrap_or(0) as f64 / 1e9,
        memory_mb: host.memory.unwrap_or(0).max(0) as u64 / 1024 / 1024,
        working_dir: inspect
            .config
            .as_ref()
            .and_then(|config| config.working_dir.clone())
            .filter(|dir| !dir.is_empty())
            .unwrap_or_else(|| "/workspace".into()),
    })
}

fn absolute_container_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.chars().any(|ch| ch.is_control() || ch == ':' || ch == '\\')
        && !path.split('/').any(|part| part == "..")
}

fn validate_edit(inspect: &ContainerInspectResponse, edit: &ContainerEdit) -> AppResult<()> {
    if !edit.cpus.is_finite()
        || !(0.0..=1024.0).contains(&edit.cpus)
        || edit.memory_mb > 1_048_576
        || (edit.memory_mb > 0 && edit.memory_mb < 6)
    {
        return Err(AppError::Invalid("CPU 或内存上限无效（0 表示不限制）".into()));
    }
    if !absolute_container_path(&edit.working_dir) {
        return Err(AppError::Invalid("工作目录必须是容器内的绝对路径".into()));
    }
    let mut targets = HashSet::new();
    let old = read_edit(inspect)?;
    let old_targets: HashSet<_> = old.mounts.iter().map(|mount| mount.container_path.as_str()).collect();
    let host = complete_host_config(inspect)?;
    let reserved: HashSet<_> = host
        .binds
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter_map(|bind| split_bind(bind).map(|(_, tail)| normalize_target(tail.split(':').next().unwrap_or(""))))
        .chain(
            host.mounts
                .as_deref()
                .unwrap_or_default()
                .iter()
                .filter_map(|mount| mount.target.as_deref().map(normalize_target)),
        )
        .chain(host.tmpfs.as_ref().into_iter().flat_map(|values| values.keys().map(|target| normalize_target(target))))
        .filter(|target| !old_targets.contains(target.as_str()))
        .collect();
    for mount in &edit.mounts {
        let target = normalize_target(&mount.container_path);
        if !absolute_container_path(&mount.container_path) || !project_target(&target) || reserved.contains(&target) {
            return Err(AppError::Invalid(format!(
                "挂载目标无效或覆盖了账号、运行时或已有数据卷：{}",
                mount.container_path
            )));
        }
        if !targets.insert(target) {
            return Err(AppError::Invalid(format!("重复的容器挂载路径：{}", mount.container_path)));
        }
        if mount.host_path.trim().is_empty() || mount.host_path.chars().any(char::is_control) {
            return Err(AppError::Invalid("请选择有效的宿主目录".into()));
        }
    }
    Ok(())
}

pub(super) fn apply_edit_to_body(
    inspect: &ContainerInspectResponse,
    body: &mut ContainerCreateBody,
    edit: &ContainerEdit,
) -> AppResult<()> {
    validate_edit(inspect, edit)?;
    let old = read_edit(inspect)?;
    let removed: HashSet<_> = old
        .mounts
        .iter()
        .filter(|mount| !edit.mounts.contains(mount))
        .map(|mount| mount.container_path.as_str())
        .collect();
    let host = body.host_config.get_or_insert_with(Default::default);
    if let Some(binds) = host.binds.as_mut() {
        binds.retain(|bind| {
            !split_bind(bind).is_some_and(|(_, tail)| {
                removed.contains(normalize_target(tail.split(':').next().unwrap_or("")).as_str())
            })
        });
    }
    if let Some(mounts) = host.mounts.as_mut() {
        mounts.retain(|mount| !removed.contains(normalize_target(mount.target.as_deref().unwrap_or("")).as_str()));
    }
    for mount in edit.mounts.iter().filter(|mount| !old.mounts.contains(mount)) {
        host.mounts.get_or_insert_with(Vec::new).push(Mount {
            typ: Some(MountType::BIND),
            source: Some(spec::normalize_host_path(&mount.host_path)),
            target: Some(normalize_target(&mount.container_path)),
            read_only: Some(mount.read_only),
            bind_options: Some(MountBindOptions { create_mountpoint: Some(false), ..Default::default() }),
            ..Default::default()
        });
    }
    if edit.cpus != old.cpus {
        host.nano_cpus = Some((edit.cpus * 1e9) as i64);
        host.cpu_period = None;
        host.cpu_quota = None;
    }
    if edit.memory_mb != old.memory_mb {
        host.memory = Some(edit.memory_mb as i64 * 1024 * 1024);
        if host.memory_swap.is_some_and(|swap| swap > 0 && (edit.memory_mb == 0 || swap < host.memory.unwrap_or(0))) {
            host.memory_swap = None;
        }
    }
    body.working_dir = Some(edit.working_dir.clone());
    Ok(())
}

async fn precheck(
    docker: &crate::docker::client::DockerClient,
    inspect: &ContainerInspectResponse,
    edit: &ContainerEdit,
) -> AppResult<()> {
    host_config_cmds::validate_rebuild_shape(inspect)?;
    validate_edit(inspect, edit)?;
    let old = read_edit(inspect)?;
    if docker.accepts_local_paths() {
        for mount in edit.mounts.iter().filter(|mount| !old.mounts.contains(mount)) {
            if !Path::new(&mount.host_path).is_absolute() || !Path::new(&mount.host_path).is_dir() {
                return Err(AppError::Invalid(format!("宿主目录不存在或不是绝对路径：{}", mount.host_path)));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn container_edit_get(state: State<'_, AppState>, name: String) -> AppResult<ContainerEditView> {
    let inspect = state.docker()?.inspect(&name).await?;
    Ok(ContainerEditView {
        config: read_edit(&inspect)?,
        image: inspect.config.as_ref().and_then(|config| config.image.clone()).unwrap_or_default(),
        container_id: inspect.id.unwrap_or_default(),
        running: inspect.state.and_then(|status| status.running).unwrap_or(false),
        affected_sessions: state
            .sessions
            .list()
            .iter()
            .filter(|session| session.record.container == name && session.alive)
            .count(),
    })
}

#[tauri::command]
pub async fn container_edit_precheck(
    state: State<'_, AppState>,
    name: String,
    config: ContainerEdit,
) -> AppResult<Precheck> {
    let docker = state.docker()?;
    let inspect = docker.inspect(&name).await?;
    let errors =
        precheck(&docker, &inspect, &config).await.err().map(|error| vec![error.to_string()]).unwrap_or_default();
    Ok(Precheck { ok: errors.is_empty(), errors, warnings: Vec::new() })
}

#[tauri::command]
pub async fn container_edit_apply(
    state: State<'_, AppState>,
    name: String,
    config: ContainerEdit,
    expected_container_id: String,
) -> AppResult<HostConfigApplyResult> {
    let _guard = host_config_cmds::rebuild_lock().lock().await;
    let docker = state.docker()?;
    let inspect = docker.inspect(&name).await?;
    host_config_cmds::check_expected_id(&inspect, &expected_container_id)?;
    precheck(&docker, &inspect, &config).await?;
    if read_edit(&inspect)? == config {
        return Ok(HostConfigApplyResult {
            container_id: expected_container_id,
            backup_container: None,
            snapshot_image: None,
            restarted: false,
            mcp_refreshed: false,
            warnings: vec!["配置未变化".into()],
        });
    }
    let request = recreate_request(&name, &inspect)?;
    let result = host_config_cmds::rebuild_candidate_with_edit(
        &docker,
        &name,
        &inspect,
        &request,
        Vec::new(),
        Some(&config),
        || state.sessions.drop_container(&name),
    )
    .await;
    state.wake.notify_one();
    result
}
