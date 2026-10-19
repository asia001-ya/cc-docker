//! 额度轮询：周期对运行中的 tdc 容器执行 `tdc-ctl snapshot`，汇总为前端视图并广播事件。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::model::{
    AccountInfo, ContainerSnapshot, Health, PortsFile, ProviderSummary, ProxyStatus, QuotaSnapshot, SessionSnapshot,
};
use super::switch::{blocked_until, health_of, remaining_of, QuotaInput, Remaining};
use crate::config::store::QuotaSettings;
use crate::docker::client::{ContainerInfo, DockerClient};
use crate::ports::{build_links, PortLink};

/// 事件：全部容器状态刷新。
pub const EVT_FLEET: &str = "fleet://update";
/// 事件：某容器额度达到切换阈值（从未耗尽变为耗尽时触发一次）。
pub const EVT_EXHAUSTED: &str = "quota://exhausted";
/// 事件：某容器代理进入 blackhole / leak 状态（状态变化时触发一次）。
pub const EVT_PROXY_ALERT: &str = "proxy://alert";

/// 单个容器的汇总视图。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetEntry {
    /// 容器基本信息
    pub container: ContainerInfo,
    /// 健康状态
    pub health: Health,
    /// 剩余额度
    pub remaining: Option<Remaining>,
    /// 额度快照
    pub quota: Option<QuotaSnapshot>,
    /// 耗尽时的恢复时间
    pub blocked_until: Option<i64>,
    /// 账号
    pub account: Option<AccountInfo>,
    /// 供应商模式（容器内实际生效的）
    pub provider: Option<ProviderSummary>,
    /// 端口链接
    pub ports: Vec<PortLink>,
    /// 会话快照（含 Claude session_id）
    pub sessions: Vec<SessionSnapshot>,
    /// 最近一次快照失败原因（例如镜像不含 /opt/tdc）
    pub error: Option<String>,
    /// 终端输出中检测到限额提示
    pub limit_hit: bool,
    /// 容器内代理实际状态
    pub proxy: Option<ProxyStatus>,
}

impl FleetEntry {
    /// Apply a confirmed account refresh to all quota-derived fields together.
    pub fn update_quota(&mut self, quota: QuotaSnapshot, now: i64, settings: &QuotaSettings) {
        self.quota = Some(quota);
        self.limit_hit = false;
        let input = QuotaInput {
            name: self.container.name.clone(),
            running: self.container.running,
            auth_mode: self
                .provider
                .as_ref()
                .map(|provider| provider.mode.clone())
                .filter(|mode| !mode.is_empty())
                .unwrap_or_else(|| self.container.auth_mode.clone()),
            quota: self.quota.clone(),
            limit_hit: false,
        };
        self.health = health_of(&input, now, settings);
        self.remaining = remaining_of(self.quota.as_ref(), now);
        self.blocked_until = blocked_until(self.quota.as_ref(), now, settings.switch_threshold);
    }
}

/// 全部容器视图。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FleetState {
    /// 引擎是否可用
    pub engine_ok: bool,
    /// 引擎错误
    pub engine_error: Option<String>,
    /// ping 延迟
    pub latency_ms: Option<u64>,
    /// 引擎版本
    pub engine_version: Option<String>,
    /// 容器列表
    pub entries: Vec<FleetEntry>,
    /// 生成时间（epoch 秒）
    pub generated_at: i64,
}

/// 耗尽事件载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExhaustedPayload {
    /// 容器名
    pub container: String,
    /// 恢复时间
    pub blocked_until: Option<i64>,
    /// 触发原因：quota / limit_text
    pub reason: String,
}

/// 代理告警事件载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyAlertPayload {
    /// 容器名
    pub container: String,
    /// blackhole / leak
    pub state: String,
    /// 最近一次错误
    pub last_error: Option<String>,
}

