//! 终端会话管理器：后端持有全部 docker exec 会话（真相源），前端仅附着显示。
//!
//! 数据流：
//!   docker exec (tty) ──字节──▶ pump 任务 ──▶ Ring（回放） + LimitDetector（限额识别） + Channel（前端）
//!   前端按键 ──invoke term_write──▶ exec stdin
//! 会话内部运行 `tdc-session <id> <cwd> <mode>`：默认包在 tmux 中，应用重启后执行同一命令即可重新附着。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use bollard::exec::{ResizeExecOptions, StartExecOptions, StartExecResults};
use bollard::models::ExecConfig;
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use super::detect::LimitDetector;
use super::ring::{split_utf8, Ring};
use crate::config::store::SessionRecord;
use crate::docker::client::DockerClient;
use crate::error::{AppError, AppResult};

/// 环形缓冲容量（字节）。
const RING_CAP: usize = 512 * 1024;
/// 刷帧间隔。
const FLUSH_INTERVAL: Duration = Duration::from_millis(12);
/// 刷帧字节阈值。
const FLUSH_BYTES: usize = 64 * 1024;

/// 事件：会话退出。
pub const EVT_SESSION_EXIT: &str = "term://exit";
/// 事件：检测到限额提示。
pub const EVT_LIMIT_HIT: &str = "quota://limit-hit";

/// Channel 推送给前端的终端消息。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TermMsg {
    /// 附着后的第一条：环形缓冲回放
    Snapshot { data: String },
    /// 实时输出
    Data { data: String },
    /// 会话结束
    Exit { code: Option<i64> },
}

/// 会话状态（供前端列表 / 状态栏展示）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// 会话元数据
    #[serde(flatten)]
    pub record: SessionRecord,
    /// exec 是否仍在运行
    pub alive: bool,
    /// 是否有前端附着
    pub attached: bool,
}

/// 退出事件载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitPayload {
    /// 会话 ID
    pub session_id: String,
    /// 容器名
    pub container: String,
    /// 退出码
    pub code: Option<i64>,
}

/// 限额命中事件载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitHitPayload {
    /// 会话 ID
    pub session_id: String,
    /// 容器名
    pub container: String,
    /// 命中的文本
    pub text: String,
}

/// 单个会话的运行时状态。
struct Live {
    record: SessionRecord,
    exec_id: String,
    input: mpsc::UnboundedSender<Vec<u8>>,
    ring: Ring,
    sink: Option<Channel<TermMsg>>,
    alive: bool,
    /// 串行化同一会话的历史查询与拖动，避免较早请求覆盖最终位置。
    scroll_lock: Arc<tokio::sync::Mutex<Option<super::scroll::ScrollConnection>>>,
}

/// 会话管理器。
#[derive(Clone)]
pub struct SessionManager {
    app: AppHandle,
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<Live>>>>>,
    limit_patterns: Arc<Mutex<Vec<String>>>,
}

impl SessionManager {
    /// 创建管理器。参数：app——Tauri 句柄；patterns——限额正则；返回：管理器。
    pub fn new(app: AppHandle, patterns: Vec<String>) -> Self {
        Self { app, sessions: Arc::default(), limit_patterns: Arc::new(Mutex::new(patterns)) }
    }

    /// 更新限额正则（设置变更时调用，对新会话生效）。参数：patterns——正则列表；返回：无。
    pub fn set_limit_patterns(&self, patterns: Vec<String>) {
        *self.limit_patterns.lock() = patterns;
    }

