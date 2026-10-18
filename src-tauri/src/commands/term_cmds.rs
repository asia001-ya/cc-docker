//! 终端会话命令与热切换编排。

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::config::store::SessionRecord;
use crate::docker::client::DockerClient;
use crate::error::{AppError, AppResult};
use crate::quota::model::QuotaSnapshot;
use crate::quota::poller::now_secs;
use crate::quota::switch::{rank_candidates, Candidate, QuotaInput};
use crate::state::AppState;
use crate::terminal::manager::{SessionInfo, TermMsg};

/// 新建会话请求。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    /// 会话 ID（为空时后端生成；恢复已有会话时传原 ID）
    #[serde(default)]
    pub id: Option<String>,
    /// 容器名
    pub container: String,
    /// 显示名
    pub title: String,
    /// 工作目录
    #[serde(default)]
    pub cwd: String,
    /// 模式：claude / bash / cmd
    pub mode: String,
    /// 模式参数
    #[serde(default)]
    pub args: Vec<String>,
    /// 环境变量
    #[serde(default)]
    pub env: Vec<String>,
    /// tmux 持久化
    #[serde(default = "default_true")]
    pub tmux: bool,
    /// 初始列数
    pub cols: u16,
    /// 初始行数
    pub rows: u16,
}

/// serde 默认 true。参数：无；返回：true。
fn default_true() -> bool {
    true
}

/// 生成 8 位会话 ID。参数：无；返回：ID。
fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

/// 打开（或恢复）终端会话并持久化元数据。
/// 参数：state——全局状态；req——请求；返回：会话元数据。
#[tauri::command]
pub async fn term_open(state: State<'_, AppState>, req: OpenRequest) -> AppResult<SessionRecord> {
    let id = req.id.filter(|s| !s.is_empty()).unwrap_or_else(new_id);
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(AppError::Invalid("会话 ID 只能包含字母、数字、- 和 _".into()));
    }
    let existing = state.config.sessions().into_iter().find(|r| r.id == id);
    let rec = SessionRecord {
        id,
        container: req.container,
        title: if req.title.trim().is_empty() { "终端".into() } else { req.title },
        cwd: req.cwd,
        mode: req.mode,
        args: req.args,
        env: req.env,
        tmux: req.tmux,
        created_at: existing.map(|e| e.created_at).unwrap_or_else(now_secs),
    };
    state.sessions.open(&state.docker()?, rec.clone(), req.cols, req.rows).await?;
    state.config.upsert_session(rec.clone())?;
    Ok(rec)
}

/// 附着输出 Channel。参数：state——全局状态；id——会话 ID；channel——前端 Channel；返回：成功与否。
#[tauri::command]
pub fn term_attach(state: State<'_, AppState>, id: String, channel: Channel<TermMsg>) -> AppResult<()> {
    state.sessions.attach(&id, channel)
}

/// 解除附着。参数：state——全局状态；id——会话 ID；返回：成功与否。
#[tauri::command]
pub fn term_detach(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.sessions.detach(&id)
}

/// 写入按键。参数：state——全局状态；id——会话 ID；data——文本；返回：成功与否。
#[tauri::command]
pub fn term_write(state: State<'_, AppState>, id: String, data: String) -> AppResult<()> {
    state.sessions.write(&id, &data)
}

/// 粘贴图片的大小上限（与 Claude Code 单图上限同量级，避免误粘超大位图拖慢 IPC）。
const PASTE_IMAGE_MAX: usize = 20 * 1024 * 1024;

/// 由图片 MIME 得到扩展名（只接受 Claude Code 能按路径识别的 png / jpg / gif / webp）。
/// 参数：mime——MIME 类型；返回：扩展名或 Invalid。
fn paste_image_ext(mime: &str) -> AppResult<&'static str> {
    match mime {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/gif" => Ok("gif"),
        "image/webp" => Ok("webp"),
        other => Err(AppError::Invalid(format!("不支持粘贴该图片格式：{other}"))),
    }
}

/// 粘贴图片：把剪贴板图片写入会话所在容器的 /tmp，返回容器内路径，由前端以括号粘贴送入终端。
/// 容器内没有 X 剪贴板，Claude Code 的 Ctrl+V 读图无效；粘贴图片路径则会被识别为图片附件。
/// 请求体为原始图片字节，会话 ID 与 MIME 走请求头（避免把图片编码成 JSON 数组）。
/// 参数：state——全局状态；request——请求（头 x-session-id / x-mime）；返回：容器内文件路径。
#[tauri::command]
pub async fn term_paste_image(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> AppResult<String> {
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    let id = header("x-session-id").ok_or_else(|| AppError::Invalid("缺少会话 ID".into()))?;
    let ext = paste_image_ext(&header("x-mime").unwrap_or_default())?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::Invalid("图片数据格式错误".into()));
    };
    if bytes.is_empty() || bytes.len() > PASTE_IMAGE_MAX {
        return Err(AppError::Invalid(format!("图片大小超出范围（上限 {} MB）", PASTE_IMAGE_MAX / 1024 / 1024)));
    }
    let container = state.sessions.container_of(&id)?;
    let path = format!("/tmp/tdc-paste-{}.{ext}", new_id());
    state.docker()?.write_file(&container, &path, bytes, 0o644).await?;
    Ok(path)
}

