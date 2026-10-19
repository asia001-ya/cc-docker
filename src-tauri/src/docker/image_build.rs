//! 标准镜像构建：构建上下文（docker/ 下的 Dockerfile、tmux.conf、rootfs）编译时内置进应用，
//! 经 Docker API 以经典构建器构建并逐行回调输出。首次启动没有镜像时由前端引导调用。
//!
//! 用经典构建器而非 BuildKit：BuildKit 走 API 需要 gRPC 会话，且会额外拉取 dockerfile 前端镜像
//! （国内网络下 auth.docker.io 常超时）；Dockerfile 只使用经典构建器支持的语法。

use std::collections::VecDeque;

use bollard::query_parameters::BuildImageOptions;
use futures_util::StreamExt;

use super::client::DockerClient;
use crate::error::{AppError, AppResult};

/// 构建日志在内存中保留的行数（前端刷新后据此恢复进度）。
const LOG_KEEP: usize = 300;

/// 登记构建上下文文件：路径相对 docker/ 目录，内容编译时读入。
macro_rules! context_files {
    ($($path:literal),* $(,)?) => {
        &[$(($path, include_bytes!(concat!("../../../docker/", $path)) as &[u8])),*]
    };
}

/// 构建上下文。新增 rootfs 文件时必须在此登记，单测会比对 docker/rootfs 防止遗漏。
const CONTEXT_FILES: &[(&str, &[u8])] = context_files![
    "Dockerfile",
    "tmux.conf",
    "rootfs/etc/claude-code/managed-settings.json",
    "rootfs/opt/tdc/entrypoint-user.sh",
    "rootfs/opt/tdc/entrypoint.sh",
    "rootfs/opt/tdc/lan-policy.json",
    "rootfs/opt/tdc/portwatch.sh",
    "rootfs/opt/tdc/proxy-guard.sh",
    "rootfs/opt/tdc/region-options.json",
    "rootfs/opt/tdc/statusline.mjs",
    "rootfs/opt/tdc/statusline-display.mjs",
    "rootfs/opt/tdc/tdc-claude.sh",
    "rootfs/opt/tdc/tdc-ctl.sh",
    "rootfs/opt/tdc/tdc-host-config.mjs",
    "rootfs/opt/tdc/tdc-git-bridge.mjs",
    "rootfs/opt/tdc/tdc-install-xray.sh",
    "rootfs/opt/tdc/tdc-lan.mjs",
    "rootfs/opt/tdc/tdc-lib.mjs",
    "rootfs/opt/tdc/tdc-quota.mjs",
    "rootfs/opt/tdc/tdc-proxy-lib.mjs",
    "rootfs/opt/tdc/tdc-proxy.sh",
    "rootfs/opt/tdc/tdc-session-history.mjs",
    "rootfs/opt/tdc/tdc-session.sh",
    "rootfs/opt/tdc/tdc-usage.mjs",
    "rootfs/opt/tdc/tdc-xray.mjs",
    "rootfs/opt/tdc/xray-release.json",
];

/// 构建进度跟踪（全局唯一，同一时刻只允许一次构建）。
#[derive(Debug, Default)]
pub struct BuildTracker {
    /// 是否正在构建
    pub running: bool,
    /// 最近的输出行
    pub log: VecDeque<String>,
    /// 上次构建的错误（成功或进行中为 None）
    pub error: Option<String>,
}

impl BuildTracker {
    /// 开始新一轮构建：清空日志与错误。参数：无；返回：已在构建时返回 false。
    pub fn start(&mut self) -> bool {
        if self.running {
            return false;
        }
        self.running = true;
        self.log.clear();
        self.error = None;
        true
    }

    /// 追加一行输出（超出上限丢弃最旧的）。参数：line——输出行；返回：无。
    pub fn push(&mut self, line: String) {
        if self.log.len() >= LOG_KEEP {
            self.log.pop_front();
        }
        self.log.push_back(line);
    }

    /// 结束构建。参数：error——失败原因（成功为 None）；返回：无。
    pub fn finish(&mut self, error: Option<String>) {
        self.running = false;
        self.error = error;
    }
}

