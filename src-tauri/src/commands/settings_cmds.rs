//! 设置与供应商命令。

use tauri::State;

use crate::config::store::{ConfigStore, Settings};
use crate::docker::client::{DockerClient, EngineInfo};
use crate::error::AppResult;
use crate::providers::{ProviderProfile, ProviderView};
use crate::state::AppState;

/// 读取设置。参数：state——全局状态；返回：设置。
#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Settings {
    state.config.settings()
}

/// 保存设置；Docker 地址变化时重连。参数：state——全局状态；settings——新设置；返回：成功与否。
#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, settings: Settings) -> AppResult<()> {
    let limit_patterns = settings.quota.limit_patterns.clone();
    let new_client = save_settings_with_reconnect(&state.config, settings, DockerClient::connect)?;
    state.sessions.set_limit_patterns(limit_patterns);
    if let Some(client) = new_client {
        *state.docker.write() = Some(client);
    }
    state.wake.notify_one();
    Ok(())
}

/// 先完成可能失败的连接构造，再持久化；错误返回不能同时偷偷保存壁纸草稿。
fn save_settings_with_reconnect<C>(
    config: &ConfigStore,
    settings: Settings,
    connect: impl FnOnce(&str) -> AppResult<C>,
) -> AppResult<Option<C>> {
    let client = if config.settings().docker.host != settings.docker.host {
        Some(connect(&settings.docker.host)?)
    } else {
        None
    };
    config.set_settings(settings)?;
    Ok(client)
}

/// 测试 Docker 连接（不保存）。参数：host——地址；返回：引擎信息。
#[tauri::command]
pub async fn docker_test(host: String) -> AppResult<EngineInfo> {
    DockerClient::connect(&host)?.engine_info().await
}

/// 列出供应商。参数：state——全局状态；返回：供应商列表。
#[tauri::command]
pub fn provider_list(state: State<'_, AppState>) -> Vec<ProviderView> {
    state.providers.list()
}

/// 保存供应商。参数：state——全局状态；profile——配置；token——Token（None 不修改）；返回：保存后的配置。
#[tauri::command]
pub async fn provider_save(
    state: State<'_, AppState>,
    profile: ProviderProfile,
    token: Option<String>,
) -> AppResult<ProviderProfile> {
    // 计费配置是 Claude 进程启动时的不可变快照。不要改写运行中容器的
    // usage-provider.json，否则同一个 Claude 进程后续请求会混用新旧价格。
    // 新配置会在下一次容器启动 / 重新应用供应商时写入。
    state.providers.save(profile, token)
}

/// 删除供应商。参数：state——全局状态；id——供应商 ID；返回：成功与否。
#[tauri::command]
pub fn provider_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.providers.delete(&id)
}

/// 查询容器绑定的供应商。参数：state——全局状态；container——容器名；返回：供应商 ID。
#[tauri::command]
pub fn provider_binding(state: State<'_, AppState>, container: String) -> Option<String> {
    state.providers.binding_of(&container)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::wallpaper::tests::TestDirectory;
    use crate::config::wallpaper::WallpaperKind;
    use crate::error::AppError;

    #[test]
    fn 连接构造失败不保存同一草稿中的壁纸或其它设置() {
        let directory = TestDirectory::new();
        let config_dir = directory.0.join("config");
        let config = ConfigStore::load(config_dir.clone());
        let saved = config.settings();
        config.set_settings(saved.clone()).unwrap();
        let asset = config.import_wallpaper(&directory.image("draft.png"), WallpaperKind::Image).unwrap();
        let mut draft = saved.clone();
        draft.docker.host = "invalid://docker-host".into();
        draft.wallpaper.asset = Some(asset.clone());
        draft.terminal.font_size = 22;
        let result = save_settings_with_reconnect(&config, draft, |_| -> AppResult<()> {
            Err(AppError::DockerUnavailable("测试连接失败".into()))
        });
        assert!(result.is_err());
        assert_eq!(config.settings().wallpaper, saved.wallpaper);
        let persisted = ConfigStore::load(config_dir).settings();
        assert_eq!(persisted.docker.host, saved.docker.host);
        assert_eq!(persisted.terminal.font_size, saved.terminal.font_size);
        assert_eq!(persisted.wallpaper, saved.wallpaper);
        config.delete_wallpaper(&asset.file_name).unwrap();
    }

    #[test]
    fn 连接准备发生在落盘前且未改地址时无需重连() {
        let directory = TestDirectory::new();
        let config = ConfigStore::load(directory.0.join("config"));
        let mut draft = config.settings();
        draft.docker.host = "tcp://127.0.0.1:2375".into();
        let client = save_settings_with_reconnect(&config, draft, |host| {
            assert!(config.settings().docker.host.is_empty());
            assert_eq!(host, "tcp://127.0.0.1:2375");
            Ok("prepared-client")
        })
        .unwrap();
        assert_eq!(client, Some("prepared-client"));
        let client = save_settings_with_reconnect(&config, config.settings(), |_| -> AppResult<()> {
            panic!("地址不变不应重连")
        })
        .unwrap();
        assert!(client.is_none());
    }
}
