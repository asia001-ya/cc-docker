use crate::{
    error::AppResult,
    git_bridge::{Sharing, View},
    state::AppState,
};
use tauri::State;

#[tauri::command]
pub async fn container_git_get(state: State<'_, AppState>, name: String) -> AppResult<View> {
    state.git_bridge.view(&state.docker()?, &name).await
}
#[tauri::command]
pub async fn container_git_apply(
    state: State<'_, AppState>,
    name: String,
    expected_container_id: String,
    config: Sharing,
) -> AppResult<View> {
    state.git_bridge.apply(&state.docker()?, &name, &expected_container_id, config).await
}