/// 把内置的构建上下文打成 tar：统一 LF 换行，脚本 0755，其余 0644，固定 mtime 以便内容不变时复用构建缓存。
/// 参数：无；返回：tar 字节。
pub fn context_tar() -> AppResult<Vec<u8>> {
    let mut builder = tar::Builder::new(Vec::new());
    for (path, content) in CONTEXT_FILES {
        let data = to_lf(content);
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(if path.ends_with(".sh") { 0o755 } else { 0o644 });
        header.set_mtime(0);
        builder.append_data(&mut header, path, data.as_slice())?;
    }
    Ok(builder.into_inner()?)
}

/// 去掉 CRLF 中的 CR（Windows 检出的脚本在容器内会因 \r 无法执行）。参数：content——原始内容；返回：LF 内容。
fn to_lf(content: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(content.len());
    for (i, b) in content.iter().enumerate() {
        if *b == b'\r' && content.get(i + 1) == Some(&b'\n') {
            continue;
        }
        out.push(*b);
    }
    out
}

/// 构建输出的行缓冲：按 \n 切分；一行内的 \r 视为回车覆盖，只保留最后一段（apt / npm 进度）。
#[derive(Default)]
struct LineSplitter {
    pending: String,
}

impl LineSplitter {
    /// 追加一段输出并取出完整行。参数：chunk——输出片段；返回：完整行（已去掉空行）。
    fn feed(&mut self, chunk: &str) -> Vec<String> {
        self.pending.push_str(chunk);
        let mut lines = Vec::new();
        while let Some(pos) = self.pending.find('\n') {
            let line: String = self.pending.drain(..=pos).collect();
            lines.extend(clean_line(&line));
        }
        lines
    }

    /// 取出剩余的不完整行。参数：无；返回：剩余行。
    fn flush(&mut self) -> Option<String> {
        clean_line(&std::mem::take(&mut self.pending))
    }
}

/// 去掉换行与回车覆盖前的内容。参数：raw——原始行；返回：非空行。
fn clean_line(raw: &str) -> Option<String> {
    let line = raw.trim_end_matches(['\n', '\r']);
    let line = line.rsplit('\r').next().unwrap_or("").trim_end();
    (!line.is_empty()).then(|| line.to_string())
}

/// 拉取基础镜像时逐层刷新的进度状态，不写入日志。参数：status——状态文本；返回：是否为噪声。
fn is_pull_progress(status: &str) -> bool {
    matches!(status, "Downloading" | "Extracting" | "Waiting" | "Verifying Checksum" | "Download complete")
}

