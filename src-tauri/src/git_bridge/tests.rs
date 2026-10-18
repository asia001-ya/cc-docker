use super::*;
#[test]
fn allows_exact_https_hosts_only_and_blocks_protocol_injection() {
    let hosts = host::normalize_hosts(&["Gitee.com".into(), "gitee.com".into()]).unwrap();
    assert_eq!(hosts, vec!["gitee.com"]);
    for invalid in [
        "https://gitee.com",
        "gitee.com/path",
        "user@gitee.com",
        "*.gitee.com",
        "gitee.com\nhelper=bad",
        "gitee.com?x=y",
        "gitee.com#x",
    ] {
        assert!(host::normalize_hosts(&[invalid.into()]).is_err(), "{invalid}");
    }
    let mut request = host::CredentialRequest {
        protocol: "https".into(),
        host: "gitee.com".into(),
        path: "team/repo.git".into(),
        username: None,
    };
    assert!(host::credential_input(&request, &hosts).is_some());
    request.host = "gitee.com.evil.example".into();
    assert!(host::credential_input(&request, &hosts).is_none());
    request.host = "gitee.com".into();
    request.protocol = "http".into();
    assert!(host::credential_input(&request, &hosts).is_none());
    request.protocol = "https".into();
    request.path = "repo\npassword=leak".into();
    assert!(host::credential_input(&request, &hosts).is_none());
    request.path.clear();
    request.username = Some("user\nurl=https://evil.example".into());
    assert!(host::credential_input(&request, &hosts).is_none());
}
#[test]
fn settings_persist_only_scoped_opt_in_and_revoke_cleanly() {
    let dir = std::env::temp_dir().join(format!("tdc-git-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let bridge = GitBridge::load(&dir).unwrap();
    assert!(bridge.data.lock().is_empty());
    bridge
        .save(
            "test",
            Some(Binding {
                name: "test".into(),
                container_id: "first-container".into(),
                config: Sharing { enabled: true, allowed_hosts: vec!["gitee.com".into()], sync_identity: false },
            }),
        )
        .unwrap();
    let restored = GitBridge::load(&dir).unwrap();
    assert_eq!(restored.data.lock()["test"].container_id, "first-container");
    let json = std::fs::read_to_string(dir.join("git-sharing.json")).unwrap();
    assert!(!json.contains("password"));
    assert!(!json.contains("token"));
    restored.save("test", None).unwrap();
    assert!(GitBridge::load(&dir).unwrap().data.lock().is_empty());
    std::fs::remove_dir_all(dir).unwrap();
}