    /// 启动（或重新附着）一个容器终端会话。
    /// 参数：docker——客户端；rec——会话元数据；cols / rows——初始尺寸；返回：成功与否。
    pub async fn open(&self, docker: &DockerClient, rec: SessionRecord, cols: u16, rows: u16) -> AppResult<()> {
        if let Some(existing) = self.sessions.lock().get(&rec.id) {
            if existing.lock().alive {
                return Ok(());
            }
        }
        let cmd = build_command(&rec);
        let created = docker
            .raw()
            .create_exec(
                &rec.container,
                ExecConfig {
                    attach_stdin: Some(true),
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    tty: Some(true),
                    // 创建 PTY 时就提供尺寸；启动后 resize 无法阻止错误尺寸的首屏输出。
                    console_size: Some(console_size(cols, rows)),
                    env: Some(vec![
                        "TERM=xterm-256color".into(),
                        "COLORTERM=truecolor".into(),
                        format!("TDC_SESSION_ID={}", rec.id),
                    ]),
                    cmd: Some(cmd),
                    working_dir: Some(rec.cwd.clone()).filter(|c| !c.is_empty()),
                    // 镜像入口为 root：终端必须以 node 运行（claude 拒绝 root；tmux socket 按 uid 区分）
                    user: Some(crate::docker::spec::APP_USER.to_string()),
                    ..Default::default()
                },
            )
            .await?;
        let started = docker
            .raw()
            .start_exec(
                &created.id,
                Some(StartExecOptions { detach: false, tty: true, output_capacity: Some(64 * 1024) }),
            )
            .await?;
        let StartExecResults::Attached { output, input } = started else {
            return Err(AppError::Docker("exec 未能附着".into()));
        };
        let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let live = Arc::new(Mutex::new(Live {
            record: rec.clone(),
            exec_id: created.id.clone(),
            input: tx,
            ring: Ring::new(RING_CAP),
            sink: None,
            alive: true,
            scroll_lock: Arc::new(tokio::sync::Mutex::new(None)),
        }));
        self.sessions.lock().insert(rec.id.clone(), live.clone());

        tokio::spawn(write_loop(input, rx));
        let detector = LimitDetector::new(&self.limit_patterns.lock());
        tokio::spawn(pump(self.app.clone(), docker.clone(), live, output, detector));
        Ok(())
    }

    /// 前端附着：先回放环形缓冲，再持续推送。
    /// 参数：id——会话 ID；channel——前端 Channel；返回：成功与否。
    pub fn attach(&self, id: &str, channel: Channel<TermMsg>) -> AppResult<()> {
        let live = self.get(id)?;
        let mut g = live.lock();
        let snapshot = String::from_utf8_lossy(&g.ring.snapshot()).into_owned();
        let _ = channel.send(TermMsg::Snapshot { data: snapshot });
        if !g.alive {
            let _ = channel.send(TermMsg::Exit { code: None });
        }
        g.sink = Some(channel);
        Ok(())
    }

    /// 前端解除附着（会话继续运行）。参数：id——会话 ID；返回：成功与否。
    pub fn detach(&self, id: &str) -> AppResult<()> {
        self.get(id)?.lock().sink = None;
        Ok(())
    }

    /// 写入按键。参数：id——会话 ID；data——UTF-8 文本；返回：成功与否。
    pub fn write(&self, id: &str, data: &str) -> AppResult<()> {
        let live = self.get(id)?;
        let g = live.lock();
        if !g.alive {
            return Err(AppError::Invalid("会话已结束".into()));
        }
        g.input.send(data.as_bytes().to_vec()).map_err(|_| AppError::Other("会话输入通道已关闭".into()))
    }

    /// 调整终端尺寸。参数：docker——客户端；id——会话 ID；cols / rows——尺寸；返回：成功与否。
    pub async fn resize(&self, docker: &DockerClient, id: &str, cols: u16, rows: u16) -> AppResult<()> {
        let exec_id = self.get(id)?.lock().exec_id.clone();
        docker.raw().resize_exec(&exec_id, ResizeExecOptions { width: cols.max(2), height: rows.max(2) }).await?;
        Ok(())
    }

