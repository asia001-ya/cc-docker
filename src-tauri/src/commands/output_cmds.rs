//! Read-only access to the active terminal's Claude transcript; never accept arbitrary frontend paths.
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tauri::State;
use crate::{error::{AppError, AppResult}, state::AppState};

const SCRIPT: &str = include_str!("../terminal/output-reader.mjs");

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputItem {
    id: String,
    kind: String,
    file_path: String,
    title: String,
    markdown: String,
    timestamp: Option<String>,
    truncated: bool,
    revision: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSnapshot {
    conversation_id: Option<String>,
    status: String,
    revision: Option<String>,
    items: Option<Vec<OutputItem>>,
    limited: bool,
}

/// Mapping and paths come from persisted terminal metadata and the container's statusline snapshot.
#[tauri::command]
pub async fn term_outputs(state: State<'_, AppState>, id: String, revision: Option<String>) -> AppResult<OutputSnapshot> {
    let rec = state.config.sessions().into_iter().find(|r| r.id == id)
        .ok_or_else(|| AppError::NotFound(format!("会话 {id}")))?;
    let env_value = |key: &str| rec.env.iter().rev().find_map(|kv| kv.strip_prefix(&format!("{key}="))).map(str::to_string);
    let fallback = rec.args.windows(2).find_map(|args| matches!(args[0].as_str(), "--resume" | "-r").then_some(args[1].as_str()))
        .or_else(|| rec.args.iter().find_map(|arg| arg.strip_prefix("--resume=")));
    let request = serde_json::json!({ "tdcId": rec.id, "fallbackId": fallback, "cwd": rec.cwd,
        "configDir": env_value("CLAUDE_CONFIG_DIR"), "stateDir": env_value("TDC_STATE_DIR"), "revision": revision });
    let data = request.to_string();
    let result = state.docker()?.exec_as(&rec.container, crate::docker::spec::APP_USER,
        &["node", "--input-type=module", "-e", SCRIPT, "--", "--tdc-output-reader", &data], None, Duration::from_secs(8)).await?;
    if result.exit_code != Some(0) { return Err(AppError::Other("暂时无法读取此会话的输出内容".into())); }
    serde_json::from_str(&result.stdout).map_err(|_| AppError::Other("会话输出格式无法识别".into()))
}