/// 调整尺寸。参数：state——全局状态；id——会话 ID；cols / rows——尺寸；返回：成功与否。
#[tauri::command]
pub async fn term_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> AppResult<()> {
    state.sessions.resize(&state.docker()?, &id, cols, rows).await
}

/// 读取容器历史；offset_rows 非空时滚动到距底部指定行数，0 返回实时输出。
#[tauri::command]
pub async fn term_scrollback(
    state: State<'_, AppState>,
    id: String,
    offset_rows: Option<u32>,
) -> AppResult<crate::terminal::scroll::ScrollbackState> {
    state.sessions.scrollback(&state.docker()?, &id, offset_rows).await
}

/// 关闭会话（结束容器内 tmux 会话）。参数：state——全局状态；id——会话 ID；返回：成功与否。
#[tauri::command]
pub async fn term_close(state: State<'_, AppState>, id: String) -> AppResult<()> {
    if let Ok(docker) = state.docker() {
        state.sessions.close(&docker, &id).await?;
    }
    state.config.remove_session(&id)
}

/// 重命名会话。参数：state——全局状态；id——会话 ID；title——新名称；返回：新元数据。
#[tauri::command]
pub fn term_rename(state: State<'_, AppState>, id: String, title: String) -> AppResult<SessionRecord> {
    let mut rec = state
        .config
        .sessions()
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| AppError::NotFound(format!("会话 {id}")))?;
    rec.title = title.trim().to_string();
    state.config.upsert_session(rec.clone())?;
    state.sessions.update_record(rec.clone());
    Ok(rec)
}

/// 列出持久化的会话记录（应用启动时用于恢复 Tab）。参数：state——全局状态；返回：记录列表。
#[tauri::command]
pub fn term_records(state: State<'_, AppState>) -> Vec<SessionRecord> {
    state.config.sessions()
}

/// 列出运行时会话。参数：state——全局状态；返回：会话信息。
#[tauri::command]
pub fn term_list(state: State<'_, AppState>) -> Vec<SessionInfo> {
    state.sessions.list()
}

/// 由当前汇总构造算法输入。参数：state——全局状态；返回：容器视图列表。
fn quota_inputs(state: &AppState) -> Vec<QuotaInput> {
    state
        .poller
        .lock()
        .fleet
        .entries
        .iter()
        .map(|e| QuotaInput {
            name: e.container.name.clone(),
            running: e.container.running,
            auth_mode: e
                .provider
                .as_ref()
                .map(|p| p.mode.clone())
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| e.container.auth_mode.clone()),
            quota: e.quota.clone(),
            limit_hit: e.limit_hit,
        })
        .collect()
}

/// 计算热切换候选。参数：state——全局状态；source——源容器；返回：排序后的候选。
#[tauri::command]
pub fn switch_candidates(state: State<'_, AppState>, source: String) -> Vec<Candidate> {
    let settings = state.config.settings().quota;
    rank_candidates(&quota_inputs(&state), &source, now_secs(), &settings)
}

/// 热切换结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchResult {
    /// 目标容器中的新会话
    pub session: SessionRecord,
    /// 被恢复的 Claude 会话 ID（None 表示未能继承对话，仅以相同目录新开 claude）
    pub resumed: Option<String>,
    /// 源会话退出方式：exit / term / kill / none
    pub stop_method: String,
    /// 提示信息
    pub notes: Vec<String>,
}

/// 热切换请求。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchRequest {
    /// 源会话 ID
    pub session_id: String,
    /// 目标容器
    pub target: String,
    /// 终端尺寸
    pub cols: u16,
    /// 终端尺寸
    pub rows: u16,
}

