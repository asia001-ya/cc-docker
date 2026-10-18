//! tmux 历史滚动：读取真正的历史长度，通过 copy-mode 移动，不向 Claude 输入区发送按键。
use std::pin::Pin;
use std::time::Duration;

use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use futures_util::{Stream, StreamExt};
use serde::Serialize;
use tokio::io::{AsyncWrite, AsyncWriteExt};

use crate::docker::{client::DockerClient, spec::APP_USER};
use crate::error::{AppError, AppResult};

const SCRIPT: &str = include_str!("tmux-scroll.sh");

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollbackState {
    pub history_rows: u32,
    pub offset_rows: u32,
    pub viewport_rows: u32,
    pub in_copy_mode: bool,
    pub available: bool,
    pub alternate_screen: bool,
}

fn parse_state(output: &str) -> AppResult<ScrollbackState> {
    let fields: Vec<_> = output.trim().split('|').collect();
    let invalid = || AppError::Other("无法读取 tmux 历史位置".into());
    if fields.len() != 5 || !matches!(fields[4], "0" | "1") {
        return Err(invalid());
    }
    let history_rows = fields[0].parse::<u32>().map_err(|_| invalid())?;
    let in_copy_mode = fields[3] == "copy-mode";
    let offset_rows = if in_copy_mode { fields[1].parse::<u32>().map_err(|_| invalid())? } else { 0 };
    let viewport_rows = fields[2].parse::<u32>().map_err(|_| invalid())?;
    if viewport_rows == 0 {
        return Err(invalid());
    }
    Ok(ScrollbackState {
        history_rows,
        offset_rows: offset_rows.min(history_rows),
        viewport_rows,
        in_copy_mode,
        available: fields[4] == "0" && (fields[3].is_empty() || in_copy_mode),
        alternate_screen: fields[4] == "1",
    })
}

/// 非 TTY 的持久滚动通道：不会附加 tmux 客户端或参与终端尺寸计算。
/// 复用 Docker exec，拖动期间只传一行请求/响应，不重复创建进程与 inspect。
pub struct ScrollConnection {
    input: Pin<Box<dyn AsyncWrite + Send>>,
    output: Pin<Box<dyn Stream<Item = Result<bollard::container::LogOutput, bollard::errors::Error>> + Send>>,
    pending: Vec<u8>,
}

impl ScrollConnection {
    async fn connect(docker: &DockerClient, container: &str, session_id: &str) -> AppResult<Self> {
        let target = format!("=tdc-{session_id}:0.0");
        Self::start(docker, container, SCRIPT, &target).await
    }

    async fn start(docker: &DockerClient, container: &str, script: &str, target: &str) -> AppResult<Self> {
        let created = docker
            .raw()
            .create_exec(
                container,
                CreateExecOptions {
                    attach_stdin: Some(true),
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    tty: Some(false),
                    user: Some(APP_USER.to_string()),
                    cmd: Some(vec![
                        "sh".into(),
                        "-c".into(),
                        script.into(),
                        "tdc-scrollback".into(),
                        target.into(),
                        "--stream".into(),
                    ]),
                    ..Default::default()
                },
            )
            .await?;
        match docker
            .raw()
            .start_exec(&created.id, Some(StartExecOptions { detach: false, tty: false, output_capacity: Some(4096) }))
            .await?
        {
            StartExecResults::Attached { input, output } => Ok(Self { input, output, pending: Vec::new() }),
            _ => Err(AppError::Docker("历史滚动通道未能附着".into())),
        }
    }

    async fn request(&mut self, offset: Option<u32>) -> AppResult<ScrollbackState> {
        let request = offset.map_or_else(|| "get".into(), |n| n.to_string()) + "\n";
        self.input.write_all(request.as_bytes()).await?;
        self.input.flush().await?;
        loop {
            if let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
                let line: Vec<_> = self.pending.drain(..=end).collect();
                let line = String::from_utf8_lossy(&line);
                return match line.strip_prefix("ok|") {
                    Some(state) => parse_state(state),
                    None => Err(AppError::Other("读取或滚动容器历史失败".into())),
                };
            }
            match self.output.next().await {
                Some(Ok(chunk)) => self.pending.extend_from_slice(chunk.as_ref()),
                Some(Err(error)) => return Err(error.into()),
                None => return Err(AppError::Other("历史滚动通道已关闭".into())),
            }
            if self.pending.len() > 4096 {
                return Err(AppError::Other("历史滚动响应格式错误".into()));
            }
        }
    }
}

