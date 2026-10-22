//! Host memory controls: cache reclaim and separately requested WSL compaction.

use tauri::State;

use crate::error::AppResult;
use crate::memory::{
    self, MemoryAnalysis, MemoryCleanupRequest, MemoryCleanupResult, MemoryReclaimResult, MemoryReclaimStatus,
};
use crate::state::AppState;

#[tauri::command]
pub async fn memory_analyze(state: State<'_, AppState>) -> AppResult<MemoryAnalysis> {
    let docker = state.docker().ok();
    memory::analyze(docker.as_ref()).await
}

#[tauri::command]
pub async fn memory_cleanup(
    state: State<'_, AppState>,
    request: MemoryCleanupRequest,
) -> AppResult<MemoryCleanupResult> {
    let docker = state.docker().ok();
    memory::cleanup(docker.as_ref(), request).await
}

#[tauri::command]
pub async fn memory_reclaim_status(state: State<'_, AppState>) -> AppResult<MemoryReclaimStatus> {
    Ok(match state.docker() {
        Ok(docker) => memory::status(&docker).await,
        Err(error) => MemoryReclaimStatus { supported: false, reason: Some(error.to_string()) },
    })
}

#[tauri::command]
pub async fn memory_reclaim(state: State<'_, AppState>) -> AppResult<MemoryReclaimResult> {
    memory::reclaim(&state.docker()?).await
}

#[tauri::command]
pub async fn memory_compact(state: State<'_, AppState>) -> AppResult<MemoryReclaimResult> {
    memory::compact(&state.docker()?).await
}