    /// 关闭会话：结束容器内 tmux 会话（若有）并移除。
    /// 参数：docker——客户端；id——会话 ID；返回：成功与否。
    pub async fn close(&self, docker: &DockerClient, id: &str) -> AppResult<()> {
        let removed = self.sessions.lock().remove(id);
        if let Some(live) = removed {
            let (container, tmux) = {
                let g = live.lock();
                (g.record.container.clone(), g.record.tmux)
            };
            if tmux {
                let target = format!("tdc-{id}");
                let _ = docker.exec(&container, &["tmux", "kill-session", "-t", &target], None).await;
            } else {
                // 无 tmux 时发送 Ctrl-D 让 shell 退出
                let _ = live.lock().input.send(vec![4]);
            }
        }
        Ok(())
    }

    /// 仅断开前端与 exec（容器停止 / 删除时调用，不触碰 tmux）。参数：container——容器名；返回：无。
    pub fn drop_container(&self, container: &str) {
        self.sessions.lock().retain(|_, live| live.lock().record.container != container);
    }

    /// 更新会话元数据（重命名）。参数：rec——新元数据；返回：无。
    pub fn update_record(&self, rec: SessionRecord) {
        if let Some(live) = self.sessions.lock().get(&rec.id) {
            live.lock().record = rec;
        }
    }

    /// 读取会话所属容器名。参数：id——会话 ID；返回：容器名或 NotFound。
    pub fn container_of(&self, id: &str) -> AppResult<String> {
        Ok(self.get(id)?.lock().record.container.clone())
    }

    /// 查询或设置 tmux 历史位置；只有明确设置 offset 时才改变容器视口。
    pub async fn scrollback(
        &self,
        docker: &DockerClient,
        id: &str,
        offset_rows: Option<u32>,
    ) -> AppResult<super::scroll::ScrollbackState> {
        let (container, lock) = {
            let live = self.get(id)?;
            let g = live.lock();
            if !g.alive || !g.record.tmux {
                return Err(AppError::Invalid("该会话没有可用的 tmux 历史".into()));
            }
            (g.record.container.clone(), g.scroll_lock.clone())
        };
        let mut connection = lock.lock().await;
        super::scroll::scrollback(&mut connection, docker, &container, id, offset_rows).await
    }

    /// 列出运行时会话。参数：无；返回：会话信息列表。
    pub fn list(&self) -> Vec<SessionInfo> {
        self.sessions
            .lock()
            .values()
            .map(|l| {
                let g = l.lock();
                SessionInfo { record: g.record.clone(), alive: g.alive, attached: g.sink.is_some() }
            })
            .collect()
    }

    /// 读取会话。参数：id——会话 ID；返回：共享句柄或 NotFound。
    fn get(&self, id: &str) -> AppResult<Arc<Mutex<Live>>> {
        self.sessions.lock().get(id).cloned().ok_or_else(|| AppError::NotFound(format!("会话 {id}")))
    }
}

/// Claude Code 检测到 tmux 时会主动降为 256 色（除非设置此变量）；tdc 的 tmux 已开启 RGB 透传，因此强制真彩，
/// 让主题色与 Windows Terminal 中一致。经 tmux new-session -e 注入，旧镜像的已有容器同样生效。
const TMUX_TRUECOLOR_ENV: &str = "CLAUDE_CODE_TMUX_TRUECOLOR=1";
const REATTACH_SCRIPT: &str = include_str!("reattach.sh");

fn console_size(cols: u16, rows: u16) -> Vec<usize> {
    vec![rows.max(2) as usize, cols.max(2) as usize]
}

