//! 壁纸 IPC：大文件复制放在 blocking pool，避免阻塞窗口主线程。

use std::path::Path;

use tauri::State;

use crate::config::wallpaper::{WallpaperAsset, WallpaperKind};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[tauri::command]
pub async fn wallpaper_import(
    state: State<'_, AppState>,
    path: String,
    kind: WallpaperKind,
) -> AppResult<WallpaperAsset> {
    let config = state.config.clone();
    tauri::async_runtime::spawn_blocking(move || config.import_wallpaper(Path::new(&path), kind))
        .await
        .map_err(|error| AppError::Other(format!("壁纸导入任务失败：{error}")))?
}

#[tauri::command]
pub fn wallpaper_resolve(state: State<'_, AppState>, file_name: String) -> AppResult<String> {
    Ok(state.config.resolve_wallpaper(&file_name)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn wallpaper_delete(state: State<'_, AppState>, file_name: String) -> AppResult<()> {
    state.config.delete_wallpaper(&file_name)
}
