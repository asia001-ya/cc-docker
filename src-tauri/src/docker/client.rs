//! Docker 客户端封装：连接、容器列表、创建 / 启停 / 删除、执行命令、写入文件、事件流。

use std::collections::HashMap;
use std::time::Duration;

use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use bollard::models::{ContainerCreateBody, ContainerSummary, ContainerSummaryStateEnum, VolumeCreateRequest};
use bollard::query_parameters::{
    CreateContainerOptions, EventsOptions, InspectContainerOptions, ListContainersOptions, RemoveContainerOptions,
    RemoveVolumeOptions, StartContainerOptions, StopContainerOptions, UploadToContainerOptions,
};
use bollard::{Docker, API_DEFAULT_VERSION};
use futures_util::StreamExt;
use serde::Serialize;

use super::spec::{
    self, CreateContainerRequest, APP_USER, LABEL_AUTH, LABEL_GROUP, LABEL_MANAGED, LABEL_PROVIDER, LABEL_SLOT,
};
use crate::error::{AppError, AppResult};

/// 容器内命令的默认超时：防止某个容器内脚本卡住拖垮整轮轮询。
pub const EXEC_TIMEOUT: Duration = Duration::from_secs(20);
/// node 用户在官方 node 镜像中的 uid / gid。
const APP_UID: u64 = 1000;

/// 前端展示的容器信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    /// 容器 ID
    pub id: String,
    /// 容器名
    pub name: String,
    /// 镜像
    pub image: String,
    /// 状态：running / exited / created ...
    pub state: String,
    /// 状态描述（Up 3 hours）
    pub status: String,
    /// 是否运行中
    pub running: bool,
    /// 槽位号
    pub slot: u16,
    /// 授权模式
    pub auth_mode: String,
    /// API 供应商 ID
    pub provider_id: Option<String>,
    /// 共享组（空串表示未加入）
    pub shared_group: String,
    /// 端口映射 (容器端口, 宿主端口)
    pub ports: Vec<(u16, u16)>,
    /// 挂载（目标路径 → 源）
    pub mounts: Vec<MountInfo>,
}

/// 挂载信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountInfo {
    /// 类型：bind / volume
    pub kind: String,
    /// 源（宿主路径或卷名）
    pub source: String,
    /// 容器内路径
    pub destination: String,
    /// 可写
    pub rw: bool,
}

/// Docker 引擎概要。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    /// 引擎版本
    pub version: String,
    /// API 版本
    pub api_version: String,
    /// ping 往返耗时（毫秒）
    pub latency_ms: u64,
    /// 连接地址
    pub host: String,
}

/// 命令执行结果。
#[derive(Debug, Clone)]
pub struct ExecOutput {
    /// 标准输出
    pub stdout: String,
    /// 标准错误
    pub stderr: String,
    /// 退出码
    pub exit_code: Option<i64>,
}

/// 平台默认引擎地址。
/// 参数：无；返回：地址字符串。
pub fn default_host() -> &'static str {
    if cfg!(windows) {
        "npipe:////./pipe/docker_engine"
    } else {
        "unix:///var/run/docker.sock"
    }
}

/// Docker 客户端。
#[derive(Clone)]
pub struct DockerClient {
    inner: Docker,
    host: String,
}

impl DockerClient {
    pub fn connection_key(&self) -> &str { &self.host }

    /// Long-lived non-TTY bridge. Credential payloads travel only in its stdin/stdout.
    pub async fn git_bridge_exec(&self, id: &str, script: &str) -> AppResult<StartExecResults> {
        let exec = self.inner.create_exec(id, CreateExecOptions {
            attach_stdout: Some(true), attach_stderr: Some(true), attach_stdin: Some(true),
            user: Some(APP_USER.to_string()), cmd: Some(vec!["node".to_string(), script.to_string(), "serve".to_string()]),
            ..Default::default()
        }).await?;
        Ok(self.inner.start_exec(&exec.id, None::<StartExecOptions>).await?)
    }
    /// 本机路径只向本机 Unix socket / Windows named pipe 引擎开放。
    pub fn accepts_local_paths(&self) -> bool {
        self.host.starts_with("unix://") || self.host.starts_with("npipe:////./pipe/")
    }

