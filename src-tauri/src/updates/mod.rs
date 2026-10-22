//! 从固定 GitHub 仓库的正式 Release 获取更新；下载和安装不需要 Git 或编译工具。

pub mod install;

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use parking_lot::Mutex;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tokio::io::AsyncWriteExt;
use url::Url;

use crate::error::{AppError, AppResult};

pub const EVENT: &str = "update://state";
const REPOSITORY: &str = "asia001-ya/cc-docker";
const RELEASE_API: &str = "https://api.github.com/repos/asia001-ya/cc-docker/releases/latest";
const MAX_ASSET_SIZE: u64 = 256 * 1024 * 1024;
const MAX_METADATA_SIZE: usize = 2 * 1024 * 1024;
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateSettings {
    pub auto_check: bool,
    pub auto_download: bool,
    pub install_on_exit: bool,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self { auto_check: true, auto_download: true, install_on_exit: true }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallKind {
    Installer,
    Portable,
    Development,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,
    Checking,
    Available,
    Downloading,
    Ready,
    Installing,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRelease {
    pub version: String,
    pub notes: String,
    pub published_at: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current_version: String,
    pub phase: Phase,
    pub release: Option<UpdateRelease>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub checked_at: Option<u64>,
    pub error: Option<String>,
    pub install_kind: InstallKind,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct Asset {
    name: String,
    size: u64,
    browser_download_url: String,
    digest: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    body: Option<String>,
    published_at: Option<String>,
    assets: Vec<Asset>,
}

#[derive(Debug, Clone)]
pub struct PreparedUpdate {
    pub path: PathBuf,
    pub digest: String,
    pub version: String,
    pub size: u64,
}

#[derive(Serialize, Deserialize)]
struct PendingUpdate {
    release: UpdateRelease,
    asset: Asset,
    kind: InstallKind,
}

struct Tracker {
    status: UpdateStatus,
    asset: Option<Asset>,
    prepared: Option<PreparedUpdate>,
}

pub struct UpdateManager {
    cache: PathBuf,
    exe: PathBuf,
    tracker: Mutex<Tracker>,
    operation: tokio::sync::Mutex<()>,
}

fn error(text: impl Into<String>) -> AppError {
    AppError::Other(text.into())
}

fn timestamp() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn version(text: &str) -> AppResult<Version> {
    Version::parse(text.strip_prefix('v').unwrap_or(text)).map_err(|_| error("发布版本号无效"))
}

fn digest(asset: &Asset) -> AppResult<String> {
    let value = asset
        .digest
        .as_deref()
        .and_then(|v| v.strip_prefix("sha256:"))
        .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| error("该版本缺少 GitHub SHA-256 校验值，无法自动安装"))?;
    Ok(value.to_ascii_lowercase())
}

fn trusted_https(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.fragment().is_none()
        && matches!(
            url.host_str(),
            Some(
                "api.github.com"
                    | "github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
            )
        )
}

fn validate_asset(asset: &Asset, tag: &str) -> AppResult<()> {
    if asset.size == 0 || asset.size > MAX_ASSET_SIZE {
        return Err(error("更新文件大小无效或超过 256 MB"));
    }
    digest(asset)?;
    let url = Url::parse(&asset.browser_download_url).map_err(|_| error("更新下载地址无效"))?;
    let expected = format!("https://github.com/{REPOSITORY}/releases/download/{tag}/{}", asset.name);
    if !trusted_https(&url) || url.query().is_some() || url.as_str() != expected {
        return Err(error("更新文件必须来自本项目的 GitHub Release"));
    }
    Ok(())
}

fn select_release(
    release: GitHubRelease,
    current: &str,
    kind: InstallKind,
) -> AppResult<Option<(UpdateRelease, Asset)>> {
    if release.draft || release.prerelease {
        return Ok(None);
    }
    let next = version(&release.tag_name)?;
    if release.draft || release.prerelease || !next.pre.is_empty() || next <= version(current)? {
        return Ok(None);
    }
    if !next.build.is_empty() {
        return Err(error("更新版本号不能包含构建元数据"));
    }
    let portable = kind == InstallKind::Portable;
    let canonical = format!("cc-docker-{next}-windows-x64{}.exe", if portable { "" } else { "-setup" });
    let asset = release.assets.into_iter().find(|a| a.name == canonical).ok_or_else(|| {
        error(if portable {
            "该版本未发布 Windows x64 独立运行文件"
        } else {
            "该版本未发布 Windows x64 安装包"
        })
    });
    // 只选规范文件名，避免把另一个架构或旧版本装到本机。
    let asset = asset?;
    validate_asset(&asset, &release.tag_name)?;
    Ok(Some((
        UpdateRelease {
            version: next.to_string(),
            notes: release.body.unwrap_or_default(),
            published_at: release.published_at,
            url: format!("https://github.com/{REPOSITORY}/releases/tag/{}", release.tag_name),
        },
        asset,
    )))
}

pub fn verify_file(path: &Path, expected_digest: &str, expected_size: u64) -> AppResult<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() != expected_size || expected_size == 0 || expected_size > MAX_ASSET_SIZE {
        return Err(error("更新文件不完整，请重新下载"));
    }
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected_digest {
        return Err(error("更新文件 SHA-256 校验失败，请重新下载"));
    }
    let mut header = [0; 2];
    fs::File::open(path)?.read_exact(&mut header)?;
    if header != *b"MZ" {
        return Err(error("更新文件不是有效的 Windows 程序"));
    }
    Ok(())
}

impl UpdateManager {
    pub fn load(cache: PathBuf, exe: PathBuf, current_version: String) -> Self {
        let kind = install::kind(&exe);
        let mut tracker = Tracker {
            status: UpdateStatus {
                current_version,
                phase: Phase::Idle,
                release: None,
                downloaded_bytes: 0,
                total_bytes: None,
                checked_at: None,
                error: install::read_install_error(&cache),
                install_kind: kind,
            },
            asset: None,
            prepared: None,
        };
        if let Ok(contents) = fs::read(cache.join("pending.json")) {
            if let Ok(pending) = serde_json::from_slice::<PendingUpdate>(&contents) {
                let selected = version(&pending.release.version)
                    .ok()
                    .filter(|v| v.pre.is_empty() && v.build.is_empty())
                    .filter(|v| version(&tracker.status.current_version).is_ok_and(|current| v > &current));
                if let Some(next) = selected.filter(|_| pending.kind == kind) {
                    let tag = pending.release.url.rsplit('/').next().unwrap_or_default();
                    let expected_name = format!(
                        "cc-docker-{next}-windows-x64{}.exe",
                        if kind == InstallKind::Portable { "" } else { "-setup" }
                    );
                    let path = cache.join(cache_file_name(&next.to_string(), kind));
                    if pending.release.url == format!("https://github.com/{REPOSITORY}/releases/tag/{tag}")
                        && version(tag).is_ok_and(|v| v == next)
                        && pending.asset.name == expected_name
                        && validate_asset(&pending.asset, tag).is_ok()
                        && digest(&pending.asset).is_ok_and(|sha| verify_file(&path, &sha, pending.asset.size).is_ok())
                    {
                        tracker.status.phase = Phase::Ready;
                        tracker.status.release = Some(pending.release);
                        tracker.status.downloaded_bytes = pending.asset.size;
                        tracker.status.total_bytes = Some(pending.asset.size);
                        tracker.prepared = Some(PreparedUpdate {
                            path,
                            digest: digest(&pending.asset).unwrap(),
                            version: next.to_string(),
                            size: pending.asset.size,
                        });
                        tracker.asset = Some(pending.asset);
                    }
                }
            }
        }
        if tracker.status.error.is_some() && tracker.prepared.is_none() {
            tracker.status.phase = Phase::Error;
        }
        Self { cache, exe, tracker: Mutex::new(tracker), operation: tokio::sync::Mutex::new(()) }
    }

    pub fn status(&self) -> UpdateStatus {
        self.tracker.lock().status.clone()
    }

    fn emit(&self, app: &tauri::AppHandle) {
        let _ = app.emit(EVENT, self.status());
    }

    fn fail(&self, app: &tauri::AppHandle, failure: &AppError) {
        let mut tracker = self.tracker.lock();
        tracker.status.phase = if tracker.prepared.is_some() { Phase::Ready } else { Phase::Error };
        tracker.status.error = Some(failure.to_string());
        drop(tracker);
        self.emit(app);
    }

    pub async fn check(&self, app: &tauri::AppHandle) -> AppResult<UpdateStatus> {
        let _guard = self.operation.try_lock().map_err(|_| error("正在处理更新，请稍候"))?;
        if self.status().phase == Phase::Installing {
            return Err(error("正在安装更新"));
        }
        {
            let mut tracker = self.tracker.lock();
            tracker.status.phase = Phase::Checking;
            tracker.status.error = None;
        }
        self.emit(app);
        let result = self.fetch_release().await;
        match result {
            Ok(release) => {
                let mut tracker = self.tracker.lock();
                tracker.status.checked_at = Some(timestamp());
                if let Some((release, asset)) = release {
                    let ready = tracker.prepared.as_ref().is_some_and(|p| {
                        p.version == release.version && p.digest == digest(&asset).unwrap_or_default()
                    });
                    if !ready {
                        tracker.prepared = None;
                        tracker.status.downloaded_bytes = 0;
                    }
                    tracker.status.phase = if ready { Phase::Ready } else { Phase::Available };
                    tracker.status.total_bytes = Some(asset.size);
                    tracker.status.release = Some(release);
                    tracker.asset = Some(asset);
                } else if tracker.prepared.is_some() {
                    tracker.status.phase = Phase::Ready;
                } else {
                    tracker.status.phase = Phase::Idle;
                    tracker.status.release = None;
                    tracker.status.total_bytes = None;
                    tracker.status.downloaded_bytes = 0;
                    tracker.asset = None;
                }
                drop(tracker);
                self.emit(app);
                Ok(self.status())
            }
            Err(failure) => {
                self.fail(app, &failure);
                Err(failure)
            }
        }
    }

    async fn fetch_release(&self) -> AppResult<Option<(UpdateRelease, Asset)>> {
        let mut response = http_client(Duration::from_secs(30))?
            .get(RELEASE_API)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .await
            .map_err(|_| error("无法连接 GitHub，请检查网络后重试"))?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if response.status() == reqwest::StatusCode::FORBIDDEN
            || response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
        {
            return Err(error("GitHub 请求次数已达限制，请稍后重试"));
        }
        if !response.status().is_success() {
            return Err(error(format!("GitHub 检查更新失败（HTTP {}）", response.status())));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| error("读取 GitHub 发布信息失败"))? {
            if bytes.len() + chunk.len() > MAX_METADATA_SIZE {
                return Err(error("GitHub 发布信息过大"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let release = serde_json::from_slice(&bytes).map_err(|_| error("GitHub 发布信息格式无效"))?;
        let status = self.status();
        select_release(release, &status.current_version, status.install_kind)
    }

    pub async fn download(&self, app: &tauri::AppHandle) -> AppResult<UpdateStatus> {
        let _guard = self.operation.try_lock().map_err(|_| error("正在处理更新，请稍候"))?;
        let (asset, release, kind) = {
            let mut tracker = self.tracker.lock();
            if !matches!(tracker.status.install_kind, InstallKind::Installer | InstallKind::Portable) {
                return Err(error("请在 Windows x64 正式版本中下载并安装更新"));
            }
            if tracker.status.phase == Phase::Installing {
                return Err(error("正在安装更新"));
            }
            if tracker.prepared.is_some() {
                return Ok(tracker.status.clone());
            }
            let asset = tracker.asset.clone().ok_or_else(|| error("请先检查更新"))?;
            let release = tracker.status.release.clone().ok_or_else(|| error("请先检查更新"))?;
            tracker.status.phase = Phase::Downloading;
            tracker.status.downloaded_bytes = 0;
            tracker.status.error = None;
            (asset, release, tracker.status.install_kind)
        };
        self.emit(app);
        let result = self.download_file(app, &asset, &release, kind).await;
        match result {
            Ok(prepared) => {
                let mut tracker = self.tracker.lock();
                tracker.prepared = Some(prepared);
                tracker.status.phase = Phase::Ready;
                tracker.status.downloaded_bytes = asset.size;
                drop(tracker);
                self.emit(app);
                Ok(self.status())
            }
            Err(failure) => {
                self.fail(app, &failure);
                Err(failure)
            }
        }
    }

    async fn download_file(
        &self,
        app: &tauri::AppHandle,
        asset: &Asset,
        release: &UpdateRelease,
        kind: InstallKind,
    ) -> AppResult<PreparedUpdate> {
        fs::create_dir_all(&self.cache)?;
        let path = self.cache.join(cache_file_name(&release.version, kind));
        let temporary = self.cache.join(format!("download-{}.part", uuid::Uuid::new_v4()));
        let result = async {
            let response = http_client(Duration::from_secs(15 * 60))?
                .get(&asset.browser_download_url)
                .send()
                .await
                .map_err(|_| error("无法下载更新，请检查网络后重试"))?;
            if !response.status().is_success() {
                return Err(error(format!("下载更新失败（HTTP {}）", response.status())));
            }
            if response.content_length().is_some_and(|size| size != asset.size) {
                return Err(error("下载文件大小与发布信息不一致"));
            }
            let mut file = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&temporary).await?;
            let mut stream = response.bytes_stream();
            let mut count = 0u64;
            let mut hasher = Sha256::new();
            let mut last_emit = Instant::now();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| error("更新下载中断，请重试"))?;
                count += chunk.len() as u64;
                if count > asset.size || count > MAX_ASSET_SIZE {
                    return Err(error("下载文件超出预期大小"));
                }
                hasher.update(&chunk);
                file.write_all(&chunk).await?;
                self.tracker.lock().status.downloaded_bytes = count;
                if last_emit.elapsed() >= Duration::from_millis(200) {
                    self.emit(app);
                    last_emit = Instant::now();
                }
            }
            file.flush().await?;
            file.sync_all().await?;
            drop(file);
            let sha = digest(asset)?;
            if count != asset.size || format!("{:x}", hasher.finalize()) != sha {
                return Err(error("更新文件不完整或 SHA-256 校验失败，请重新下载"));
            }
            verify_file(&temporary, &sha, asset.size)?;
            // 覆盖的是独立更新缓存中的同版本文件，安装目标直到 helper 接管才会修改。
            if path.exists() {
                fs::remove_file(&path)?;
            }
            fs::rename(&temporary, &path)?;
            let pending = PendingUpdate { release: release.clone(), asset: asset.clone(), kind };
            let pending_tmp = self.cache.join("pending.tmp");
            fs::write(&pending_tmp, serde_json::to_vec(&pending)?)?;
            if self.cache.join("pending.json").exists() {
                fs::remove_file(self.cache.join("pending.json"))?;
            }
            fs::rename(pending_tmp, self.cache.join("pending.json"))?;
            Ok(PreparedUpdate { path: path.clone(), digest: sha, version: release.version.clone(), size: asset.size })
        }
        .await;
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }

    /// 成功启动独立安装助手后，调用方才退出应用。
    pub fn start_install(&self, app: &tauri::AppHandle, restart: bool) -> AppResult<()> {
        let _guard = self.operation.try_lock().map_err(|_| error("更新尚未完成，请稍候"))?;
        let prepared = {
            let tracker = self.tracker.lock();
            if !matches!(tracker.status.install_kind, InstallKind::Installer | InstallKind::Portable) {
                return Err(error("此运行模式不支持自动安装"));
            }
            if tracker.status.phase == Phase::Installing {
                return Err(error("正在安装更新"));
            }
            tracker.prepared.clone().ok_or_else(|| error("请先下载更新"))?
        };
        if let Err(failure) = verify_file(&prepared.path, &prepared.digest, prepared.size) {
            // 缓存损坏后仍保留发布信息，让用户能重新下载，避免一直卡在“已就绪”。
            self.tracker.lock().prepared = None;
            let _ = fs::remove_file(self.cache.join("pending.json"));
            self.fail(app, &failure);
            return Err(failure);
        }
        let result = install::launch(&prepared, &self.exe, restart);
        if let Err(ref failure) = result {
            self.fail(app, failure);
            return result;
        }
        let _ = fs::remove_file(self.cache.join("update-install-error.txt"));
        self.tracker.lock().status.phase = Phase::Installing;
        self.emit(app);
        Ok(())
    }

    pub fn install_on_exit(&self, app: &tauri::AppHandle) {
        if self.status().phase == Phase::Ready {
            if let Err(failure) = self.start_install(app, false) {
                let _ = fs::create_dir_all(&self.cache);
                let _ = fs::write(self.cache.join("update-install-error.txt"), failure.to_string());
            }
        }
    }
}

fn cache_file_name(version: &str, kind: InstallKind) -> String {
    format!("release-{version}-{}.exe", if kind == InstallKind::Portable { "portable" } else { "setup" })
}

fn http_client(timeout: Duration) -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("cc-docker/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !trusted_https(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| error("无法初始化更新网络连接"))
}

pub async fn run_loop(
    app: tauri::AppHandle,
    manager: std::sync::Arc<UpdateManager>,
    config: std::sync::Arc<crate::config::store::ConfigStore>,
) {
    if cfg!(debug_assertions)
        || !matches!(manager.status().install_kind, InstallKind::Installer | InstallKind::Portable)
    {
        return;
    }
    tokio::time::sleep(Duration::from_secs(5)).await;
    let mut next_check = Instant::now();
    loop {
        let settings = config.settings().updates;
        if settings.auto_check && Instant::now() >= next_check {
            let _ = manager.check(&app).await;
            next_check = Instant::now() + CHECK_INTERVAL;
        }
        if config.settings().updates.auto_download && manager.status().phase == Phase::Available {
            let _ = manager.download(&app).await;
        }
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
}

#[cfg(test)]
mod tests;
