use super::*;

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("tdc-updates-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn asset(tag: &str, kind: InstallKind) -> Asset {
    let version = version(tag).unwrap();
    let name =
        format!("cc-docker-{version}-windows-x64{}.exe", if kind == InstallKind::Portable { "" } else { "-setup" });
    Asset {
        browser_download_url: format!("https://github.com/{REPOSITORY}/releases/download/{tag}/{name}"),
        name,
        size: 10,
        digest: Some(format!("sha256:{}", "a".repeat(64))),
    }
}

fn release(tag: &str) -> GitHubRelease {
    GitHubRelease {
        tag_name: tag.into(),
        draft: false,
        prerelease: false,
        body: Some("发布说明".into()),
        published_at: Some("2026-10-22T01:00:00Z".into()),
        assets: vec![asset(tag, InstallKind::Installer), asset(tag, InstallKind::Portable)],
    }
}

#[test]
fn chooses_matching_distribution_and_uses_semantic_versions() {
    for kind in [InstallKind::Installer, InstallKind::Portable] {
        let (info, selected) = select_release(release("v1.10.0"), "1.9.9", kind).unwrap().unwrap();
        assert_eq!(info.version, "1.10.0");
        assert_eq!(selected.name, asset("v1.10.0", kind).name);
        assert_eq!(info.notes, "发布说明");
    }
    for tag in ["v1.0.2", "1.0.1", "v0.9.9", "v1.1.0-beta.1"] {
        assert!(select_release(release(tag), "1.0.2", InstallKind::Installer).unwrap().is_none());
    }
    let mut candidate = release("v1.1.0");
    candidate.prerelease = true;
    assert!(select_release(candidate, "1.0.2", InstallKind::Installer).unwrap().is_none());
    let mut candidate = release("v1.1.0");
    candidate.draft = true;
    assert!(select_release(candidate, "1.0.2", InstallKind::Installer).unwrap().is_none());
}

#[test]
fn rejects_missing_digest_or_wrong_architecture_and_version() {
    let mut candidate = release("v1.1.0");
    candidate.assets[0].digest = None;
    assert!(select_release(candidate, "1.0.2", InstallKind::Installer).unwrap_err().to_string().contains("SHA-256"));
    for name in ["cc-docker-1.1.0-windows-arm64-setup.exe", "cc-docker-1.0.1-windows-x64-setup.exe", "unrelated.exe"] {
        let mut candidate = release("v1.1.0");
        candidate.assets[0].name = name.into();
        assert!(select_release(candidate, "1.0.2", InstallKind::Installer).is_err());
    }
    let mut candidate = release("v1.1.0");
    candidate.assets[0].size = MAX_ASSET_SIZE + 1;
    assert!(select_release(candidate, "1.0.2", InstallKind::Installer).is_err());
}

#[test]
fn only_trusts_this_repository_asset_and_https_github_redirects() {
    let good = asset("v1.1.0", InstallKind::Installer);
    validate_asset(&good, "v1.1.0").unwrap();
    for url in [
        "http://github.com/asia001-ya/cc-docker/releases/download/v1.1.0/update.exe",
        "https://github.com.attacker.invalid/update.exe",
        "https://github.com/another/repo/releases/download/v1.1.0/update.exe",
        "https://user@github.com/asia001-ya/cc-docker/releases/download/v1.1.0/update.exe",
        "https://github.com/asia001-ya/cc-docker/releases/download/v1.1.0/cc-docker-1.1.0-windows-x64-setup.exe?fake=1",
    ] {
        let mut bad = good.clone();
        bad.browser_download_url = url.into();
        assert!(validate_asset(&bad, "v1.1.0").is_err(), "{url}");
    }
    assert!(trusted_https(
        &Url::parse("https://release-assets.githubusercontent.com/file?signature=required").unwrap()
    ));
    for url in [
        "http://release-assets.githubusercontent.com/file",
        "https://example.org/file",
        "https://user:pass@github.com/file",
        "https://github.com:8443/file",
    ] {
        assert!(!trusted_https(&Url::parse(url).unwrap()), "{url}");
    }
}

#[test]
fn checksum_size_and_windows_header_are_required_before_installing() {
    let directory = Directory::new();
    let path = directory.0.join("update.exe");
    let bytes = b"MZ synthetic executable";
    fs::write(&path, bytes).unwrap();
    let sha = format!("{:x}", Sha256::digest(bytes));
    verify_file(&path, &sha, bytes.len() as u64).unwrap();
    assert!(verify_file(&path, &sha, bytes.len() as u64 + 1).is_err());
    assert!(verify_file(&path, &"0".repeat(64), bytes.len() as u64).is_err());
    fs::write(&path, b"html error page").unwrap();
    let sha = format!("{:x}", Sha256::digest(b"html error page"));
    assert!(verify_file(&path, &sha, 15).is_err());
}