    pub async fn image_supports_host_config(&self, image: &str) -> bool {
        self.inner
            .inspect_image(image)
            .await
            .ok()
            .and_then(|i| i.config)
            .and_then(|c| c.labels)
            .is_some_and(|labels| labels.get(spec::LABEL_HOST_CONFIG_IMAGE).is_some_and(|value| value == "1"))
    }

    /// 按地址建立客户端（仅创建，不发请求）。
    /// 参数：host——引擎地址，空串使用平台默认；返回：客户端或错误。
    pub fn connect(host: &str) -> AppResult<Self> {
        let host = if host.trim().is_empty() { default_host().to_string() } else { host.trim().to_string() };
        let inner = if host.starts_with("npipe://") {
            #[cfg(windows)]
            {
                Docker::connect_with_named_pipe(&host, 120, API_DEFAULT_VERSION)?
            }
            #[cfg(not(windows))]
            {
                return Err(AppError::Invalid("named pipe 仅在 Windows 上可用".into()));
            }
        } else {
            Docker::connect_with_host(&host)?
        };
        Ok(Self { inner, host })
    }

    /// 探测引擎（ping + version）。
    /// 参数：无；返回：引擎概要或 DockerUnavailable。
    pub async fn engine_info(&self) -> AppResult<EngineInfo> {
        let start = std::time::Instant::now();
        tokio::time::timeout(Duration::from_secs(3), self.inner.ping())
            .await
            .map_err(|_| AppError::DockerUnavailable("连接超时，请确认 Docker Desktop 已启动".into()))?
            .map_err(|e| AppError::DockerUnavailable(friendly_connect_error(&self.host, &e.to_string())))?;
        let latency_ms = start.elapsed().as_millis() as u64;
        let v = self.inner.version().await?;
        Ok(EngineInfo {
            version: v.version.unwrap_or_default(),
            api_version: v.api_version.unwrap_or_default(),
            latency_ms,
            host: self.host.clone(),
        })
    }

