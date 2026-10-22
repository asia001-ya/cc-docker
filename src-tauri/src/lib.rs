//! tht-docker-claude 后端入口：组装状态、注册命令、启动额度轮询与 Docker 事件监听。

pub mod commands;
pub mod config;
pub mod docker;
pub mod error;
pub mod git_bridge;
pub mod memory;
pub mod ports;
pub mod providers;
pub mod proxy;
pub mod quota;
pub mod state;
pub mod terminal;
pub mod updates;
pub mod usage;

use std::sync::Arc;
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{Emitter, Manager};

use crate::config::store::ConfigStore;
use crate::docker::client::DockerClient;
use crate::providers::ProviderStore;
use crate::proxy::ProxyStore;
use crate::quota::poller::{self, PollerState};
use crate::state::AppState;
use crate::terminal::manager::{SessionManager, EVT_LIMIT_HIT};

/// 事件：容器生命周期变化（start / die / destroy ...）。
pub const EVT_CONTAINER: &str = "docker://container";

/// 应用入口。参数：无；返回：无（阻塞直到应用退出）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 第二次启动时唤起已有窗口
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // WebView2 默认拒绝 navigator.clipboard.read*，Ctrl+Shift+V 与 OSC 52 读剪贴板依赖它
        .on_permission_request(|_, kind| match kind {
            PermissionKind::ClipboardRead => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .setup(|app| {
            let dir = app.path().app_config_dir().expect("无法定位应用配置目录");
            let wallpaper_dir = app.path().app_data_dir().expect("无法定位应用数据目录").join("wallpapers");
            let config = Arc::new(ConfigStore::load_with_wallpaper_dir(dir.clone(), wallpaper_dir));
            let update_cache = app.path().app_cache_dir()?.join("updates");
            updates::install::cleanup_cache(&update_cache);
            let updates = Arc::new(updates::UpdateManager::load(
                update_cache,
                std::env::current_exe()?,
                app.package_info().version.to_string(),
            ));
            tauri::async_runtime::spawn(updates::run_loop(app.handle().clone(), updates.clone(), config.clone()));
            app.manage(updates);
            let providers = Arc::new(ProviderStore::load(&dir)?);
            let usage = Arc::new(crate::usage::store::UsageStore::load(&dir));
            let proxies = Arc::new(ProxyStore::load(&dir));
            let settings = config.settings();
            let docker = DockerClient::connect(&settings.docker.host).ok();
            let state = AppState {
                git_bridge: Arc::new(crate::git_bridge::GitBridge::load(&dir)?),
                config: config.clone(),
                providers,
                usage,
                proxies,
                docker: Arc::new(RwLock::new(docker)),
                sessions: SessionManager::new(app.handle().clone(), settings.quota.limit_patterns.clone()),
                poller: Arc::new(Mutex::new(PollerState::default())),
                wake: Arc::new(tokio::sync::Notify::new()),
                image_build: Arc::new(Mutex::new(Default::default())),
            };

            // 额度轮询
            {
                let docker = state.docker.clone();
                let cfg = config.clone();
                tauri::async_runtime::spawn(poller::run_loop(
                    app.handle().clone(),
                    move || docker.read().clone(),
                    move || cfg.settings().quota,
                    state.poller.clone(),
                    state.wake.clone(),
                ));
            }

            // Docker 事件流：容器启停时立即刷新；引擎断开后每 5 秒重试
            {
                let docker = state.docker.clone();
                let usage = state.usage.clone();
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        let client = docker.read().clone();
                        crate::usage::collector::refresh(client.as_ref(), &usage).await;
                        let _ = handle.emit("usage://update", ());
                        tokio::time::sleep(Duration::from_secs(30)).await;
                    }
                });
            }

            // Docker 事件流：容器启停时立即刷新；引擎断开后每 5 秒重试
            {
                let docker = state.docker.clone();
                let wake = state.wake.clone();
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        let client = docker.read().clone();
                        if let Some(c) = client {
                            let h = handle.clone();
                            let w = wake.clone();
                            let _ = c
                                .watch_events(move |name, action| {
                                    let _ =
                                        h.emit(EVT_CONTAINER, serde_json::json!({ "name": name, "action": action }));
                                    w.notify_one();
                                })
                                .await;
                        }
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                });
            }

            // 终端限额文案命中：记录到轮询状态并立即刷新，由轮询器统一判定耗尽并发事件
            {
                let poller_state = state.poller.clone();
                let wake = state.wake.clone();
                use tauri::Listener;
                app.listen(EVT_LIMIT_HIT, move |ev| {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(ev.payload()) {
                        if let Some(c) = v["container"].as_str() {
                            poller_state.lock().limit_hits.insert(c.to_string(), poller::now_secs());
                            wake.notify_one();
                        }
                    }
                });
            }

            {
                let bridge = state.git_bridge.clone();
                let docker = state.docker.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        let client = docker.read().clone();
                        bridge.reconcile(client.as_ref()).await;
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                });
            }
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::container_cmds::engine_info,
            commands::memory_cmds::memory_analyze,
            commands::memory_cmds::memory_cleanup,
            commands::memory_cmds::memory_reclaim_status,
            commands::memory_cmds::memory_reclaim,
            commands::memory_cmds::memory_compact,
            commands::container_cmds::fleet_get,
            commands::container_cmds::fleet_refresh,
            commands::container_cmds::container_quota_refresh,
            commands::container_edit_cmds::container_edit_get,
            commands::container_edit_cmds::container_edit_precheck,
            commands::container_edit_cmds::container_edit_apply,
            commands::container_cmds::container_list,
            commands::container_cmds::container_working_dir,
            commands::container_cmds::container_directories,
            commands::container_cmds::container_defaults,
            commands::container_cmds::container_precheck,
            commands::container_cmds::container_create,
            commands::host_config_cmds::host_config_defaults,
            commands::host_config_cmds::container_host_config_get,
            commands::host_config_cmds::container_host_config_precheck,
            commands::host_config_cmds::container_host_config_apply,
            commands::git_cmds::container_git_get,
            commands::git_cmds::container_git_apply,
            commands::container_cmds::container_action,
            commands::container_cmds::container_remove,
            commands::container_cmds::container_account,
            commands::container_cmds::container_set_provider,
            commands::container_cmds::container_import_credentials,
            commands::container_cmds::shared_group_apply,
            commands::image_cmds::image_status,
            commands::image_cmds::image_build,
            commands::term_cmds::term_open,
            commands::term_cmds::term_attach,
            commands::term_cmds::term_detach,
            commands::term_cmds::term_write,
            commands::term_cmds::term_paste_image,
            commands::term_cmds::term_resize,
            commands::term_cmds::term_scrollback,
            commands::term_cmds::term_close,
            commands::term_cmds::term_rename,
            commands::term_cmds::term_records,
            commands::term_cmds::term_list,
            commands::output_cmds::term_outputs,
            commands::term_cmds::switch_candidates,
            commands::term_cmds::switch_execute,
            commands::term_cmds::debug_inject_quota,
            commands::settings_cmds::settings_get,
            commands::settings_cmds::settings_set,
            commands::update_cmds::update_status,
            commands::update_cmds::update_check,
            commands::update_cmds::update_download,
            commands::update_cmds::update_install,
            commands::wallpaper_cmds::wallpaper_import,
            commands::wallpaper_cmds::wallpaper_resolve,
            commands::wallpaper_cmds::wallpaper_delete,
            commands::settings_cmds::docker_test,
            commands::settings_cmds::provider_list,
            commands::settings_cmds::provider_save,
            commands::settings_cmds::provider_delete,
            commands::settings_cmds::provider_binding,
            commands::usage_cmds::usage_query,
            commands::usage_cmds::usage_refresh,
            commands::usage_cmds::usage_enable,
            commands::proxy_cmds::proxy_node_list,
            commands::proxy_cmds::proxy_node_save,
            commands::proxy_cmds::proxy_node_delete,
            commands::proxy_cmds::proxy_get,
            commands::proxy_cmds::proxy_apply,
            commands::proxy_cmds::proxy_preflight,
            commands::proxy_cmds::proxy_off,
            commands::proxy_cmds::proxy_nodes,
            commands::proxy_cmds::proxy_select,
            commands::proxy_cmds::proxy_delay,
            commands::proxy_cmds::proxy_refresh,
            commands::proxy_cmds::proxy_capability_apply,
        ])
        .build(tauri::generate_context!())
        .expect("启动 Tauri 应用失败")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { code, .. } = event {
                // 更新并重启已经启动助手；正常关闭窗口时才自动安排退出后安装。
                if code.is_none() && app.state::<AppState>().config.settings().updates.install_on_exit {
                    app.state::<Arc<updates::UpdateManager>>().install_on_exit(app);
                }
            }
        });
}