/// 轮询器共享状态。
#[derive(Default)]
pub struct PollerState {
    /// 最近一次汇总
    pub fleet: FleetState,
    /// 已广播过耗尽事件的容器（恢复后移除）
    exhausted: HashMap<String, bool>,
    /// 终端限额提示命中（容器名 → 命中时间），额度刷新后清除
    pub limit_hits: HashMap<String, i64>,
    /// 调试注入的额度（仅 dev 构建使用）
    pub injected: HashMap<String, QuotaSnapshot>,
    /// 上一轮的代理状态（用于只在状态变化时告警）
    proxy_states: HashMap<String, String>,
}

/// 当前 epoch 秒。参数：无；返回：秒。
pub fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// 执行一轮采集并更新共享状态。
/// 参数：app——Tauri 句柄；docker——客户端（None 表示未连接）；state——共享状态；settings——额度设置；返回：新汇总。
pub async fn poll_once(
    app: &AppHandle,
    docker: Option<&DockerClient>,
    state: &Arc<Mutex<PollerState>>,
    settings: &QuotaSettings,
) -> FleetState {
    let now = now_secs();
    let mut fleet = FleetState { generated_at: now, ..Default::default() };
    let Some(docker) = docker else {
        fleet.engine_error = Some("未连接 Docker 引擎".into());
        state.lock().fleet = fleet.clone();
        let _ = app.emit(EVT_FLEET, &fleet);
        return fleet;
    };
    match docker.engine_info().await {
        Ok(info) => {
            fleet.engine_ok = true;
            fleet.latency_ms = Some(info.latency_ms);
            fleet.engine_version = Some(info.version);
        }
        Err(e) => {
            fleet.engine_error = Some(e.to_string());
            state.lock().fleet = fleet.clone();
            let _ = app.emit(EVT_FLEET, &fleet);
            return fleet;
        }
    }
    let containers = docker.list(false).await.unwrap_or_default();

    // 并发采集各容器快照
    let snaps = futures_util::future::join_all(containers.iter().map(|c| async move {
        if !c.running {
            return (c.name.clone(), Ok(None));
        }
        if let Err(error) = super::runtime::ensure(docker, &c.id).await {
            return (c.name.clone(), Err(error.to_string()));
        }
        match docker.tdc_ctl(&c.name, &["snapshot"]).await {
            Ok(v) => {
                (c.name.clone(), serde_json::from_value::<ContainerSnapshot>(v).map(Some).map_err(|e| e.to_string()))
            }
            Err(e) => (c.name.clone(), Err(e.to_string())),
        }
    }))
    .await;
    let snap_map: HashMap<String, Result<Option<ContainerSnapshot>, String>> = snaps.into_iter().collect();

    let mut newly_exhausted = Vec::new();
    let mut proxy_alerts = Vec::new();
    {
        let mut st = state.lock();
        for c in containers {
            let (snap, error) = match snap_map.get(&c.name) {
                Some(Ok(s)) => (s.clone(), None),
                Some(Err(e)) => (None, Some(e.clone())),
                None => (None, None),
            };
            let quota = st.injected.get(&c.name).cloned().or_else(|| snap.as_ref().and_then(|s| s.quota.clone()));
            // 额度数据比限额提示更新时，清除文本命中标记
            if let (Some(hit_at), Some(q)) = (st.limit_hits.get(&c.name).copied(), quota.as_ref()) {
                if q.rate_limits_updated_at.is_some_and(|t| t > hit_at + 60) {
                    st.limit_hits.remove(&c.name);
                }
            }
            let limit_hit = st.limit_hits.contains_key(&c.name);
            let provider = snap.as_ref().and_then(|s| s.provider.clone());
            let auth_mode = provider
                .as_ref()
                .map(|p| p.mode.clone())
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| c.auth_mode.clone());
            let input =
                QuotaInput { name: c.name.clone(), running: c.running, auth_mode, quota: quota.clone(), limit_hit };
            let health = health_of(&input, now, settings);

            let was = st.exhausted.get(&c.name).copied().unwrap_or(false);
            let is = health == Health::Exhausted;
            if is && !was {
                newly_exhausted.push(ExhaustedPayload {
                    container: c.name.clone(),
                    blocked_until: blocked_until(quota.as_ref(), now, settings.switch_threshold),
                    reason: if limit_hit { "limit_text".into() } else { "quota".into() },
                });
            }
            st.exhausted.insert(c.name.clone(), is);

            let proxy = snap.as_ref().and_then(|s| s.proxy.clone());
            if let Some(p) = proxy.as_ref() {
                let prev = st.proxy_states.insert(c.name.clone(), p.state.clone());
                if p.alarming() && prev.as_deref() != Some(p.state.as_str()) {
                    proxy_alerts.push(ProxyAlertPayload {
                        container: c.name.clone(),
                        state: p.state.clone(),
                        last_error: p.last_error.clone(),
                    });
                }
            }

            let ports = snap.as_ref().and_then(|s| s.ports.clone()).unwrap_or_else(PortsFile::default);
            fleet.entries.push(FleetEntry {
                remaining: remaining_of(quota.as_ref(), now),
                blocked_until: blocked_until(quota.as_ref(), now, settings.switch_threshold),
                ports: build_links(&ports.ports, &c.ports),
                account: snap.as_ref().and_then(|s| s.account.clone()),
                sessions: snap.as_ref().map(|s| s.sessions.clone()).unwrap_or_default(),
                provider,
                health,
                quota,
                error,
                limit_hit,
                proxy,
                container: c,
            });
        }
        st.fleet = fleet.clone();
    }
    let _ = app.emit(EVT_FLEET, &fleet);
    for p in newly_exhausted {
        let _ = app.emit(EVT_EXHAUSTED, p);
    }
    for p in proxy_alerts {
        let _ = app.emit(EVT_PROXY_ALERT, p);
    }
    fleet
}