/// 执行热切换：预检目标路径与可恢复历史 → 源容器优雅退出 claude → 目标容器 `claude --resume`。
/// 参数：state——全局状态；req——请求；返回：切换结果。
#[tauri::command]
pub async fn switch_execute(state: State<'_, AppState>, req: SwitchRequest) -> AppResult<SwitchResult> {
    let docker = state.docker()?;
    let src = state
        .config
        .sessions()
        .into_iter()
        .find(|r| r.id == req.session_id)
        .ok_or_else(|| AppError::NotFound(format!("会话 {}", req.session_id)))?;
    if src.container == req.target {
        return Err(AppError::Invalid("目标容器不能与源容器相同".into()));
    }
    if src.mode != "claude" {
        return Err(AppError::Invalid("额度热切换只支持 Claude 会话".into()));
    }

    // 先确认源容器仍在运行，避免对已停止容器发起控制命令并无谓启动目标。
    let source = docker.get(&src.container).await?;
    if !source.running {
        return Err(AppError::Invalid(format!("源容器 {} 未运行，无法热切换会话", src.container)));
    }

    // 目标容器必须先通过工作目录检查，再停止源会话。否则目标挂载错误时，
    // 源 Claude 已经退出，用户只会得到一个停在 shell 上的半完成切换。
    let source_info = docker.tdc_ctl(&src.container, &["session-info", &src.id]).await.ok().filter(|v| !v.is_null());
    let preflight_cwd = source_info
        .as_ref()
        .and_then(|v| v["cwd"].as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .or_else(|| (!src.cwd.trim().is_empty()).then(|| src.cwd.clone()))
        .unwrap_or_else(|| "/workspace".into());
    let preflight_session_id = source_info
        .as_ref()
        .and_then(|v| v["session_id"].as_str())
        .and_then(valid_resume_id)
        .or_else(|| resume_arg(&src.args).and_then(valid_resume_id))
        .map(str::to_string);

    let target = docker.get(&req.target).await?;
    if !target.running {
        docker.start(&req.target).await?;
    }
    let dir_ok = docker.exec(&req.target, &["test", "-d", &preflight_cwd], None).await?.exit_code == Some(0);
    if !dir_ok {
        return Err(AppError::Invalid(format!(
            "目标容器 {} 中不存在目录 {preflight_cwd}：两容器需要在相同路径挂载同一项目",
            req.target
        )));
    }

    let mut notes = Vec::new();
    let mut preflight_history_missing = false;
    if let Some(sid) = &preflight_session_id {
        if !target_has_resume_file(&docker, &req.target, sid).await? {
            preflight_history_missing = true;
        }
    }

    // 1. 源容器：优雅退出 claude，取最后已知 session_id 与 cwd
    let stop = docker.tdc_ctl(&src.container, &["session-stop", &src.id, "5"]).await?;
    let stop_method = stop["method"].as_str().unwrap_or("none").to_string();
    // session_id 来自容器输出，后续会拼进 sh -c，必须是安全的文件名字符
    let stopped_session_id = stop["session_id"].as_str().and_then(valid_resume_id).map(str::to_string);
    // 优先使用停止命令返回的最新 ID；它可能是在预检后才由 statusline 写入，
    // 因此下面会对这个新 ID 再做一次目标文件检查。没有新 ID 时才回退预检值。
    let mut session_id = if preflight_history_missing {
        stopped_session_id
    } else {
        stopped_session_id.or(preflight_session_id.clone())
    };
    // statusline 可能尚未把本次 Claude 会话写回 sessions/<id>.json；恢复已有
    // 会话时，持久化的启动参数仍然保留 --resume <id>，可作为安全回退。
    if session_id.is_none() && !preflight_history_missing {
        session_id = resume_arg(&src.args).and_then(valid_resume_id).map(str::to_string);
    }
    if preflight_history_missing && session_id.is_none() {
        notes.push("目标容器未共享会话卷（tdc_shared_projects），无法继承对话，已在相同目录新开 claude".into());
    }
    // 使用停止前已经通过目标目录校验的路径，避免 session-stop 读取到更新中的
    // statusline 后把目标会话静默回退到 /workspace。
    let cwd = preflight_cwd;

    // 2. 目标容器：校验停止后最终使用的工作目录与会话文件
    if let Some(sid) = &session_id {
        // 已在停止源会话前校验过同一个 ID；只有 statusline 返回了新的 ID 才需要再查一次。
        let found = if preflight_session_id.as_deref() == Some(sid.as_str()) && !preflight_history_missing {
            true
        } else {
            target_has_resume_file(&docker, &req.target, sid).await?
        };
        if !found {
            notes.push("目标容器未共享会话卷（tdc_shared_projects），无法继承对话，已在相同目录新开 claude".into());
            session_id = None;
        }
    } else if !preflight_history_missing {
        notes.push("源会话尚未产生 Claude 会话 ID（statusline 未刷新过），已在相同目录新开 claude".into());
    }
    notes.push("切换后首轮请求没有 prompt cache，会按完整上下文计费".into());

    // 3. 目标容器新开会话
    let args = session_id.as_ref().map(|s| vec!["--resume".to_string(), s.clone()]).unwrap_or_default();
    let title = format!("{}（自 {} 切换）", strip_prefix_title(&src.title), src.container);
    let rec = SessionRecord {
        id: new_id(),
        container: req.target.clone(),
        title,
        cwd,
        mode: "claude".into(),
        args,
        env: src.env.clone(),
        tmux: src.tmux,
        created_at: now_secs(),
    };
    state.sessions.open(&docker, rec.clone(), req.cols, req.rows).await?;
    state.config.upsert_session(rec.clone())?;
    // 4. 源会话已迁移：结束其 tmux 会话（claude 已退出，只剩回落 shell）并删除记录，避免下次启动被恢复
    let _ = state.sessions.close(&docker, &src.id).await;
    let _ = state.config.remove_session(&src.id);
    state.wake.notify_one();
    Ok(SwitchResult { session: rec, resumed: session_id, stop_method, notes })
}

/// 检查目标容器是否存在指定 Claude transcript。
/// 参数：docker——客户端；container——目标容器；session_id——Claude 会话 ID；返回：是否存在。
async fn target_has_resume_file(docker: &DockerClient, container: &str, session_id: &str) -> AppResult<bool> {
    let script = format!("ls \"$CLAUDE_CONFIG_DIR\"/projects/*/{session_id}.jsonl >/dev/null 2>&1");
    Ok(docker.exec(container, &["sh", "-c", &script], None).await?.exit_code == Some(0))
}

/// 接受 Claude transcript 文件名可用的会话 ID。
/// 参数：value——候选 ID；返回：合法 ID 或 None。
fn valid_resume_id(value: &str) -> Option<&str> {
    let first_is_alphanumeric = value.as_bytes().first().is_some_and(|c| c.is_ascii_alphanumeric());
    (first_is_alphanumeric
        && value.len() <= 64
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    .then_some(value)
}

/// 从启动参数中取出 `--resume <id>` 或 `--resume=<id>`。
/// 参数：args——Claude 启动参数；返回：候选 ID。
fn resume_arg(args: &[String]) -> Option<&str> {
    args.windows(2)
        .find_map(|pair| (pair[0] == "--resume").then_some(pair[1].as_str()))
        .or_else(|| args.iter().find_map(|arg| arg.strip_prefix("--resume=")))
}

/// 去掉标题中已有的"（自 xxx 切换）"后缀，避免多次切换后标题无限增长。
/// 参数：t——标题；返回：精简后的标题。
fn strip_prefix_title(t: &str) -> &str {
    t.split("（自 ").next().unwrap_or(t).trim()
}

/// 调试：注入额度快照（仅 debug 构建可用，用于模拟额度耗尽）。
/// 参数：state——全局状态；container——容器名；quota——快照（None 清除注入）；返回：成功与否。
#[tauri::command]
pub fn debug_inject_quota(
    state: State<'_, AppState>,
    container: String,
    quota: Option<QuotaSnapshot>,
) -> AppResult<()> {
    if !cfg!(debug_assertions) {
        return Err(AppError::Invalid("仅开发构建可用".into()));
    }
    let mut p = state.poller.lock();
    match quota {
        Some(q) => p.injected.insert(container, q),
        None => p.injected.remove(&container),
    };
    drop(p);
    state.wake.notify_one();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{paste_image_ext, resume_arg, strip_prefix_title, valid_resume_id};

    #[test]
    fn 多次切换标题不累积() {
        assert_eq!(strip_prefix_title("前端开发 #1（自 claude-dev-01 切换）"), "前端开发 #1");
        assert_eq!(strip_prefix_title("后端"), "后端");
    }

    #[test]
    fn 粘贴图片只接受可按路径识别的格式() {
        assert_eq!(paste_image_ext("image/png").unwrap(), "png");
        assert_eq!(paste_image_ext("image/jpeg").unwrap(), "jpg");
        assert_eq!(paste_image_ext("image/webp").unwrap(), "webp");
        assert!(paste_image_ext("image/bmp").is_err());
        assert!(paste_image_ext("").is_err());
    }

    #[test]
    fn 恢复会话参数可作为状态文件回退() {
        let args = vec!["--resume".into(), "abc-123".into(), "--verbose".into()];
        assert_eq!(resume_arg(&args), Some("abc-123"));
        assert_eq!(resume_arg(&["--resume=def_456".into()]), Some("def_456"));
        assert_eq!(resume_arg(&["--resume".into()]), None);
    }

    #[test]
    fn 恢复会话_id_只接受安全文件名字符() {
        assert_eq!(valid_resume_id("abc-123_456"), Some("abc-123_456"));
        assert!(valid_resume_id("../secret").is_none());
        assert!(valid_resume_id("--verbose").is_none());
        assert!(valid_resume_id("").is_none());
        assert!(valid_resume_id(&"a".repeat(65)).is_none());
    }
}
