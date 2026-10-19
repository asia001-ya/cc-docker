//! 在本机模拟 Docker API，验证创建顺序和回滚；不接触用户容器、节点或凭据。
use super::{create_prepared, prepare_create_proxy};
use crate::{
    docker::{client::DockerClient, spec::CreateContainerRequest},
    providers::ProviderStore,
    proxy::{
        render::{self, NodeKind, ResolvedNode},
        ProxyStore,
    },
};
use std::{
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

type RecordedRequests = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

struct Fixture {
    dir: PathBuf,
    host: String,
    requests: RecordedRequests,
    stopped: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Fixture {
    fn new(fail_archive: usize) -> Self {
        let dir = std::env::temp_dir().join(format!("tdc-create-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("proxies.json"),
            r#"{"nodes":[{"id":"main","name":"Test","kind":"socks5","display":"127.0.0.1:1"}],"bindings":{}}"#,
        )
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let host = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let saved = dir.clone();
        let worker = thread::spawn(move || {
            let mut archives = 0;
            while !stop.load(Ordering::Relaxed) {
                let (mut stream, _) = match listener.accept() {
                    Ok(s) => s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(e) => panic!("{e}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut bytes = Vec::new();
                let mut buf = [0u8; 8192];
                let header_end = loop {
                    let count = stream.read(&mut buf).unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buf[..count]);
                    if let Some(pos) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                        break pos + 4;
                    }
                };
                let header = String::from_utf8_lossy(&bytes[..header_end]).to_string();
                let request = header.lines().next().unwrap().to_string();
                let length: usize = header
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length").then(|| value.trim().parse().unwrap())
                    })
                    .unwrap_or(0);
                while bytes.len() < header_end + length {
                    let count = stream.read(&mut buf).unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buf[..count]);
                }
                recorded.lock().unwrap().push((request.clone(), bytes[header_end..].to_vec()));
                let (status, body) = if request.contains("/images/") {
                    (200, r#"{"Id":"test-image","Config":{"Labels":{"tdc.proxy":"1"}}}"#)
                } else if request.contains("/volumes/create") {
                    (
                        201,
                        r#"{"Name":"tdc_home_proxy-test","Driver":"local","Mountpoint":"/test","Labels":{},"Options":{},"Scope":"local"}"#,
                    )
                } else if request.contains("/containers/create") {
                    (201, r#"{"Id":"new-container-id","Warnings":[]}"#)
                } else if request.contains("/archive?") {
                    archives += 1;
                    if archives == fail_archive {
                        (500, r#"{"message":"simulated archive failure"}"#)
                    } else {
                        (200, "{}")
                    }
                } else if request.contains("/start") {
                    // 首次启动时，期望状态必须已经保存到应用存储。
                    let value: serde_json::Value =
                        serde_json::from_slice(&std::fs::read(saved.join("proxies.json")).unwrap()).unwrap();
                    assert!(value["bindings"]["proxy-test"].is_object());
                    (204, "")
                } else if request.starts_with("DELETE ") {
                    (204, "")
                } else {
                    panic!("unexpected request: {request}")
                };
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        Self { dir, host, requests, stopped, worker: Some(worker) }
    }
    fn request(&self, enabled: bool) -> CreateContainerRequest {
        serde_json::from_value(serde_json::json!({
            "name":"proxy-test", "image":"test-image", "authMode":"subscription", "sharedGroup":false,
            "proxy": { "enabled":enabled, "nodeId":"main", "allowLan":true }
        }))
        .unwrap()
    }
    fn rendered(&self) -> render::Rendered {
        render::render(
            &ResolvedNode { name: "Test".into(), kind: NodeKind::Socks5, secret: "socks5://127.0.0.1:1".into() },
            None,
            None,
            true,
            None,
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
        let joined = self.worker.take().unwrap().join();
        std::fs::remove_dir_all(&self.dir).unwrap();
        if !std::thread::panicking() {
            joined.unwrap();
        }
    }
}

#[tokio::test]
async fn 新建代理先写配置和绑定再启动_仅创建保持停止() {
    for start in [false, true] {
        let f = Fixture::new(0);
        let proxies = ProxyStore::load(&f.dir);
        let providers = ProviderStore::load(&f.dir).unwrap();
        let req = f.request(true);
        let docker = DockerClient::connect(&f.host).unwrap();
        let id = create_prepared(&docker, &proxies, &providers, &req, start, Some(f.rendered()), None).await.unwrap();
        assert_eq!(id, "new-container-id");
        assert_eq!(ProxyStore::load(&f.dir).binding_of(&req.name), req.proxy);
        let requests = f.requests.lock().unwrap();
        let archives: Vec<_> = requests.iter().filter(|(r, _)| r.contains("/archive?")).collect();
        assert_eq!(
            archives.len(),
            8 + 2 * usize::from(start),
            "代理脚本、私密配置与活动/待定用量来源快照应在启动前同步"
        );
        for ((_, body), filename) in archives.iter().skip(6).zip(["config.yaml", "intent.json"]) {
            let mut archive = tar::Archive::new(body.as_slice());
            let mut entries = archive.entries().unwrap();
            let mut entry = entries.next().unwrap().unwrap();
            assert_eq!(entry.path().unwrap().to_str(), Some(filename));
            assert_eq!(entry.header().mode().unwrap(), 0o600);
            assert_eq!(entry.header().uid().unwrap(), 0);
            let mut content = String::new();
            entry.read_to_string(&mut content).unwrap();
            let value: serde_json::Value = serde_json::from_str(&content).unwrap();
            if filename == "intent.json" {
                assert_eq!(value["enabled"], true);
                assert_eq!(value["lan_cidrs"], serde_json::json!(crate::proxy::lan::default_cidrs()));
            }
        }
        assert_eq!(requests.iter().any(|(r, _)| r.contains("/start")), start);
        if start {
            assert!(requests.last().unwrap().0.contains("/start"));
        }
    }
}

#[tokio::test]
async fn 任一代理文件写入失败都删除新容器且不启动不删卷() {
    for failed in 1..=10 {
        let f = Fixture::new(failed);
        let proxies = ProxyStore::load(&f.dir);
        let providers = ProviderStore::load(&f.dir).unwrap();
        let docker = DockerClient::connect(&f.host).unwrap();
        let result =
            create_prepared(&docker, &proxies, &providers, &f.request(true), true, Some(f.rendered()), None).await;
        assert!(result.unwrap_err().to_string().contains("可修改后重试"));
        assert!(proxies.binding_of("proxy-test").is_none());
        let requests = f.requests.lock().unwrap();
        assert!(!requests.iter().any(|(r, _)| r.contains("/start")));
        let deletions: Vec<_> = requests.iter().filter(|(r, _)| r.starts_with("DELETE ")).collect();
        assert_eq!(deletions.len(), 1);
        assert!(deletions[0].0.contains("/containers/new-container-id?"));
        assert!(deletions[0].0.contains("v=false"));
    }
}

#[tokio::test]
async fn 关闭代理的新容器无需上传且清除同名旧绑定() {
    let f = Fixture::new(0);
    let proxies = ProxyStore::load(&f.dir);
    proxies.bind("proxy-test", f.request(true).proxy.unwrap()).unwrap();
    let providers = ProviderStore::load(&f.dir).unwrap();
    let docker = DockerClient::connect(&f.host).unwrap();
    create_prepared(&docker, &proxies, &providers, &f.request(false), true, None, None).await.unwrap();
    assert!(!ProxyStore::load(&f.dir).binding_of("proxy-test").unwrap().enabled);
    let requests = f.requests.lock().unwrap();
    let archives: Vec<_> = requests.iter().filter(|(r, _)| r.contains("/archive?")).collect();
    assert_eq!(archives.len(), 2, "关闭代理时仍需上传 active 与 pending 用量来源快照");
    let mut names = Vec::new();
    for (_, body) in archives {
        let mut archive = tar::Archive::new(body.as_slice());
        let mut entries = archive.entries().unwrap();
        let entry = entries.next().unwrap().unwrap();
        names.push(entry.path().unwrap().to_string_lossy().to_string());
        assert!(entries.next().is_none());
    }
    names.sort();
    assert_eq!(names, vec!["usage-provider.json", "usage-provider.pending.json"]);
}

#[tokio::test]
async fn 绑定保存失败也不启动且撤回已写代理绑定() {
    let f = Fixture::new(0);
    let proxies = ProxyStore::load(&f.dir);
    let providers = ProviderStore::load(&f.dir).unwrap();
    // 加载后用目录占据配置文件路径，单独模拟绑定保存失败。
    std::fs::create_dir(f.dir.join("providers.json")).unwrap();
    let docker = DockerClient::connect(&f.host).unwrap();
    assert!(create_prepared(&docker, &proxies, &providers, &f.request(true), true, Some(f.rendered()), None)
        .await
        .is_err());
    assert!(ProxyStore::load(&f.dir).binding_of("proxy-test").is_none());
    let requests = f.requests.lock().unwrap();
    assert!(!requests.iter().any(|(r, _)| r.contains("/start")));
    assert!(requests.last().unwrap().0.starts_with("DELETE "));
}

#[tokio::test]
async fn 创建预检拒绝未授予能力和缺失节点_兼容旧请求() {
    let f = Fixture::new(0);
    let proxies = ProxyStore::load(&f.dir);
    let docker = DockerClient::connect(&f.host).unwrap();
    let mut req = f.request(true);
    req.proxy_capable = false;
    assert!(prepare_create_proxy(&proxies, &docker, &req).await.err().unwrap().to_string().contains("授予"));
    assert!(f.requests.lock().unwrap().is_empty());
    req.proxy_capable = true;
    req.proxy.as_mut().unwrap().node_id = None;
    assert!(prepare_create_proxy(&proxies, &docker, &req).await.err().unwrap().to_string().contains("必须选择"));
    req.proxy = None;
    assert!(prepare_create_proxy(&proxies, &docker, &req).await.unwrap().is_none());
    assert!(!f.requests.lock().unwrap().iter().any(|(r, _)| r.contains("/containers/create")));
}
