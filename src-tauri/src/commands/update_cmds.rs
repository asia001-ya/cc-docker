//! 更新命令不接受 URL、路径或安装参数，所有来源由后端固定。
use crate::error::AppResult;
use crate::updates::{UpdateManager, UpdateStatus};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn update_status(updates: State<'_, Arc<UpdateManager>>) -> UpdateStatus {
    updates.status()
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle, updates: State<'_, Arc<UpdateManager>>) -> AppResult<UpdateStatus> {
    updates.check(&app).await
}

#[tauri::command]
pub async fn update_download(app: tauri::AppHandle, updates: State<'_, Arc<UpdateManager>>) -> AppResult<UpdateStatus> {
    updates.download(&app).await
}

#[tauri::command]
pub async fn update_install(app: tauri::AppHandle, updates: State<'_, Arc<UpdateManager>>) -> AppResult<()> {
    let manager = updates.inner().clone();
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || manager.start_install(&handle, true))
        .await
        .map_err(|_| crate::error::AppError::Other("启动更新助手失败".into()))??;
    app.exit(0);
    Ok(())
}
