//! Per-container opt-in Git credential forwarding over Docker's existing exec channel.
pub mod host;
#[cfg(test)]
mod tests;
use crate::config::store::write_json_atomic;
use crate::docker::{client::DockerClient, spec};
use crate::error::{AppError, AppResult};
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

const SCRIPT: &str = "/opt/tdc/tdc-git-bridge.mjs";
#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Sharing {
    pub enabled: bool,
    pub allowed_hosts: Vec<String>,
    pub sync_identity: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Binding {
    name: String,
    container_id: String,
    config: Sharing,
}
struct Running {
    task: tokio::task::JoinHandle<()>,
    connected: Arc<AtomicBool>,
    engine: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub config: Sharing,
    pub container_id: String,
    pub running: bool,
    pub connected: bool,
    pub git_available: bool,
    pub helper_configured: bool,
    pub identity: host::Identity,
}
pub struct GitBridge {
    dir: PathBuf,
    path: PathBuf,
    data: Mutex<HashMap<String, Binding>>,
    active: Mutex<HashMap<String, Running>>,
    gate: tokio::sync::Mutex<()>,
}
impl GitBridge {
    pub fn load(dir: &Path) -> AppResult<Self> {
        let path = dir.join("git-sharing.json");
        let data = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(error) => return Err(error.into()),
        };
        Ok(Self {
            dir: dir.into(),
            path,
            data: Mutex::new(data),
            active: Mutex::new(HashMap::new()),
            gate: tokio::sync::Mutex::new(()),
        })
    }
    fn save(&self, name: &str, value: Option<Binding>) -> AppResult<()> {
        let mut data = self.data.lock();
        let mut next = data.clone();
        if let Some(value) = value {
            next.insert(name.to_string(), value);
        } else {
            next.remove(name);
        }
        write_json_atomic(&self.path, &next)?;
        *data = next;
        Ok(())
    }
    fn stop(&self, id: &str) {
        if let Some(active) = self.active.lock().remove(id) {
            active.connected.store(false, Ordering::SeqCst);
            active.task.abort();
        }
    }
    async fn inspect(docker: &DockerClient, name: &str) -> AppResult<(String, bool)> {
        if !docker.accepts_local_paths() {
            return Err(AppError::Invalid("宿主 Git 凭据仅支持本机 Docker 引擎".into()));
        }
        let inspect = docker.inspect(name).await?;
        if inspect
            .config
            .as_ref()
            .and_then(|v| v.labels.as_ref())
            .and_then(|v| v.get(spec::LABEL_MANAGED))
            .map(String::as_str)
            != Some("true")
        {
            return Err(AppError::Invalid("只允许为本工具管理的容器配置 Git 凭据".into()));
        }
        Ok((
            inspect.id.ok_or_else(|| AppError::Other("容器缺少 ID".into()))?,
            inspect.state.and_then(|s| s.running).unwrap_or(false),
        ))
    }
    pub async fn view(&self, docker: &DockerClient, name: &str) -> AppResult<View> {
        let (id, running) = Self::inspect(docker, name).await?;
        let config =
            self.data.lock().get(name).filter(|b| b.container_id == id).map(|b| b.config.clone()).unwrap_or_default();
        let connected =
            self.active.lock().get(&id).is_some_and(|a| a.connected.load(Ordering::SeqCst) && !a.task.is_finished());
        let git_available = host::git(&self.dir, &["--version"], None).await.ok().flatten().is_some();
        let helper_configured = host::git(&self.dir, &["config", "--get-all", "credential.helper"], None)
            .await
            .ok()
            .flatten()
            .is_some_and(|v| !v.trim().is_empty());
        let identity = host::identity(&self.dir).await.unwrap_or_default();
        Ok(View { config, container_id: id, running, connected, git_available, helper_configured, identity })
    }
    pub async fn apply(
        &self,
        docker: &DockerClient,
        name: &str,
        expected: &str,
        mut config: Sharing,
    ) -> AppResult<View> {
        let _guard = self.gate.lock().await;
        let (id, running) = Self::inspect(docker, name).await?;
        if id != expected {
            return Err(AppError::Invalid("容器已重建，请重新打开 Git 设置".into()));
        }
        if config.enabled {
            config.allowed_hosts = host::normalize_hosts(&config.allowed_hosts)?;
        }
        if config.enabled && config.allowed_hosts.is_empty() {
            return Err(AppError::Invalid("请至少填写一个允许访问的 Git 域名".into()));
        }
        if !config.enabled {
            let had_binding = self.data.lock().get(name).is_some_and(|binding| binding.container_id == id);
            // Revoke in the host first, including when the container is stopped.
            self.save(name, None)?;
            self.stop(&id);
            if running {
                docker
                    .write_file_owned(
                        &id,
                        SCRIPT,
                        include_bytes!("../../../docker/rootfs/opt/tdc/tdc-git-bridge.mjs"),
                        0o755,
                        0,
                    )
                    .await?;
                let result = docker.exec(&id, &["node", SCRIPT, "disable"], None).await?;
                if result.exit_code != Some(0) {
                    return Err(AppError::Other("授权已撤销，但容器 Git 配置清理失败，请启动后重试关闭".into()));
                }
            } else if had_binding {
                // A stopped container cannot run git config; an empty include restores its old values.
                docker.write_file(&id, "/home/node/.claude/tdc/git-bridge/config", b"", 0o600).await?;
            }
        } else {
            if !running {
                return Err(AppError::Invalid("请先启动容器，再启用宿主 Git 凭据".into()));
            }
            if host::git(&self.dir, &["--version"], None).await?.is_none() {
                return Err(AppError::Invalid("宿主 Git 不可用".into()));
            }
            let binding = Binding { name: name.into(), container_id: id.clone(), config };
            self.stop(&id);
            if let Err(error) = self.start(docker, &binding).await {
                let _ = docker.exec(&id, &["node", SCRIPT, "disable"], None).await;
                return Err(error);
            }
            if let Err(error) = self.save(name, Some(binding)) {
                self.stop(&id);
                let _ = docker.exec(&id, &["node", SCRIPT, "disable"], None).await;
                return Err(error);
            }
        }
        self.view(docker, name).await
    }
    async fn start(&self, docker: &DockerClient, binding: &Binding) -> AppResult<()> {
        docker
            .write_file_owned(
                &binding.container_id,
                SCRIPT,
                include_bytes!("../../../docker/rootfs/opt/tdc/tdc-git-bridge.mjs"),
                0o755,
                0,
            )
            .await?;
        let attached = docker.git_bridge_exec(&binding.container_id, SCRIPT).await?;
        let identity =
            if binding.config.sync_identity { host::identity(&self.dir).await? } else { host::Identity::default() };
        let dir = self.dir.clone();
        let hosts = binding.config.allowed_hosts.clone();
        let connected = Arc::new(AtomicBool::new(false));
        let flag = connected.clone();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            relay(attached, dir, hosts, identity, flag.clone(), ready_tx).await;
            flag.store(false, Ordering::SeqCst);
        });
        match tokio::time::timeout(Duration::from_secs(20), ready_rx).await {
            Ok(Ok(true)) => {
                self.active.lock().insert(
                    binding.container_id.clone(),
                    Running { task, connected, engine: docker.connection_key().into() },
                );
                Ok(())
            }
            _ => {
                task.abort();
                Err(AppError::Other("容器 Git 凭据桥接启动失败，未保存开关；请检查 Git 与 node 是否可用".into()))
            }
        }
    }
    pub async fn reconcile(&self, docker: Option<&DockerClient>) {
        let _guard = self.gate.lock().await;
        let Some(docker) = docker.filter(|d| d.accepts_local_paths()) else {
            for (_, value) in self.active.lock().drain() {
                value.task.abort();
            }
            return;
        };
        let bindings: Vec<_> = self.data.lock().values().cloned().collect();
        for binding in bindings {
            if !binding.config.enabled
                || host::normalize_hosts(&binding.config.allowed_hosts).is_err()
                || binding.config.allowed_hosts.is_empty()
            {
                self.stop(&binding.container_id);
                continue;
            }
            if self
                .active
                .lock()
                .get(&binding.container_id)
                .is_some_and(|v| !v.task.is_finished() && v.engine == docker.connection_key())
            {
                continue;
            }
            self.stop(&binding.container_id);
            if matches!(Self::inspect(docker, &binding.container_id).await, Ok((ref id, true)) if *id == binding.container_id)
            {
                let _ = self.start(docker, &binding).await;
            }
        }
    }
}
impl Drop for GitBridge {
    fn drop(&mut self) {
        for (_, active) in self.active.get_mut().drain() {
            active.connected.store(false, Ordering::SeqCst);
            active.task.abort();
        }
    }
}
async fn relay(
    attached: bollard::exec::StartExecResults,
    dir: PathBuf,
    hosts: Vec<String>,
    identity: host::Identity,
    connected: Arc<AtomicBool>,
    ready: tokio::sync::oneshot::Sender<bool>,
) {
    let bollard::exec::StartExecResults::Attached { mut input, mut output } = attached else {
        return;
    };
    let init = serde_json::json!({"type":"init", "allowedHosts":hosts, "identity":identity}).to_string() + "\n";
    if input.write_all(init.as_bytes()).await.is_err() {
        return;
    }
    let mut ready = Some(ready);
    let mut buffer = Vec::new();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    loop {
        tokio::select! {
            _ = heartbeat.tick() => { if input.write_all(b"{\"type\":\"ping\"}\n").await.is_err() { return; } }
            chunk = output.next() => {
                let Some(Ok(bollard::container::LogOutput::StdOut { message })) = chunk else { return; };
                buffer.extend_from_slice(&message);
                if buffer.len() > 65536 { return; }
                while let Some(index) = buffer.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = buffer.drain(..=index).collect();
                    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&line) else { return; };
                    if value["type"] == "ready" {
                        connected.store(true, Ordering::SeqCst);
                        if let Some(ready) = ready.take() { let _ = ready.send(true); }
                    } else if value["type"] == "request" && connected.load(Ordering::SeqCst) {
                        let Some(id) = value["id"].as_str().filter(|s| s.len() <= 64) else { return; };
                        let credential = match serde_json::from_value::<host::CredentialRequest>(value["credential"].clone()) {
                            Ok(request) => host::fill(&dir, &request, &hosts).await,
                            Err(_) => None,
                        };
                        let response = serde_json::json!({"type":"response", "id":id, "credential":credential}).to_string() + "\n";
                        if input.write_all(response.as_bytes()).await.is_err() { return; }
                    } else if value["type"] == "error" { return; }
                }
            }
        }
    }
}