/// 调用方持有每个会话的锁。超时/断线后丢弃通道，下一次重新连接，
/// 防止迟到响应被误认为下一次拖动结果。
pub async fn scrollback(
    connection: &mut Option<ScrollConnection>,
    docker: &DockerClient,
    container: &str,
    session_id: &str,
    offset_rows: Option<u32>,
) -> AppResult<ScrollbackState> {
    let result = tokio::time::timeout(Duration::from_secs(4), async {
        if connection.is_none() {
            *connection = Some(ScrollConnection::connect(docker, container, session_id).await?);
        }
        connection.as_mut().unwrap().request(offset_rows).await
    })
    .await
    .unwrap_or_else(|_| Err(AppError::Other("历史滚动请求超时".into())));
    if result.is_err() {
        *connection = None;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(chunks: &[&str]) -> ScrollConnection {
        let chunks: Vec<_> = chunks
            .iter()
            .map(|s| Ok(bollard::container::LogOutput::StdOut { message: s.as_bytes().to_vec().into() }))
            .collect();
        ScrollConnection {
            input: Box::pin(tokio::io::sink()),
            output: Box::pin(futures_util::stream::iter(chunks)),
            pending: Vec::new(),
        }
    }

    #[tokio::test]
    async fn 持久连接按行处理拆包和连续响应() {
        let mut stream = response(&["o", "k|278|10", "0|24|copy-mode|0\nok|278||24||0\n"]);
        assert_eq!(stream.request(Some(100)).await.unwrap().offset_rows, 100);
        assert!(!stream.request(Some(0)).await.unwrap().in_copy_mode);
        assert!(stream.request(None).await.is_err());
    }

    #[tokio::test]
    async fn 错误或断线丢弃连接不复用残余响应() {
        let docker = DockerClient::connect("").unwrap();
        for chunks in [vec!["error|gone\nok|278||24||0\n"], vec!["ok|278|100"], vec!["bad frame\n"]] {
            let mut connection = Some(response(&chunks));
            assert!(scrollback(&mut connection, &docker, "unused", "unused", None).await.is_err());
            assert!(connection.is_none());
        }
    }

    /// 显式启用：TDC_TEST_CONTAINER=... cargo test --lib docker_scroll_latency -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "requires a running Docker container; creates only a private tmux socket"]
    async fn docker_scroll_latency() {
        use futures_util::FutureExt;
        let container = std::env::var("TDC_TEST_CONTAINER").expect("Set TDC_TEST_CONTAINER");
        let docker = DockerClient::connect("").unwrap();
        let socket = format!("tdc-rust-scroll-{}", uuid::Uuid::new_v4().simple());
        let wrapper = format!("tmux() {{ command tmux -L '{socket}' \"$@\"; }}\n{SCRIPT}");
        let result = std::panic::AssertUnwindSafe(async {
            let created = docker
                .exec_as(
                    &container,
                    APP_USER,
                    &[
                        "tmux",
                        "-L",
                        &socket,
                        "-f",
                        "/dev/null",
                        "new-session",
                        "-d",
                        "-s",
                        "qa",
                        "-x",
                        "90",
                        "-y",
                        "24",
                        "sh",
                        "-c",
                        "seq 1 300; sleep 120",
                    ],
                    None,
                    Duration::from_secs(4),
                )
                .await
                .unwrap();
            assert_eq!(created.exit_code, Some(0));
            let mut stream = ScrollConnection::start(&docker, &container, &wrapper, "=qa:0.0").await.unwrap();
            assert!(stream.request(None).await.unwrap().history_rows > 200);
            let mut before = Vec::new();
            for offset in [100, 50, 150, 30, 120, 200] {
                let started = std::time::Instant::now();
                let out = docker
                    .exec_as(
                        &container,
                        APP_USER,
                        &["sh", "-c", &wrapper, "qa", "=qa:0.0", &offset.to_string()],
                        None,
                        Duration::from_secs(4),
                    )
                    .await
                    .unwrap();
                assert_eq!(parse_state(&out.stdout).unwrap().offset_rows, offset);
                before.push(started.elapsed().as_secs_f64() * 1000.0);
            }
            let mut after = Vec::new();
            for i in 0..60 {
                let offset = (i * 17) % 200 + 1;
                let started = std::time::Instant::now();
                assert_eq!(stream.request(Some(offset)).await.unwrap().offset_rows, offset);
                after.push(started.elapsed().as_secs_f64() * 1000.0);
            }
            assert!(!stream.request(Some(0)).await.unwrap().in_copy_mode);
            before.sort_by(f64::total_cmp);
            after.sort_by(f64::total_cmp);
            println!(
                "Docker Engine path: old median {:.1} ms; persistent median {:.1} ms, p95 {:.1} ms",
                before[3], after[30], after[57]
            );
        })
        .catch_unwind()
        .await;
        let _ = docker
            .exec_as(&container, APP_USER, &["tmux", "-L", &socket, "kill-server"], None, Duration::from_secs(4))
            .await;
        result.unwrap();
    }

    #[test]
    fn 正常屏幕无本地回滚时仍读取容器历史() {
        let s = parse_state("63||37||0\n").unwrap();
        assert_eq!(s.history_rows, 63);
        assert_eq!(s.offset_rows, 0);
        assert!(s.available);
        assert!(!s.in_copy_mode);
    }

    #[test]
    fn copy_mode_位置与边界() {
        let s = parse_state("278|100|24|copy-mode|0\n").unwrap();
        assert_eq!(s.offset_rows, 100);
        assert!(s.in_copy_mode);
        assert_eq!(parse_state("20|30|24|copy-mode|0").unwrap().offset_rows, 20);
        assert!(!parse_state("20||24|view-mode|0").unwrap().available);
        let fullscreen = parse_state("0||37||1").unwrap();
        assert!(fullscreen.alternate_screen);
        assert!(!fullscreen.available);
    }

    #[test]
    fn 错误响应不会被当成空历史() {
        for value in ["", "no server running", "x||24||0", "20|x|24|copy-mode|0", "20||0||0"] {
            assert!(parse_state(value).is_err());
        }
    }
}
