//! 全局状态：配置、供应商、代理、Docker 客户端、会话管理器、额度轮询共享状态。

use std::sync::Arc;

use parking_lot::{Mutex, RwLock};

use crate::config::store::ConfigStore;
use crate::docker::client::DockerClient;
use crate::docker::image_build::BuildTracker;
use crate::error::{AppError, AppResult};
use crate::providers::ProviderStore;
use crate::proxy::ProxyStore;
use crate::quota::poller::PollerState;
use crate::terminal::manager::SessionManager;

/// Tauri 托管的应用状态。
pub struct AppState {
    pub git_bridge: Arc<crate::git_bridge::GitBridge>,
    /// 设置与会话元数据
    pub config: Arc<ConfigStore>,
    /// API 供应商
    pub providers: Arc<ProviderStore>,
    /// 本地用量去重账本；不包含对话内容或凭据。
    pub usage: Arc<crate::usage::store::UsageStore>,
    /// 代理节点库与容器绑定
    pub proxies: Arc<ProxyStore>,
    /// Docker 客户端（设置中修改地址后可重建）
    pub docker: Arc<RwLock<Option<DockerClient>>>,
    /// 终端会话
    pub sessions: SessionManager,
    /// 额度轮询共享状态
    pub poller: Arc<Mutex<PollerState>>,
    /// 立即刷新信号
    pub wake: Arc<tokio::sync::Notify>,
    /// 标准镜像构建进度（同一时刻只允许一次构建）
    pub image_build: Arc<Mutex<BuildTracker>>,
}

impl AppState {
    /// 取得 Docker 客户端副本。参数：无；返回：客户端或 DockerUnavailable。
    pub fn docker(&self) -> AppResult<DockerClient> {
        self.docker.read().clone().ok_or_else(|| AppError::DockerUnavailable("尚未连接 Docker 引擎".into()))
    }

    /// 按当前设置重建 Docker 客户端。参数：无；返回：成功与否。
    pub fn reconnect(&self) -> AppResult<()> {
        let host = self.config.settings().docker.host;
        let client = DockerClient::connect(&host)?;
        *self.docker.write() = Some(client);
        self.wake.notify_one();
        Ok(())
    }
}
