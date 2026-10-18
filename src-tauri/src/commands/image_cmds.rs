//! 标准镜像命令：查询默认镜像是否就绪、在应用内构建（首次启动引导与新建容器共用）。

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::docker::image_build;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 事件：构建输出一行。
pub const EVT_IMAGE_BUILD_LINE: &str = "image://build-line";
/// 事件：构建结束（成功或失败）。
pub const EVT_IMAGE_BUILD_DONE: &str = "image://build-done";

/// 默认镜像状态。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageStatus {
    /// 设置中的默认镜像名
    pub image: String,
    /// 本地是否存在
    pub exists: bool,
    /// 是否正在构建
    pub building: bool,
    /// 最近的构建输出
    pub log: Vec<String>,
    /// 上次构建失败的原因
    pub error: Option<String>,
}

/// 查询默认镜像状态。参数：state——全局状态；返回：状态（Docker 未连接时报错）。
#[tauri::command]
pub async fn image_status(state: State<'_, AppState>) -> AppResult<ImageStatus> {
    let image = state.config.settings().docker.default_image;
    let exists = state.docker()?.image_exists(&image).await;
    let tracker = state.image_build.lock();
    Ok(ImageStatus {
        image,
        exists,
        building: tracker.running,
        log: tracker.log.iter().cloned().collect(),
        error: tracker.error.clone(),
    })
}

/// 构建默认镜像（使用应用内置的构建上下文）。构建在独立任务中进行：前端刷新或弹框关闭都不会中断，
/// 期间每行输出发 image://build-line，结束发 image://build-done。
/// 参数：app——应用句柄；state——全局状态；返回：构建结果。
#[tauri::command]
pub async fn image_build(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    let image = state.config.settings().docker.default_image;
    let docker = state.docker()?;
    docker.engine_info().await?;
    if !state.image_build.lock().start() {
        return Err(AppError::Invalid("镜像正在构建中，请等待完成".into()));
    }
    let tracker = state.image_build.clone();
    let wake = state.wake.clone();
    let task = tauri::async_runtime::spawn(async move {
        let result = image_build::build_standard_image(&docker, &image, |line| {
            tracker.lock().push(line.clone());
            let _ = app.emit(EVT_IMAGE_BUILD_LINE, serde_json::json!({ "line": line }));
        })
        .await;
        let error = result.as_ref().err().map(|e| e.to_string());
        tracker.lock().finish(error.clone());
        let _ = app.emit(EVT_IMAGE_BUILD_DONE, serde_json::json!({ "ok": error.is_none(), "error": error }));
        wake.notify_one();
        result
    });
    task.await.map_err(|e| AppError::Other(format!("镜像构建任务异常退出：{e}")))?
}