    /// 列出 tdc 管理的容器。
    /// 参数：include_unmanaged——是否包含未带 tdc 标签的容器（导入弹框使用）；返回：容器列表（按名称排序）。
    pub async fn list(&self, include_unmanaged: bool) -> AppResult<Vec<ContainerInfo>> {
        let filters = if include_unmanaged {
            None
        } else {
            Some(HashMap::from([("label".to_string(), vec![format!("{LABEL_MANAGED}=true")])]))
        };
        let list = self
            .inner
            .list_containers(Some(ListContainersOptions { all: true, filters, ..Default::default() }))
            .await?;
        let mut out: Vec<ContainerInfo> = list.into_iter().map(summary_to_info).collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    /// 读取单个容器信息。
    /// 参数：name——容器名；返回：容器信息或 NotFound。
    pub async fn get(&self, name: &str) -> AppResult<ContainerInfo> {
        let filters = HashMap::from([("name".to_string(), vec![format!("^/{name}$")])]);
        let list = self
            .inner
            .list_containers(Some(ListContainersOptions { all: true, filters: Some(filters), ..Default::default() }))
            .await?;
        list.into_iter().map(summary_to_info).next().ok_or_else(|| AppError::NotFound(format!("容器 {name}")))
    }

    /// 检查本地是否有镜像。
    /// 参数：image——镜像名；返回：存在返回 true。
    pub async fn image_exists(&self, image: &str) -> bool {
        self.inner.inspect_image(image).await.is_ok()
    }

    /// 检查本地镜像是否支持容器内代理（带 tdc.proxy=1 标签）。
    /// 参数：image——镜像名；返回：支持返回 true，镜像不存在返回 false。
    pub async fn image_supports_proxy(&self, image: &str) -> bool {
        self.inner
            .inspect_image(image)
            .await
            .ok()
            .and_then(|i| i.config)
            .and_then(|c| c.labels)
            .is_some_and(|l| l.get(spec::LABEL_PROXY_IMAGE).is_some_and(|v| v == "1"))
    }

    /// 标准镜像是否已预生成表单支持的全部 UTF-8 locale。
    pub async fn image_supports_locales(&self, image: &str) -> bool {
        self.inner
            .inspect_image(image)
            .await
            .ok()
            .and_then(|i| i.config)
            .and_then(|c| c.labels)
            .is_some_and(|l| l.get(spec::LABEL_LOCALES_IMAGE).is_some_and(|v| v == "1"))
    }

    /// 创建容器（必要时先创建命名卷）。
    /// 参数：req——表单；start——创建后是否立即启动；返回：容器 ID。
    pub async fn create(&self, req: &CreateContainerRequest, start: bool) -> AppResult<String> {
        if req.host_config.as_ref().is_some_and(|config| !config.is_empty()) {
            if !self.accepts_local_paths() {
                return Err(AppError::Invalid(
                    "宿主 Claude 配置仅支持本机 Docker；远端引擎不能挂载本机配置路径".into(),
                ));
            }
            if !self.image_supports_host_config(&req.image).await {
                return Err(AppError::Invalid("镜像不支持宿主 Claude 配置，请先构建最新版标准镜像".into()));
            }
        }
        let body = spec::build_create_body(req)?;
        if !self.image_exists(&req.image).await {
            return Err(AppError::NotFound(format!(
                "本地没有镜像 {}，请先构建（默认镜像可在应用内一键构建）",
                req.image
            )));
        }
        let mut volumes = vec![spec::home_volume(&req.name)];
        if req.shared_group {
            volumes.push(spec::shared_projects_volume(req.group_name.as_deref()));
            volumes.push(spec::shared_memory_volume(req.group_name.as_deref()));
        }
        for v in volumes {
            let labels = HashMap::from([(LABEL_MANAGED.to_string(), "true".to_string())]);
            self.inner
                .create_volume(VolumeCreateRequest { name: Some(v), labels: Some(labels), ..Default::default() })
                .await?;
        }
        let res = self
            .inner
            .create_container(Some(CreateContainerOptions { name: Some(req.name.clone()), ..Default::default() }), body)
            .await?;
        if start {
            self.start(&req.name).await?;
        }
        Ok(res.id)
    }

    /// 已验证的候选配置使用临时 Docker 名称，逻辑容器名与卷名保持不变。
    pub async fn create_candidate(&self, name: &str, body: ContainerCreateBody) -> AppResult<String> {
        Ok(self
            .inner
            .create_container(Some(CreateContainerOptions { name: Some(name.to_string()), ..Default::default() }), body)
            .await?
            .id)
    }

    /// 启动容器。参数：name——容器名；返回：成功与否。
    pub async fn start(&self, name: &str) -> AppResult<()> {
        self.inner.start_container(name, None::<StartContainerOptions>).await?;
        Ok(())
    }

    /// 停止容器。参数：name——容器名；force——true 时立即 kill；返回：成功与否。
    pub async fn stop(&self, name: &str, force: bool) -> AppResult<()> {
        let t = if force { Some(0) } else { Some(10) };
        self.inner.stop_container(name, Some(StopContainerOptions { t, signal: None })).await?;
        Ok(())
    }

    /// 重启容器。参数：name——容器名；返回：成功与否。
    pub async fn restart(&self, name: &str) -> AppResult<()> {
        self.stop(name, false).await?;
        self.start(name).await
    }

    /// 删除容器。
    /// 参数：name——容器名；remove_home——是否同时删除其 home 卷（凭证将丢失）；返回：成功与否。
    pub async fn remove(&self, name: &str, remove_home: bool) -> AppResult<()> {
        self.inner.remove_container(name, Some(RemoveContainerOptions { force: true, v: false, link: false })).await?;
        if remove_home {
            self.inner.remove_volume(&spec::home_volume(name), Some(RemoveVolumeOptions { force: true })).await?;
        }
        Ok(())
    }

    /// 读取容器的完整 inspect（用于"重建容器"时复用原配置）。
    /// 参数：name——容器名；返回：inspect 结果。
    pub async fn inspect(&self, name: &str) -> AppResult<bollard::models::ContainerInspectResponse> {
        Ok(self.inner.inspect_container(name, None::<InspectContainerOptions>).await?)
    }

    /// 以 node 身份在容器内执行命令并收集输出（非 TTY，stdout / stderr 分离，带默认超时）。
    /// 参数：name——容器名；cmd——命令 argv；stdin——可选标准输入；返回：输出与退出码。
    pub async fn exec(&self, name: &str, cmd: &[&str], stdin: Option<&[u8]>) -> AppResult<ExecOutput> {
        self.exec_as(name, APP_USER, cmd, stdin, EXEC_TIMEOUT).await
    }

    /// 以指定用户在容器内执行命令（镜像入口为 root，必须显式指定用户）。
    /// 参数：name——容器名；user——运行用户；cmd——命令 argv；stdin——可选标准输入；timeout——超时；返回：输出与退出码。
    pub async fn exec_as(
        &self,
        name: &str,
        user: &str,
        cmd: &[&str],
        stdin: Option<&[u8]>,
        timeout: Duration,
    ) -> AppResult<ExecOutput> {
        tokio::time::timeout(timeout, self.exec_inner(name, user, cmd, stdin)).await.map_err(|_| {
            AppError::Docker(format!("容器 {name} 内命令超时（{} 秒）：{}", timeout.as_secs(), cmd.join(" ")))
        })?
    }

    /// exec 的实际实现（无超时）。
    /// 参数：name——容器名；user——运行用户；cmd——命令 argv；stdin——可选标准输入；返回：输出与退出码。
    async fn exec_inner(&self, name: &str, user: &str, cmd: &[&str], stdin: Option<&[u8]>) -> AppResult<ExecOutput> {
        use tokio::io::AsyncWriteExt;
        let created = self
            .inner
            .create_exec(
                name,
                CreateExecOptions {
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    attach_stdin: Some(stdin.is_some()),
                    cmd: Some(cmd.iter().map(|s| s.to_string()).collect()),
                    user: Some(user.to_string()),
                    ..Default::default()
                },
            )
            .await?;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        if let StartExecResults::Attached { mut output, mut input } =
            self.inner.start_exec(&created.id, None::<StartExecOptions>).await?
        {
            if let Some(data) = stdin {
                input.write_all(data).await?;
                input.shutdown().await?;
            }
            drop(input);
            while let Some(item) = output.next().await {
                match item? {
                    bollard::container::LogOutput::StdErr { message } => stderr.extend_from_slice(&message),
                    other => stdout.extend_from_slice(other.as_ref()),
                }
            }
        }
        let inspect = self.inner.inspect_exec(&created.id).await?;
        Ok(ExecOutput {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_code: inspect.exit_code,
        })
    }

    /// 以 node 身份执行 tdc-ctl 子命令并解析 JSON 输出。
    /// 参数：name——容器名；args——tdc-ctl 参数；返回：JSON 值。
    pub async fn tdc_ctl(&self, name: &str, args: &[&str]) -> AppResult<serde_json::Value> {
        self.tdc_ctl_as(name, APP_USER, args, EXEC_TIMEOUT).await
    }

    /// 以 root 身份执行 tdc-ctl 子命令（仅代理控制 proxy-* 使用）。
    /// 参数：name——容器名；args——tdc-ctl 参数；timeout——超时；返回：JSON 值。
    pub async fn tdc_ctl_root(&self, name: &str, args: &[&str], timeout: Duration) -> AppResult<serde_json::Value> {
        self.tdc_ctl_as(name, "root", args, timeout).await
    }

    /// 以指定用户执行 tdc-ctl 子命令并解析 stdout 最后一行 JSON。
    /// 参数：name——容器名；user——运行用户；args——tdc-ctl 参数；timeout——超时；返回：JSON 值。
    async fn tdc_ctl_as(
        &self,
        name: &str,
        user: &str,
        args: &[&str],
        timeout: Duration,
    ) -> AppResult<serde_json::Value> {
        let mut cmd = vec!["/opt/tdc/tdc-ctl.sh"];
        cmd.extend_from_slice(args);
        let out = self.exec_as(name, user, &cmd, None, timeout).await?;
        let line = out.stdout.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("null");
        serde_json::from_str(line).map_err(|_| {
            AppError::Docker(format!(
                "tdc-ctl {} 输出无法解析（镜像可能不是 tdc/claude-dev）：{}{}",
                args.join(" "),
                line.chars().take(200).collect::<String>(),
                out.stderr.chars().take(200).collect::<String>()
            ))
        })
    }

    /// 以 node 用户身份写入容器内文件（tar 流上传，内容不出现在命令行参数中）。
    /// 参数：name——容器名；path——容器内绝对路径；content——文件内容；mode——权限位；返回：成功与否。
    pub async fn write_file(&self, name: &str, path: &str, content: &[u8], mode: u32) -> AppResult<()> {
        self.write_file_owned(name, path, content, mode, APP_UID).await
    }

    /// 写入容器内文件并指定属主（容器无需运行；父目录必须已存在）。
    /// 参数：name——容器名；path——容器内绝对路径；content——内容；mode——权限位；uid——属主 uid（gid 相同）；返回：成功与否。
    pub async fn write_file_owned(&self, name: &str, path: &str, content: &[u8], mode: u32, uid: u64) -> AppResult<()> {
        let (dir, file) = path.rsplit_once('/').ok_or_else(|| AppError::Invalid(format!("路径无效：{path}")))?;
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(mode);
        header.set_uid(uid);
        header.set_gid(uid);
        header.set_mtime(
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        );
        let mut builder = tar::Builder::new(Vec::new());
        builder.append_data(&mut header, file, content)?;
        let bytes = builder.into_inner()?;
        self.inner
            .upload_to_container(
                name,
                Some(UploadToContainerOptions { path: dir.to_string(), ..Default::default() }),
                bollard::body_full(bytes.into()),
            )
            .await?;
        Ok(())
    }

    /// 订阅容器事件（start / die / destroy / create / rename / health_status）。
    /// 参数：on_event——回调（容器名, 动作）；返回：事件流结束（引擎断开）时返回。
    pub async fn watch_events<F: Fn(String, String) + Send>(&self, on_event: F) -> AppResult<()> {
        // 只订阅生命周期事件：exec_* 也属于 container 事件，而轮询本身就要 docker exec，
        // 不过滤会形成"exec → 事件 → 唤醒轮询 → 再 exec"的死循环（实测每秒十几次，压满 dockerd / containerd）
        let filters = HashMap::from([
            ("type".to_string(), vec!["container".to_string()]),
            ("label".to_string(), vec![format!("{LABEL_MANAGED}=true")]),
            ("event".to_string(), LIFECYCLE_ACTIONS.iter().map(|a| a.to_string()).collect()),
        ]);
        let mut stream = self.inner.events(Some(EventsOptions { filters: Some(filters), ..Default::default() }));
        while let Some(ev) = stream.next().await {
            let ev = ev?;
            let action = ev.action.unwrap_or_default();
            // 服务端过滤之外再兜底一次（旧引擎可能不支持 event 过滤）
            if !is_lifecycle_action(&action) {
                continue;
            }
            let name =
                ev.actor.and_then(|a| a.attributes).and_then(|attrs| attrs.get("name").cloned()).unwrap_or_default();
            on_event(name, action);
        }
        Ok(())
    }

    /// 底层 bollard 客户端（终端会话模块使用）。参数：无；返回：Docker 引用。
    pub fn raw(&self) -> &Docker {
        &self.inner
    }
}

/// 触发立即刷新的容器生命周期事件（health_status 的实际动作带后缀，如 "health_status: healthy"）。
const LIFECYCLE_ACTIONS: [&str; 10] =
    ["create", "start", "restart", "stop", "die", "destroy", "rename", "pause", "unpause", "health_status"];

/// 是否为生命周期事件（排除 exec_*、attach、resize、top 等由轮询与终端自身产生的事件）。
/// 参数：action——事件动作；返回：是否需要刷新。
fn is_lifecycle_action(action: &str) -> bool {
    let base = action.split(':').next().unwrap_or("").trim();
    LIFECYCLE_ACTIONS.contains(&base)
}

/// 把底层连接错误转为中文可操作提示。
/// 参数：host——连接地址；raw——原始错误文本；返回：提示文本（附原始错误便于排查）。
pub fn friendly_connect_error(host: &str, raw: &str) -> String {
    let hint = if host.starts_with("npipe://") {
        "未检测到 Docker Desktop：请安装并启动 Docker Desktop（WSL2 后端）"
    } else {
        "无法连接 Docker 引擎：请检查地址与引擎是否运行"
    };
    format!("{hint}（{host}；{raw}）")
}

/// 把 ContainerSummary 转为前端结构。
/// 参数：c——Docker 摘要；返回：ContainerInfo。
fn summary_to_info(c: ContainerSummary) -> ContainerInfo {
    let labels = c.labels.unwrap_or_default();
    let name =
        c.names.and_then(|n| n.into_iter().next()).map(|n| n.trim_start_matches('/').to_string()).unwrap_or_default();
    let running = c.state == Some(ContainerSummaryStateEnum::RUNNING);
    let state = c.state.map(|s| s.to_string()).unwrap_or_default();
    let mut ports: Vec<(u16, u16)> =
        c.ports.unwrap_or_default().into_iter().filter_map(|p| p.public_port.map(|pp| (p.private_port, pp))).collect();
    ports.sort();
    ports.dedup();
    let mounts = c
        .mounts
        .unwrap_or_default()
        .into_iter()
        .map(|m| MountInfo {
            kind: m.typ.unwrap_or_default(),
            source: m.name.or(m.source).unwrap_or_default(),
            destination: m.destination.unwrap_or_default(),
            rw: m.rw.unwrap_or(true),
        })
        .collect();
    ContainerInfo {
        id: c.id.unwrap_or_default(),
        name,
        image: c.image.unwrap_or_default(),
        state,
        status: c.status.unwrap_or_default(),
        running,
        slot: labels.get(LABEL_SLOT).and_then(|s| s.parse().ok()).unwrap_or(0),
        auth_mode: labels.get(LABEL_AUTH).cloned().unwrap_or_else(|| "subscription".into()),
        provider_id: labels.get(LABEL_PROVIDER).cloned(),
        shared_group: labels.get(LABEL_GROUP).cloned().unwrap_or_default(),
        ports,
        mounts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 只有生命周期事件触发刷新() {
        for a in ["start", "die", "destroy", "create", "rename", "health_status: healthy", "health_status: unhealthy"] {
            assert!(is_lifecycle_action(a), "{a} 应触发刷新");
        }
        for a in [
            "exec_create: /opt/tdc/tdc-ctl.sh snapshot",
            "exec_start: sh",
            "exec_die",
            "attach",
            "resize",
            "top",
            "kill",
            "",
        ] {
            assert!(!is_lifecycle_action(a), "{a} 不应触发刷新（否则轮询自身的 exec 会形成死循环）");
        }
    }
}