/// 生成容器内启动命令。
/// 参数：rec——会话元数据；返回：argv。
pub fn build_command(rec: &SessionRecord) -> Vec<String> {
    let mut cmd = vec!["/opt/tdc/tdc-session.sh".to_string()];
    // 全屏重绘不会把长回答的旧画面追加到 tmux 历史；对话滚动由 Claude 管理。
    // 后面的用户 env 可以显式覆盖；启动时注入也兼容已有容器的旧脚本。
    if rec.mode == "claude" {
        cmd.push("-e".into());
        cmd.push("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=0".into());
        cmd.push("-e".into());
        cmd.push("CLAUDE_CODE_NO_FLICKER=1".into());
    }
    if rec.tmux {
        cmd.push("-e".into());
        cmd.push(TMUX_TRUECOLOR_ENV.into());
    }
    for kv in rec.env.iter().filter(|kv| kv.contains('=') && !kv.starts_with('=')) {
        cmd.push("-e".into());
        cmd.push(kv.clone());
    }
    if !rec.tmux {
        cmd.push("--no-tmux".into());
    }
    cmd.push(rec.id.clone());
    cmd.push(if rec.cwd.is_empty() { "/workspace".into() } else { rec.cwd.clone() });
    cmd.push(rec.mode.clone());
    cmd.extend(rec.args.iter().cloned());
    if rec.tmux {
        // Docker exec 的旧 tmux 客户端可能在外壳退出后继续存活。
        // 独占重连只替换客户端，不结束 pane 中的 Claude，也兼容旧镜像脚本。
        let mut attach = vec!["sh".into(), "-c".into(), REATTACH_SCRIPT.into(), "tdc-attach".into(), format!("=tdc-{}", rec.id)];
        attach.extend(cmd);
        return attach;
    }
    cmd
}

/// 输入写循环：串行写入 exec stdin。
/// 参数：input——exec 输入流；rx——按键队列；返回：无。
async fn write_loop(mut input: std::pin::Pin<Box<dyn AsyncWrite + Send>>, mut rx: mpsc::UnboundedReceiver<Vec<u8>>) {
    while let Some(data) = rx.recv().await {
        if input.write_all(&data).await.is_err() {
            break;
        }
        let _ = input.flush().await;
    }
}