#[test]
fn settings_migrate_without_overriding_explicit_disabled_preferences() {
    let settings: crate::config::store::Settings = serde_json::from_str("{}").unwrap();
    assert!(settings.updates.auto_check && settings.updates.auto_download && settings.updates.install_on_exit);
    let settings: crate::config::store::Settings =
        serde_json::from_str(r#"{"updates":{"autoCheck":false,"autoDownload":false,"installOnExit":false}}"#).unwrap();
    assert!(!settings.updates.auto_check && !settings.updates.auto_download && !settings.updates.install_on_exit);
}

fn pending(directory: &Directory, current: &str, mutate: impl FnOnce(&mut PendingUpdate)) -> UpdateManager {
    let exe = directory.0.join("app.exe");
    let kind = install::kind(&exe);
    let (release, mut asset) = select_release(release("v1.1.0"), current, kind).unwrap().unwrap();
    let bytes = b"MZ complete pending update";
    asset.size = bytes.len() as u64;
    asset.digest = Some(format!("sha256:{:x}", Sha256::digest(bytes)));
    fs::write(directory.0.join(cache_file_name("1.1.0", kind)), bytes).unwrap();
    let mut pending = PendingUpdate { release, asset, kind };
    mutate(&mut pending);
    fs::write(directory.0.join("pending.json"), serde_json::to_vec(&pending).unwrap()).unwrap();
    UpdateManager::load(directory.0.clone(), exe, current.into())
}

#[test]
fn recovers_only_intact_newer_updates_in_cache() {
    let directory = Directory::new();
    let manager = pending(&directory, "1.0.2", |_| {});
    assert_eq!(manager.status().phase, Phase::Ready);
    assert!(manager.tracker.lock().prepared.is_some());
    let manager = UpdateManager::load(directory.0.clone(), directory.0.join("app.exe"), "1.1.0".into());
    assert_eq!(manager.status().phase, Phase::Idle);
    let manager = pending(&directory, "1.0.2", |p| p.asset.digest = Some(format!("sha256:{}", "0".repeat(64))));
    assert_eq!(manager.status().phase, Phase::Idle);
    let manager = pending(&directory, "1.0.2", |p| p.release.version = "../../other".into());
    assert_eq!(manager.status().phase, Phase::Idle);
    let manager =
        pending(&directory, "1.0.2", |p| p.asset.browser_download_url = "https://example.org/update.exe".into());
    assert_eq!(manager.status().phase, Phase::Idle);
    let manager = pending(&directory, "1.0.2", |p| p.release.url = "https://example.org/v1.1.0".into());
    assert_eq!(manager.status().phase, Phase::Idle);
}

#[test]
fn recovery_keeps_install_failure_visible() {
    let directory = Directory::new();
    fs::write(directory.0.join("update-install-error.txt"), "测试安装失败，可重试").unwrap();
    let manager = pending(&directory, "1.0.2", |_| {});
    assert_eq!(manager.status().phase, Phase::Ready);
    assert!(manager.status().error.is_some());
}

/// 联网验证真实 GitHub API / CDN / 摘要；仅下载到一次性目录，不启动或安装程序。
#[tokio::test]
#[ignore = "requires GitHub network; downloads a release to a disposable directory without installing"]
async fn github_release_download_matches_published_digest() {
    let directory = Directory::new();
    let manager = UpdateManager::load(directory.0.clone(), directory.0.join("app.exe"), "0.0.0".into());
    let (_, asset) = manager.fetch_release().await.unwrap().expect("stable release");
    let response =
        http_client(Duration::from_secs(120)).unwrap().get(&asset.browser_download_url).send().await.unwrap();
    assert!(response.status().is_success(), "{}", response.status());
    let path = directory.0.join("release.exe");
    let mut file = tokio::fs::File::create(&path).await.unwrap();
    let mut count = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.unwrap();
        count += chunk.len() as u64;
        assert!(count <= asset.size && count <= MAX_ASSET_SIZE);
        file.write_all(&chunk).await.unwrap();
    }
    file.flush().await.unwrap();
    drop(file);
    verify_file(&path, &digest(&asset).unwrap(), asset.size).unwrap();
}