/// 构建标准镜像并打上 image 标签。
/// 参数：docker——客户端；image——目标镜像名；on_line——每行输出的回调；返回：成功与否（失败带 Docker 输出的原因）。
pub async fn build_standard_image(
    docker: &DockerClient,
    image: &str,
    mut on_line: impl FnMut(String),
) -> AppResult<()> {
    let options = BuildImageOptions { t: Some(image.to_string()), rm: true, forcerm: true, ..Default::default() };
    let mut stream = docker.raw().build_image(options, None, Some(bollard::body_full(context_tar()?.into())));
    let mut splitter = LineSplitter::default();
    let mut failure = None;
    while let Some(item) = stream.next().await {
        match item {
            Ok(info) => {
                if let Some(message) = info.error_detail.and_then(|d| d.message) {
                    failure = Some(message);
                    break;
                }
                if let Some(text) = info.stream {
                    splitter.feed(&text).into_iter().for_each(&mut on_line);
                }
                if let Some(status) = info.status.filter(|s| !is_pull_progress(s)) {
                    on_line(match info.id {
                        Some(id) => format!("{id}: {status}"),
                        None => status,
                    });
                }
            }
            Err(bollard::errors::Error::DockerStreamError { error }) => {
                failure = Some(error);
                break;
            }
            Err(e) => return Err(e.into()),
        }
    }
    if let Some(rest) = splitter.flush() {
        on_line(rest);
    }
    if let Some(message) = failure {
        return Err(AppError::Docker(format!("镜像构建失败：{}", message.trim())));
    }
    if !docker.image_supports_proxy(image).await {
        return Err(AppError::Docker(format!("构建结束，但未找到带代理能力标签的镜像 {image}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 构建上下文包含_rootfs_全部文件() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../docker");
        let mut on_disk = Vec::new();
        let mut stack = vec![root.join("rootfs")];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    on_disk.push(path.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/"));
                }
            }
        }
        let bundled: Vec<&str> = CONTEXT_FILES.iter().map(|(p, _)| *p).collect();
        for file in &on_disk {
            assert!(bundled.contains(&file.as_str()), "rootfs 新增了 {file}，需要登记到 CONTEXT_FILES");
        }
    }

    #[test]
    fn 手工构建只允许与内置上下文相同的公共文件() {
        let ignore = include_str!("../../../docker/.dockerignore");
        let rules: Vec<_> =
            ignore.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#')).collect();
        assert_eq!(rules.first(), Some(&"**"));
        let files: Vec<_> = rules
            .iter()
            .skip(1)
            .filter_map(|rule| {
                assert!(rule.starts_with('!'));
                let allowed = &rule[1..];
                assert!(!allowed.contains('*') && !allowed.contains(".."));
                (!allowed.ends_with('/')).then_some(allowed)
            })
            .collect();
        assert_eq!(files.len(), CONTEXT_FILES.len());
        for (file, _) in CONTEXT_FILES {
            assert!(files.contains(file), "公共构建文件未登记到 .dockerignore");
        }
    }

    #[test]
    fn 构建上下文为_lf_且脚本可执行() {
        let tar = context_tar().unwrap();
        let mut archive = tar::Archive::new(tar.as_slice());
        let mut names = Vec::new();
        for entry in archive.entries().unwrap() {
            let mut entry = entry.unwrap();
            let name = entry.path().unwrap().to_string_lossy().to_string();
            let mode = entry.header().mode().unwrap();
            let mut content = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut content).unwrap();
            assert!(!content.windows(2).any(|w| w == b"\r\n"), "{name} 含 CRLF");
            assert_eq!(mode, if name.ends_with(".sh") { 0o755 } else { 0o644 }, "{name}");
            names.push(name);
        }
        assert!(names.contains(&"Dockerfile".to_string()));
        assert_eq!(names.len(), CONTEXT_FILES.len());
    }

    #[test]
    fn dockerfile_不声明_syntax_前端() {
        let dockerfile = String::from_utf8_lossy(CONTEXT_FILES[0].1);
        assert!(
            !dockerfile.lines().any(|l| l.trim_start().starts_with("# syntax")),
            "经典构建器下 syntax 指令会触发额外拉取"
        );
    }

    #[test]
    fn 行缓冲处理分片与回车覆盖() {
        let mut s = LineSplitter::default();
        assert!(s.feed("Step 1/3 : FROM").is_empty());
        assert_eq!(s.feed(" node\n ---> abc\n"), vec!["Step 1/3 : FROM node", " ---> abc"]);
        assert_eq!(s.feed("10%\r50%\r100%\n\n"), vec!["100%"]);
        assert!(s.feed("tail").is_empty());
        assert_eq!(s.flush().as_deref(), Some("tail"));
        assert_eq!(to_lf(b"a\r\nb\rc\n"), b"a\nb\rc\n");
    }

    #[test]
    fn 跟踪器同一时刻只允许一次构建且限制日志行数() {
        let mut t = BuildTracker::default();
        assert!(t.start());
        assert!(!t.start(), "构建中不能再次开始");
        for i in 0..(LOG_KEEP + 5) {
            t.push(i.to_string());
        }
        assert_eq!(t.log.len(), LOG_KEEP);
        assert_eq!(t.log.front().map(String::as_str), Some("5"));
        t.finish(Some("失败".into()));
        assert!(!t.running);
        assert!(t.start(), "结束后可以重试");
        assert!(t.log.is_empty() && t.error.is_none());
    }
}

#[cfg(test)]
mod docker_tests {
    use super::*;

    /// 经 Docker API 真实构建到独立标签，验证标签与内核，结束后删除该标签；不触碰默认镜像。
    #[tokio::test]
    #[ignore = "requires Docker and network; builds tdc/claude-dev:apibuild-test then removes it"]
    async fn 经_api_构建标准镜像() {
        let docker = DockerClient::connect("").unwrap();
        let image = "tdc/claude-dev:apibuild-test";
        let mut lines = Vec::new();
        build_standard_image(&docker, image, |l| lines.push(l)).await.unwrap();
        assert!(lines.iter().any(|l| l.starts_with("Step 1/")), "应输出经典构建器步骤");
        let labels = docker.raw().inspect_image(image).await.unwrap().config.unwrap().labels.unwrap();
        for key in ["tdc.proxy", "tdc.xray", "tdc.locales"] {
            assert_eq!(labels.get(key).map(String::as_str), Some("1"), "缺少标签 {key}");
        }
        docker.raw().remove_image(image, None::<bollard::query_parameters::RemoveImageOptions>, None).await.unwrap();
    }
}