/// 输出泵：聚合刷帧，写 Ring、做限额识别、推送 Channel；exec 结束后发退出事件。
/// 参数：app——Tauri 句柄；docker——客户端；live——会话；output——exec 输出流；detector——限额识别器；返回：无。
async fn pump(
    app: AppHandle,
    docker: DockerClient,
    live: Arc<Mutex<Live>>,
    mut output: std::pin::Pin<
        Box<dyn futures_util::Stream<Item = Result<bollard::container::LogOutput, bollard::errors::Error>> + Send>,
    >,
    mut detector: LimitDetector,
) {
    let mut pending: Vec<u8> = Vec::new();
    let mut carry: Vec<u8> = Vec::new();
    let mut last = Instant::now();
    let (id, container) = {
        let g = live.lock();
        (g.record.id.clone(), g.record.container.clone())
    };

    loop {
        let next = tokio::time::timeout(FLUSH_INTERVAL, output.next()).await;
        let ended = match next {
            Ok(Some(Ok(chunk))) => {
                pending.extend_from_slice(chunk.as_ref());
                false
            }
            Ok(Some(Err(_))) | Ok(None) => true,
            Err(_) => false,
        };
        if !pending.is_empty() && (ended || pending.len() >= FLUSH_BYTES || last.elapsed() >= FLUSH_INTERVAL) {
            let complete = split_utf8(&mut carry, &pending);
            pending.clear();
            last = Instant::now();
            if !complete.is_empty() {
                let text = String::from_utf8_lossy(&complete).into_owned();
                if let Some(hit) = detector.scan(&text) {
                    let _ = app.emit(
                        EVT_LIMIT_HIT,
                        LimitHitPayload { session_id: id.clone(), container: container.clone(), text: hit },
                    );
                }
                let mut g = live.lock();
                g.ring.push(&complete);
                if let Some(ch) = &g.sink {
                    if ch.send(TermMsg::Data { data: text }).is_err() {
                        g.sink = None;
                    }
                }
            }
        }
        if ended {
            break;
        }
    }

    let exec_id = live.lock().exec_id.clone();
    let code = docker.raw().inspect_exec(&exec_id).await.ok().and_then(|i| i.exit_code);
    let scroll = live.lock().scroll_lock.clone();
    scroll.lock().await.take();
    {
        let mut g = live.lock();
        g.alive = false;
        if let Some(ch) = g.sink.take() {
            let _ = ch.send(TermMsg::Exit { code });
        }
    }
    let _ = app.emit(EVT_SESSION_EXIT, ExitPayload { session_id: id, container, code });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 启动命令包含环境变量与模式参数() {
        let rec = SessionRecord {
            id: "ab12".into(),
            container: "c".into(),
            title: "t".into(),
            cwd: "/workspace/app".into(),
            mode: "claude".into(),
            args: vec!["--resume".into(), "sid".into()],
            env: vec!["A=1".into(), "坏".into(), "=x".into()],
            tmux: true,
            created_at: 0,
        };
        assert_eq!(
            build_command(&rec),
            vec![
                "sh",
                "-c",
                REATTACH_SCRIPT,
                "tdc-attach",
                "=tdc-ab12",
                "/opt/tdc/tdc-session.sh",
                "-e",
                "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=0",
                "-e",
                "CLAUDE_CODE_NO_FLICKER=1",
                "-e",
                "CLAUDE_CODE_TMUX_TRUECOLOR=1",
                "-e",
                "A=1",
                "ab12",
                "/workspace/app",
                "claude",
                "--resume",
                "sid"
            ]
        );
        let rec2 = SessionRecord { tmux: false, cwd: String::new(), args: vec![], env: vec![], ..rec };
        assert_eq!(
            build_command(&rec2),
            vec![
                "/opt/tdc/tdc-session.sh",
                "-e",
                "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=0",
                "-e",
                "CLAUDE_CODE_NO_FLICKER=1",
                "--no-tmux",
                "ab12",
                "/workspace",
                "claude"
            ]
        );
        let shell = SessionRecord { mode: "bash".into(), ..rec2.clone() };
        assert!(!build_command(&shell).iter().any(|s| s.contains("DISABLE_ALTERNATE_SCREEN")));
        let override_mode = SessionRecord { env: vec!["CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1".into()], ..rec2 };
        let env = build_command(&override_mode)
            .into_iter()
            .filter(|s| s.starts_with("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN="))
            .collect::<Vec<_>>();
        assert_eq!(env, vec!["CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=0", "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1"]);
    }

    #[test]
    fn docker_初始尺寸使用行列顺序并限制最小值() {
        let config = ExecConfig { tty: Some(true), console_size: Some(console_size(163, 37)), ..Default::default() };
        assert_eq!(serde_json::to_value(config).unwrap()["ConsoleSize"], serde_json::json!([37, 163]));
        assert_eq!(console_size(0, 1), vec![2, 2]);
    }

    /// TDC_TEST_CONTAINER=... cargo test --lib docker_initial_terminal_size -- --ignored
    #[tokio::test]
    #[ignore = "requires a running Docker container; runs only stty size"]
    async fn docker_initial_terminal_size() {
        let container = std::env::var("TDC_TEST_CONTAINER").expect("Set TDC_TEST_CONTAINER");
        let docker = DockerClient::connect("").unwrap();
        let created = docker.raw().create_exec(&container, ExecConfig {
            tty: Some(true), attach_stdout: Some(true), attach_stderr: Some(true),
            console_size: Some(console_size(163, 37)),
            cmd: Some(vec!["stty".into(), "size".into()]),
            user: Some(crate::docker::spec::APP_USER.into()),
            ..Default::default()
        }).await.unwrap();
        let StartExecResults::Attached { mut output, .. } = docker.raw().start_exec(&created.id,
            Some(StartExecOptions { detach: false, tty: true, output_capacity: Some(4096) })).await.unwrap()
        else { panic!("not attached") };
        let result = tokio::time::timeout(Duration::from_secs(5), async {
            let mut bytes = Vec::new();
            while let Some(chunk) = output.next().await { bytes.extend_from_slice(chunk.unwrap().as_ref()); }
            String::from_utf8(bytes).unwrap()
        }).await.unwrap();
        assert_eq!(result.trim(), "37 163", "first process output must already use the requested dimensions");
    }
}
