use tauri::{Emitter, State};

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::usage::model::{UsageQuery, UsageResult};

/// 用量采集协议文件。容器内的 `tdc-ctl usage` 仅在支持精确采集的镜像中可用。
const PROVIDER_USAGE_FILE: &str = crate::usage::PROVIDER_USAGE_FILE;
const PROVIDER_USAGE_PENDING_FILE: &str = crate::usage::PROVIDER_USAGE_PENDING_FILE;

#[tauri::command]
pub fn usage_query(state: State<'_, AppState>, query: UsageQuery) -> AppResult<UsageResult> {
    state.usage.query_with_pricing(&query, &state.providers.pricing_snapshot())
}

#[tauri::command]
pub async fn usage_refresh(state: State<'_, AppState>, app: tauri::AppHandle) -> AppResult<()> {
    let docker = state.docker.read().clone();
    crate::usage::collector::refresh(docker.as_ref(), &state.usage).await;
    let _ = app.emit("usage://update", ());
    Ok(())
}

/// 为已有容器启用精确用量采集。
///
/// 新建或重新启动的容器会在生命周期流程中自动写入该文件；此命令用于
/// 兼容已经存在的容器。先探测镜像是否支持 `tdc-ctl usage`，避免在旧镜像
/// 中留下一个看似启用、实际上无法读取的 provider 快照。
#[tauri::command]
pub async fn usage_enable(state: State<'_, AppState>, container: String) -> AppResult<()> {
    let docker = state.docker()?;
    let info = docker.get(&container).await?;
    if info.running {
        let probe = docker
            .tdc_ctl(&container, &["usage"])
            .await
            .map_err(|e| AppError::Invalid(format!("容器镜像不支持精确用量采集，请重建最新版标准镜像：{e}")))?;
        if probe.get("supported").and_then(|v| v.as_bool()) != Some(true) {
            return Err(AppError::Invalid("容器镜像不支持精确用量采集，请重建最新版标准镜像".into()));
        }
    }
    let provider = state.providers.binding_of(&container).or(info.provider_id);
    let body = state.providers.render_usage_settings(provider.as_deref())?;
    if !info.running {
        // Keep the pending copy ahead of the active copy so a partial write
        // cannot leave an old pending snapshot that later overwrites a fresh
        // active snapshot at the next Claude launch.
        docker.write_file(&container, PROVIDER_USAGE_PENDING_FILE, &body, 0o600).await?;
    }
    let path = if info.running { PROVIDER_USAGE_PENDING_FILE } else { PROVIDER_USAGE_FILE };
    docker.write_file(&container, path, &body, 0o600).await?;
    Ok(())
}