/// 轮询主循环（随应用生命周期运行）。
/// 参数：app——Tauri 句柄；get_docker / get_settings——每轮读取最新客户端与设置；state——共享状态；wake——立即刷新信号；返回：不返回。
pub async fn run_loop<D, S>(
    app: AppHandle,
    get_docker: D,
    get_settings: S,
    state: Arc<Mutex<PollerState>>,
    wake: Arc<tokio::sync::Notify>,
) where
    D: Fn() -> Option<DockerClient> + Send + 'static,
    S: Fn() -> QuotaSettings + Send + 'static,
{
    loop {
        let settings = get_settings();
        let docker = get_docker();
        poll_once(&app, docker.as_ref(), &state, &settings).await;
        let secs = settings.refresh_secs.clamp(2, 300) as u64;
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(secs)) => {}
            _ = wake.notified() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quota::model::QuotaWindow;

    #[test]
    fn 账号刷新同时更新摘要健康度和限额标记() {
        let mut entry = FleetEntry {
            container: ContainerInfo {
                id: "fixture".into(),
                name: "fixture".into(),
                image: "tdc/claude-dev:test".into(),
                state: "running".into(),
                status: "Up".into(),
                running: true,
                slot: 1,
                auth_mode: "subscription".into(),
                provider_id: None,
                shared_group: String::new(),
                ports: Vec::new(),
                mounts: Vec::new(),
            },
            health: Health::Exhausted,
            remaining: Some(Remaining { remaining: 0.0, inferred: false }),
            quota: None,
            blocked_until: Some(300),
            account: None,
            provider: None,
            ports: Vec::new(),
            sessions: Vec::new(),
            error: None,
            limit_hit: true,
            proxy: None,
        };
        let quota = QuotaSnapshot {
            five_hour: Some(QuotaWindow { used_percentage: 10.0, resets_at: Some(200) }),
            seven_day: Some(QuotaWindow { used_percentage: 20.0, resets_at: Some(300) }),
            ..Default::default()
        };
        entry.update_quota(quota.clone(), 100, &QuotaSettings::default());
        assert_eq!(entry.quota, Some(quota));
        assert_eq!(entry.health, Health::Healthy);
        assert_eq!(entry.remaining, Some(Remaining { remaining: 80.0, inferred: false }));
        assert!(!entry.limit_hit);
        assert_eq!(entry.blocked_until, None);

        let settings = QuotaSettings { switch_threshold: 15.0, ..Default::default() };
        entry.update_quota(entry.quota.clone().unwrap(), 100, &settings);
        assert_eq!(entry.health, Health::Exhausted);
        assert_eq!(entry.blocked_until, Some(300));
    }
}
