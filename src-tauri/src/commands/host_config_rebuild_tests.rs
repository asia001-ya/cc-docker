//! 用本机 HTTP 假引擎验证宿主配置重建；不连接真实 Docker 或操作真实容器。
use super::*;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};

const NAME: &str = "host-test";
const ORIGINAL: &str = "original-id";
const PROBE: &str = "probe-id";
const CANDIDATE: &str = "candidate-id";
const RESTORE: &str = "restore-id";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Failure {
    None,
    ProbeArchive(usize),
    Commit,
    FinalCreate,
    FinalArchive(usize),
    CandidateRename,
    CandidateStart,
    Verification,
    RestoreOverlay,
    BackupDelete,
    RefreshCopyOnce,
    RefreshReadOnce,
    RefreshAlways,
    InitializationIssues,
}

#[derive(Clone, Debug)]
struct Request {
    method: String,
    path: String,
    query: HashMap<String, String>,
    body: Vec<u8>,
}

impl Request {
    fn is(&self, method: &str, suffix: &str) -> bool {
        self.method == method && self.path.ends_with(suffix)
    }
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

struct Fixture {
    directory: PathBuf,
    host: String,
    requests: Arc<Mutex<Vec<Request>>>,
    mcp_export: Arc<Mutex<Option<PathBuf>>>,
    private_copies: Arc<Mutex<Vec<Value>>>,
    inspect_reply: Arc<Mutex<Value>>,
    stopping: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Fixture {
    fn new(failure: Failure) -> Self {
        let directory = std::env::temp_dir().join(format!("tdc-host-rebuild-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(directory.join("skills")).unwrap();
        std::fs::create_dir_all(directory.join("project")).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let host = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let mcp_export: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
        let exported = mcp_export.clone();
        let private_copies = Arc::new(Mutex::new(Vec::new()));
        let copied = private_copies.clone();
        let private_file = directory.join("private-mcp.json");
        let inspect_reply =
            Arc::new(Mutex::new(json!({"Id":ORIGINAL,"State":{"Running":true},"Config":{"Labels":{}}})));
        let inspect_response = inspect_reply.clone();
        let stopping = Arc::new(AtomicBool::new(false));
        let stop = stopping.clone();
        let worker = thread::spawn(move || {
            let mut creates = 0;
            let mut probe_archives = 0;
            let mut candidate_archives = 0;
            let mut exec_commands: HashMap<String, Value> = HashMap::new();
            let mut exec_results: HashMap<String, i64> = HashMap::new();
            let mut refreshes = 0;
            while !stop.load(Ordering::Relaxed) {
                let (mut stream, _) = match listener.accept() {
                    Ok(stream) => stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(error) => panic!("fake Docker accept failed: {error}"),
                };
                let request = read_request(&mut stream);
                recorded.lock().unwrap().push(request.clone());
                if request.is("GET", "/containers/original-id/json") {
                    write_json_response(&mut stream, 200, &inspect_response.lock().unwrap());
                    continue;
                }
                if request.is("POST", "/containers/original-id/exec") {
                    let id = format!("fixture-exec-{}", exec_commands.len() + 1);
                    exec_commands.insert(id.clone(), request.json());
                    write_json_response(&mut stream, 201, &json!({"Id":id}));
                    continue;
                }
                if request.method == "POST" && request.path.contains("/exec/") && request.path.ends_with("/start") {
                    let id = request.path.split('/').rev().nth(1).unwrap();
                    let command: Vec<_> = exec_commands[id]["Cmd"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|value| value.as_str().unwrap())
                        .collect();
                    let (stdout, exit_code) = match command.as_slice() {
                        ["id", "-g", "node"] => ("1000\n".to_owned(), 0),
                        ["node", "/opt/tdc/tdc-host-config.mjs", "refresh-mcp", "1000"] => {
                            refreshes += 1;
                            let path = exported.lock().unwrap().clone().expect("MCP export fixture must be configured");
                            let payload = std::fs::read(path).unwrap();
                            copied.lock().unwrap().push(serde_json::from_slice(&payload).unwrap());
                            // 模拟首次失败前副本已部分生效，确保回滚会重新复制旧导出。
                            if failure != Failure::RefreshAlways || refreshes == 1 {
                                std::fs::write(&private_file, payload).unwrap();
                            }
                            let failed = failure == Failure::RefreshAlways
                                || (failure == Failure::RefreshCopyOnce && refreshes == 1);
                            (json!({"prepared":!failed}).to_string(), if failed { 1 } else { 0 })
                        }
                        ["test", "-r", "/var/lib/tdc/host-config/mcp.json"] => {
                            let failed = failure == Failure::RefreshReadOnce && refreshes == 1;
                            (String::new(), if failed { 1 } else { 0 })
                        }
                        ["/bin/sh", "-c", _] => (String::new(), 0),
                        ["/opt/tdc/tdc-ctl.sh", "link-shared"] => {
                            let issues = if failure == Failure::InitializationIssues {
                                json!([{"category":"skills","reason":"fixture-unreadable"}])
                            } else {
                                json!([])
                            };
                            (json!({"issues":issues}).to_string(), 0)
                        }
                        _ => panic!("unexpected fixture exec command"),
                    };
                    exec_results.insert(id.into(), exit_code);
                    write_exec_output(&mut stream, &stdout);
                    continue;
                }
                if request.method == "GET" && request.path.contains("/exec/") && request.path.ends_with("/json") {
                    let id = request.path.split('/').rev().nth(1).unwrap();
                    write_json_response(
                        &mut stream,
                        200,
                        &json!({"ID":id,"Running":false,"ExitCode":exec_results[id]}),
                    );
                    continue;
                }
                let failed = (500, r#"{"message":"simulated rebuild failure"}"#);
                let response = if request.is("POST", "/containers/create") {
                    creates += 1;
                    if creates == 1 {
                        (201, r#"{"Id":"probe-id","Warnings":[]}"#)
                    } else if creates == 2 && failure == Failure::FinalCreate {
                        failed
                    } else if creates == 3 {
                        (201, r#"{"Id":"restore-id","Warnings":[]}"#)
                    } else {
                        (201, r#"{"Id":"candidate-id","Warnings":[]}"#)
                    }
                } else if request.is("PUT", "/containers/probe-id/archive") {
                    probe_archives += 1;
                    if failure == Failure::ProbeArchive(probe_archives) {
                        failed
                    } else {
                        (200, "{}")
                    }
                } else if request.is("PUT", "/containers/candidate-id/archive") {
                    candidate_archives += 1;
                    if failure == Failure::FinalArchive(candidate_archives) {
                        failed
                    } else {
                        (200, "{}")
                    }
                } else if request.is("PUT", "/containers/restore-id/archive") {
                    (200, "{}")
                } else if request.is("POST", "/commit") {
                    if failure == Failure::Commit {
                        failed
                    } else {
                        (201, r#"{"Id":"sha256:final-snapshot"}"#)
                    }
                } else if (request.is("POST", "/containers/candidate-id/rename") && failure == Failure::CandidateRename)
                    || (request.is("POST", "/containers/candidate-id/start") && failure == Failure::CandidateStart)
                {
                    failed
                } else if request.is("GET", "/containers/candidate-id/json") {
                    assert!(
                        matches!(failure, Failure::Verification | Failure::RestoreOverlay),
                        "only the verification failure test starts a candidate successfully"
                    );
                    (200, r#"{"Id":"candidate-id","State":{"Running":false}}"#)
                } else if request.is("GET", "/containers/restore-id/json") {
                    if failure == Failure::RestoreOverlay {
                        (200, r#"{"Id":"restore-id","State":{"Running":false,"ExitCode":1}}"#)
                    } else {
                        (200, r#"{"Id":"restore-id","State":{"Running":false,"ExitCode":0}}"#)
                    }
                } else if request.is("DELETE", "/containers/original-id") && failure == Failure::BackupDelete {
                    failed
                } else if request.method == "DELETE"
                    || request.is("POST", "/containers/original-id/stop")
                    || request.is("POST", "/containers/original-id/start")
                    || request.is("POST", "/containers/candidate-id/start")
                    || request.is("POST", "/containers/restore-id/start")
                    || request.is("POST", "/containers/original-id/rename")
                    || request.is("POST", "/containers/candidate-id/rename")
                {
                    (204, "")
                } else {
                    panic!("unexpected fake Docker request: {} {}", request.method, request.path);
                };
                let (status, body) = response;
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        Self { directory, host, requests, mcp_export, private_copies, inspect_reply, stopping, worker: Some(worker) }
    }

    fn docker(&self) -> DockerClient {
        DockerClient::connect(&self.host).unwrap()
    }

    fn inspect(&self, running: bool) -> ContainerInspectResponse {
        serde_json::from_value(json!({
            "Id":ORIGINAL,"Image":"sha256:original-image","Name":format!("/{NAME}"),
            "State":{"Running":running},
            "Config":{
                "Image":"tdc/claude-dev:legacy","User":"root","Hostname":"original-hostname",
                "Entrypoint":["/usr/bin/tini","--","/opt/tdc/entrypoint.sh"],"Cmd":["sleep","infinity"],
                "WorkingDir":"/workspace/project",
                "Env":["PATH=/custom/bin:/usr/bin","NODE_VERSION=fixture","TDC_CONTAINER_NAME=host-test","TDC_SLOT=09","CUSTOM_FLAG=kept"],
                "Labels":{"tdc.image":"claude-dev","tdc.protocol":"1","tdc.managed":"true","tdc.auth_mode":"subscription","tdc.slot":"09","tdc.shared_group":"team-a","custom.label":"kept"}
            },
            "HostConfig":{
                "Binds":[
                    "tdc_home_host-test:/home/node/.claude",
                    "tdc_shared_projects_team-a:/home/node/.claude/projects",
                    "tdc_shared_memory_team-a:/home/node/.claude-shared",
                    format!("{}:/workspace/project:ro", self.directory.join("project").to_string_lossy()),
                    "extra-cache:/var/cache/tool:ro"
                ],
                "Mounts":[{"Type":"volume","Source":"extra-data","Target":"/opt/data","ReadOnly":false}],
                "PortBindings":{"8123/tcp":[{"HostIp":"127.0.0.1","HostPort":"18123"}]},
                "NetworkMode":"bridge","RestartPolicy":{"Name":"unless-stopped"},
                "Memory":536870912,"NanoCpus":1500000000
            },
            "Mounts":[{"Type":"volume","Name":"extra-data","Destination":"/opt/data","RW":true}]
        })).unwrap()
    }

    fn request(&self, inspect: &ContainerInspectResponse) -> CreateContainerRequest {
        let mut request = recreate_request(NAME, inspect).unwrap();
        request.host_config = Some(HostClaudeConfig {
            skills: Some(self.directory.join("skills").to_string_lossy().into_owned()),
            ..Default::default()
        });
        request
    }

    fn detach(&self) -> impl FnOnce() + 'static {
        let requests = self.requests.clone();
        move || {
            requests.lock().unwrap().push(Request {
                method: "DETACH".into(),
                path: "/sessions".into(),
                query: HashMap::new(),
                body: Vec::new(),
            })
        }
    }

    fn recorded(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }

    fn mcp_change(&self) -> McpChange {
        let source = self.directory.join("source-mcp.json");
        let root = self.directory.join("exports");
        let old = json!({"mcpServers":{"test":{"command":"node","args":["old.js"]}}});
        let new = json!({"mcpServers":{"test":{"command":"node","args":["new.js"]}}});
        std::fs::write(&source, serde_json::to_vec(&old).unwrap()).unwrap();
        let config =
            HostClaudeConfig { mcp_configs: vec![source.to_string_lossy().into_owned()], ..Default::default() };
        let export = host_config::validate(&config).unwrap().persist_mcp(&root).unwrap().unwrap();
        std::fs::write(self.directory.join("private-mcp.json"), serde_json::to_vec(&old).unwrap()).unwrap();
        let full_source = json!({"mcpServers":new["mcpServers"],"oauthAccount":{"token":"fixture-account-secret"}});
        std::fs::write(&source, serde_json::to_vec(&full_source).unwrap()).unwrap();
        *self.mcp_export.lock().unwrap() = Some(export.join("mcp.json"));
        McpChange { prepared: host_config::validate(&config).unwrap(), root, export, source, old, new }
    }
}

struct McpChange {
    prepared: HostConfigPrepared,
    root: PathBuf,
    export: PathBuf,
    source: PathBuf,
    old: Value,
    new: Value,
}

fn write_json_response(stream: &mut TcpStream, status: u16, value: &Value) {
    let body = value.to_string();
    write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
}

fn write_exec_output(stream: &mut TcpStream, output: &str) {
    stream.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n").unwrap();
    if !output.is_empty() {
        let mut header = [0u8; 8];
        header[0] = 1;
        header[4..].copy_from_slice(&(output.len() as u32).to_be_bytes());
        stream.write_all(&header).unwrap();
        stream.write_all(output.as_bytes()).unwrap();
    }
    stream.flush().unwrap();
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Relaxed);
        let result = self.worker.take().unwrap().join();
        std::fs::remove_dir_all(&self.directory).unwrap();
        if !thread::panicking() {
            result.unwrap();
        }
    }
}

fn read_request(stream: &mut TcpStream) -> Request {
    stream.set_nonblocking(false).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    let end = loop {
        let count = stream.read(&mut buffer).unwrap();
        assert!(count > 0);
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
    };
    let headers = String::from_utf8_lossy(&bytes[..end]).into_owned();
    let mut line = headers.lines().next().unwrap().split_whitespace();
    let method = line.next().unwrap().to_owned();
    let url = url::Url::parse(&format!("http://fake-docker{}", line.next().unwrap())).unwrap();
    let length: usize = headers
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("content-length").then(|| value.trim().parse().unwrap())
        })
        .unwrap_or(0);
    while bytes.len() < end + length {
        let count = stream.read(&mut buffer).unwrap();
        assert!(count > 0);
        bytes.extend_from_slice(&buffer[..count]);
    }
    Request {
        method,
        path: url.path().into(),
        query: url.query_pairs().map(|(key, value)| (key.into_owned(), value.into_owned())).collect(),
        body: bytes[end..end + length].to_vec(),
    }
}

fn position(requests: &[Request], method: &str, suffix: &str) -> usize {
    requests
        .iter()
        .position(|request| request.is(method, suffix))
        .unwrap_or_else(|| panic!("missing {method} {suffix}"))
}

fn assert_original_preserved(requests: &[Request]) {
    assert!(!requests.iter().any(|request| request.is("DELETE", "/containers/original-id")));
    for request in requests.iter().filter(|request| request.method == "DELETE") {
        assert!(
            request.path.ends_with(&format!("/containers/{PROBE}"))
                || request.path.ends_with(&format!("/containers/{CANDIDATE}"))
                || request.path.ends_with(&format!("/containers/{RESTORE}"))
        );
        assert_eq!(request.query.get("v").map(String::as_str), Some("false"));
    }
    assert!(!requests.iter().any(|request| request.path.contains("/volumes/")));
}

fn assert_isolated_restore_body(requests: &[Request]) {
    let creates: Vec<_> = requests.iter().filter(|request| request.is("POST", "/containers/create")).collect();
    assert_eq!(creates.len(), 3);
    let body = creates[2].json();
    assert_eq!(body["Image"], creates[1].json()["Image"], "restore must use the final snapshot");
    assert_eq!(body["Labels"][spec::LABEL_MANAGED], "false");
    assert_eq!(body["User"], "node");
    assert_eq!(body["HostConfig"]["NetworkMode"], "none");
    assert!(body["HostConfig"]["CapDrop"].as_array().unwrap().contains(&json!("ALL")));
    let command = json!([body["Entrypoint"], body["Cmd"]]).to_string();
    assert!(command.contains("flock") && command.contains("node") && command.contains("restore-only"));
    assert!(!command.contains("entrypoint.sh"), "restore must not run the normal entrypoint");
    let mut targets = Vec::new();
    for bind in body["HostConfig"]["Binds"].as_array().into_iter().flatten() {
        let (_, target) = crate::commands::container_cmds::split_bind(bind.as_str().unwrap()).unwrap();
        targets.push(target.split(':').next().unwrap().to_owned());
    }
    for mount in body["HostConfig"]["Mounts"].as_array().into_iter().flatten() {
        targets.push(mount["Target"].as_str().unwrap().to_owned());
    }
    assert!(targets.iter().any(|target| target == spec::CLAUDE_DIR));
    assert!(targets
        .iter()
        .all(|target| matches!(target.as_str(), spec::CLAUDE_DIR | spec::PROJECTS_DIR | spec::SHARED_DIR)));
    let uploads: Vec<_> =
        requests.iter().filter(|request| request.is("PUT", "/containers/restore-id/archive")).collect();
    assert_eq!(uploads.len(), 1);
    let mut archive = tar::Archive::new(uploads[0].body.as_slice());
    let mut entries = archive.entries().unwrap();
    assert_eq!(entries.next().unwrap().unwrap().path().unwrap().to_str(), Some("tdc-host-config.mjs"));
    assert!(entries.next().is_none());
}

#[test]
fn expected_container_id_rejects_empty_changed_and_missing_ids() {
    let inspect = ContainerInspectResponse { id: Some(ORIGINAL.into()), ..Default::default() };
    assert!(check_expected_id(&inspect, ORIGINAL).is_ok());
    for expected in ["", "different-id"] {
        assert!(check_expected_id(&inspect, expected).unwrap_err().to_string().contains("容器已变化"));
    }
    assert!(check_expected_id(&ContainerInspectResponse::default(), ORIGINAL).is_err());
}

#[test]
fn candidate_body_keeps_custom_home_volume_instead_of_allocating_a_default_home() {
    let fixture = Fixture::new(Failure::None);
    let mut inspect = fixture.inspect(false);
    let custom_home = format!("custom-existing-home:{}", spec::CLAUDE_DIR);
    let binds = inspect.host_config.as_mut().unwrap().binds.as_mut().unwrap();
    let home = binds
        .iter_mut()
        .find(|bind| {
            crate::commands::container_cmds::split_bind(bind)
                .is_some_and(|(_, tail)| tail.split(':').next() == Some(spec::CLAUDE_DIR))
        })
        .unwrap();
    *home = custom_home.clone();
    let body = candidate_body(&inspect, &fixture.request(&inspect), "snapshot:final").unwrap();
    let actual: Vec<_> = body
        .host_config
        .unwrap()
        .binds
        .unwrap()
        .into_iter()
        .filter(|bind| {
            crate::commands::container_cmds::split_bind(bind)
                .is_some_and(|(_, tail)| tail.split(':').next() == Some(spec::CLAUDE_DIR))
        })
        .collect();
    assert_eq!(actual, [custom_home]);
    assert!(fixture.recorded().is_empty());
}

#[test]
fn candidate_body_reuses_anonymous_volume_names_only_present_in_runtime_inspect() {
    let fixture = Fixture::new(Failure::None);
    let mut inspect = fixture.inspect(false);
    inspect.host_config.as_mut().unwrap().binds.as_mut().unwrap().retain(|bind| {
        !crate::commands::container_cmds::split_bind(bind)
            .is_some_and(|(_, tail)| tail.split(':').next() == Some(spec::CLAUDE_DIR))
    });
    for mount in [
        json!({"Type":"volume","Name":"anonymous-home-original","Source":"/var/lib/docker/volumes/anonymous-home-original/_data","Destination":spec::CLAUDE_DIR,"RW":true}),
        json!({"Type":"volume","Name":"anonymous-data-original","Source":"/var/lib/docker/volumes/anonymous-data-original/_data","Destination":"/opt/anonymous-data","RW":false}),
    ] {
        inspect.mounts.as_mut().unwrap().push(serde_json::from_value(mount).unwrap());
    }
    let body = candidate_body(&inspect, &fixture.request(&inspect), "snapshot:final").unwrap();
    let mounts = body.host_config.unwrap().mounts.unwrap();
    for (target, source, read_only) in
        [(spec::CLAUDE_DIR, "anonymous-home-original", false), ("/opt/anonymous-data", "anonymous-data-original", true)]
    {
        let matched: Vec<_> = mounts.iter().filter(|mount| mount.target.as_deref() == Some(target)).collect();
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].typ, Some(MountType::VOLUME));
        assert_eq!(matched[0].source.as_deref(), Some(source));
        assert_eq!(matched[0].read_only, Some(read_only));
    }
    assert_eq!(
        mounts.iter().filter(|mount| mount.target.as_deref() == Some("/opt/data")).count(),
        1,
        "already represented mounts must not duplicate"
    );
    assert!(fixture.recorded().is_empty());
}

#[tokio::test]
async fn invalid_spec_and_unsupported_shape_do_not_contact_docker_or_detach() {
    let fixture = Fixture::new(Failure::None);
    let docker = fixture.docker();
    let inspect = fixture.inspect(true);
    let mut request = fixture.request(&inspect);
    request.mounts.push(spec::ProjectMount {
        host_path: fixture.directory.to_string_lossy().into_owned(),
        container_path: "relative".into(),
        read_only: true,
    });
    assert!(rebuild_candidate(&docker, NAME, &inspect, &request, vec![], fixture.detach()).await.is_err());
    for changed in [
        json!({"Entrypoint":["custom-entrypoint"]}),
        json!({"User":"node"}),
        json!({"Labels":{"tdc.image":"custom","tdc.protocol":"1"}}),
    ] {
        let mut unsupported = inspect.clone();
        let mut config = serde_json::to_value(unsupported.config.as_ref().unwrap()).unwrap();
        config.as_object_mut().unwrap().extend(changed.as_object().unwrap().clone());
        unsupported.config = Some(serde_json::from_value(config).unwrap());
        assert!(rebuild_candidate(&docker, NAME, &unsupported, &fixture.request(&inspect), vec![], fixture.detach())
            .await
            .is_err());
    }
    let mut protected = inspect.clone();
    let source = fixture.directory.join("entrypoint.sh");
    std::fs::write(&source, "#!/bin/sh\n").unwrap();
    protected.mounts.as_mut().unwrap().push(
        serde_json::from_value(json!({
            "Type":"bind","Source":source,"Destination":"/opt/tdc/entrypoint.sh","RW":false
        }))
        .unwrap(),
    );
    assert!(rebuild_candidate(&docker, NAME, &protected, &fixture.request(&inspect), vec![], fixture.detach())
        .await
        .is_err());
    assert!(fixture.recorded().is_empty());
}

#[tokio::test]
async fn probe_upload_failure_cleans_only_probe_before_original_is_stopped() {
    for failure in [1, 7] {
        let fixture = Fixture::new(Failure::ProbeArchive(failure));
        let inspect = fixture.inspect(true);
        let error =
            rebuild_candidate(&fixture.docker(), NAME, &inspect, &fixture.request(&inspect), vec![], fixture.detach())
                .await
                .unwrap_err();
        assert!(error.to_string().contains("原容器未停止"));
        let requests = fixture.recorded();
        assert_eq!(
            requests.iter().filter(|request| request.is("PUT", "/containers/probe-id/archive")).count(),
            failure
        );
        assert!(!requests.iter().any(|request| request.path.ends_with("/stop")
            || request.path.ends_with("/start")
            || request.path.ends_with("/commit")
            || request.method == "DETACH"));
        assert!(requests.last().unwrap().is("DELETE", "/containers/probe-id"));
        assert_original_preserved(&requests);
    }
}

#[tokio::test]
async fn final_snapshot_is_after_graceful_stop_and_runtime_failure_restarts_original() {
    let fixture = Fixture::new(Failure::FinalArchive(1));
    let inspect = fixture.inspect(true);
    assert!(rebuild_candidate(&fixture.docker(), NAME, &inspect, &fixture.request(&inspect), vec![], fixture.detach())
        .await
        .is_err());
    let requests = fixture.recorded();
    let probe_delete = position(&requests, "DELETE", "/containers/probe-id");
    let stop = position(&requests, "POST", "/containers/original-id/stop");
    let detach = position(&requests, "DETACH", "/sessions");
    let commit = position(&requests, "POST", "/commit");
    assert!(probe_delete < stop && stop < detach && detach < commit);
    assert_eq!(requests[stop].query.get("t").map(String::as_str), Some("10"));
    assert_eq!(requests[commit].query.get("container").map(String::as_str), Some(ORIGINAL));
    assert_eq!(requests[commit].query.get("pause").map(String::as_str), Some("false"));
    assert_eq!(
        requests[commit].json()["Env"],
        serde_json::to_value(inspect.config.as_ref().unwrap().env.as_ref().unwrap()).unwrap()
    );
    let archives: Vec<_> =
        requests[..stop].iter().filter(|request| request.is("PUT", "/containers/probe-id/archive")).collect();
    assert_eq!(archives.len(), 11);
    for (request, expected) in archives.iter().zip([
        "entrypoint.sh",
        "entrypoint-user.sh",
        "tdc-claude.sh",
        "tdc-ctl.sh",
        "tdc-session.sh",
        "tdc-session-history.mjs",
        "tdc-usage.mjs",
        "tdc-quota.mjs",
        "statusline.mjs",
        "statusline-display.mjs",
        "tdc-host-config.mjs",
    ]) {
        assert_eq!(request.query.get("path").map(String::as_str), Some("/opt/tdc"));
        let mut archive = tar::Archive::new(request.body.as_slice());
        let mut entries = archive.entries().unwrap();
        let entry = entries.next().unwrap().unwrap();
        assert_eq!(entry.path().unwrap().to_str(), Some(expected));
        assert_eq!(entry.header().uid().unwrap(), 0);
        assert_eq!(entry.header().mode().unwrap(), 0o755);
    }
    assert!(
        position(&requests, "DELETE", "/containers/candidate-id")
            < position(&requests, "POST", "/containers/original-id/start")
    );
    assert_original_preserved(&requests);
}

#[tokio::test]
async fn snapshot_or_final_create_failure_restarts_original_without_renaming_or_deleting_it() {
    for failure in [Failure::Commit, Failure::FinalCreate] {
        let fixture = Fixture::new(failure);
        let inspect = fixture.inspect(true);
        let error =
            rebuild_candidate(&fixture.docker(), NAME, &inspect, &fixture.request(&inspect), vec![], fixture.detach())
                .await
                .unwrap_err();
        assert!(error.to_string().contains("原容器及其文件未删除"));
        let requests = fixture.recorded();
        assert!(position(&requests, "POST", "/containers/original-id/stop") < position(&requests, "POST", "/commit"));
        assert!(requests.last().unwrap().is("POST", "/containers/original-id/start"));
        assert!(!requests.iter().any(|request| request.path.ends_with("/rename")));
        assert_original_preserved(&requests);
    }
}

#[tokio::test]
async fn rename_start_or_verification_failure_restores_original_name_and_running_state() {
    for failure in [Failure::CandidateRename, Failure::CandidateStart, Failure::Verification] {
        let fixture = Fixture::new(failure);
        let inspect = fixture.inspect(true);
        let error =
            rebuild_candidate(&fixture.docker(), NAME, &inspect, &fixture.request(&inspect), vec![], fixture.detach())
                .await
                .unwrap_err();
        assert!(error.to_string().contains("已恢复原容器"));
        let requests = fixture.recorded();
        let renames: Vec<_> = requests
            .iter()
            .enumerate()
            .filter(|(_, request)| request.is("POST", "/containers/original-id/rename"))
            .collect();
        assert_eq!(renames.len(), 2);
        assert!(renames[0].1.query["name"].starts_with("tdc-backup-"));
        assert_eq!(renames[1].1.query["name"], NAME);
        assert!(position(&requests, "DELETE", "/containers/candidate-id") < renames[1].0);
        assert!(renames[1].0 < position(&requests, "POST", "/containers/original-id/start"));
        assert_eq!(
            requests.iter().any(|request| request.is("GET", "/containers/candidate-id/json")),
            failure == Failure::Verification
        );
        if failure == Failure::CandidateRename {
            assert_eq!(requests.iter().filter(|request| request.is("POST", "/containers/create")).count(), 2);
        } else {
            assert_isolated_restore_body(&requests);
            let restore_create = requests
                .iter()
                .enumerate()
                .filter(|(_, request)| request.is("POST", "/containers/create"))
                .nth(2)
                .unwrap()
                .0;
            let restore_upload = position(&requests, "PUT", "/containers/restore-id/archive");
            let restore_start = position(&requests, "POST", "/containers/restore-id/start");
            let restore_check = position(&requests, "GET", "/containers/restore-id/json");
            let restore_delete = position(&requests, "DELETE", "/containers/restore-id");
            assert!(position(&requests, "DELETE", "/containers/candidate-id") < restore_create);
            assert!(
                restore_create < restore_upload
                    && restore_upload < restore_start
                    && restore_start < restore_check
                    && restore_check < restore_delete
            );
            assert!(
                restore_delete < renames[1].0
                    && restore_delete < position(&requests, "POST", "/containers/original-id/start")
            );
        }
        assert_original_preserved(&requests);
    }
}

#[tokio::test]
async fn failed_shared_home_restore_preserves_original_without_claiming_recovery() {
    let fixture = Fixture::new(Failure::RestoreOverlay);
    let inspect = fixture.inspect(true);
    let error =
        rebuild_candidate(&fixture.docker(), NAME, &inspect, &fixture.request(&inspect), vec![], fixture.detach())
            .await
            .unwrap_err()
            .to_string();
    assert!(!error.contains("已恢复原容器"));
    assert!(error.contains("原容器未删除") && error.contains("原配置还原失败"));
    let requests = fixture.recorded();
    assert_isolated_restore_body(&requests);
    assert!(
        position(&requests, "DELETE", "/containers/candidate-id")
            < position(&requests, "POST", "/containers/restore-id/start")
    );
    assert!(
        position(&requests, "GET", "/containers/restore-id/json")
            < position(&requests, "DELETE", "/containers/restore-id")
    );
    assert!(
        !requests.iter().any(|request| request.is("POST", "/containers/original-id/start")),
        "do not start the original with an unrestored shared home"
    );
    assert_original_preserved(&requests);
}

#[tokio::test]
async fn stopped_container_rebuild_preserves_original_config_and_uses_final_snapshot() {
    let fixture = Fixture::new(Failure::None);
    let inspect = fixture.inspect(false);
    let request = fixture.request(&inspect);
    let result = rebuild_candidate(
        &fixture.docker(),
        NAME,
        &inspect,
        &request,
        vec!["fixture warning".into()],
        fixture.detach(),
    )
    .await
    .unwrap();
    assert_eq!(result.container_id, CANDIDATE);
    assert!(!result.restarted);
    assert!(result.backup_container.is_none());
    assert_eq!(result.warnings, ["fixture warning"]);
    let requests = fixture.recorded();
    assert!(!requests.iter().any(|request| request.path.ends_with("/stop")
        || request.path.ends_with("/start")
        || request.path.ends_with("/json")));
    let creates: Vec<_> = requests.iter().filter(|request| request.is("POST", "/containers/create")).collect();
    assert_eq!(creates.len(), 2);
    assert_eq!(creates[0].json()["Image"], "sha256:original-image");
    let body = creates[1].json();
    let commit = &requests[position(&requests, "POST", "/commit")];
    let snapshot = format!("{}:{}", commit.query["repo"], commit.query["tag"]);
    assert_eq!(body["Image"], snapshot);
    assert_eq!(result.snapshot_image.as_deref(), Some(snapshot.as_str()));
    assert_eq!(body["Env"], json!(inspect.config.as_ref().unwrap().env));
    assert_eq!(body["Hostname"], "original-hostname");
    assert_eq!(body["WorkingDir"], "/workspace/project");
    assert_eq!(body["Cmd"], json!(["sleep", "infinity"]));
    assert_eq!(body["Labels"]["custom.label"], "kept");
    assert_eq!(body["Labels"][spec::LABEL_HOST_CONFIG_IMAGE], "1");
    assert!(body["HostConfig"]["Binds"].as_array().unwrap().contains(&json!("extra-cache:/var/cache/tool:ro")));
    assert!(body["HostConfig"]["Mounts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|mount| mount["Source"] == "extra-data" && mount["Target"] == "/opt/data"));
    assert!(body["HostConfig"]["Mounts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|mount| mount["Target"] == format!("{HOST_CONFIG_ROOT}/skills") && mount["ReadOnly"] == true));
    assert_eq!(body["HostConfig"]["PortBindings"], json!({"8123/tcp":[{"HostIp":"127.0.0.1","HostPort":"18123"}]}));
    assert_eq!(body["HostConfig"]["Memory"], 536870912);
    assert_eq!(body["HostConfig"]["NanoCpus"], 1500000000);
    assert_eq!(requests.iter().filter(|request| request.path.ends_with("/archive")).count(), 22);
    assert!(requests.last().unwrap().is("DELETE", "/containers/original-id"));
    for request in requests.iter().filter(|request| request.method == "DELETE") {
        assert_eq!(request.query.get("v").map(String::as_str), Some("false"));
    }
    assert!(!requests.iter().any(|request| request.path.contains("/volumes/")));
}

#[tokio::test]
async fn successful_rebuild_reports_backup_when_old_container_cleanup_fails() {
    let fixture = Fixture::new(Failure::BackupDelete);
    let inspect = fixture.inspect(false);
    let result =
        rebuild_candidate(&fixture.docker(), NAME, &inspect, &fixture.request(&inspect), vec![], fixture.detach())
            .await
            .unwrap();
    assert_eq!(result.container_id, CANDIDATE);
    assert!(result.backup_container.as_ref().is_some_and(|name| name.starts_with("tdc-backup-")));
    assert!(result.warnings.iter().any(|warning| warning.contains("新容器已就绪") && warning.contains("删除失败")));
    assert!(!fixture.recorded().iter().any(|request| request.is("DELETE", "/containers/candidate-id")));
}

fn read_json_file(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn assert_exec_only(requests: &[Request]) {
    assert!(
        requests.iter().all(|request| request.is("POST", "/containers/original-id/exec")
            || (request.path.contains("/exec/") && (request.method == "GET" || request.method == "POST"))),
        "MCP refresh must not stop, detach, create, delete, or restart containers"
    );
}

#[tokio::test]
async fn mcp_refresh_updates_export_and_running_private_copy_without_rebuilding() {
    for running in [false, true] {
        let fixture = Fixture::new(Failure::None);
        let change = fixture.mcp_change();
        refresh_mcp(&fixture.docker(), ORIGINAL, running, &change.prepared, &change.export, &change.root)
            .await
            .unwrap();
        assert_eq!(read_json_file(&change.export.join("mcp.json")), change.new);
        assert_eq!(
            read_json_file(&fixture.directory.join("private-mcp.json")),
            if running { change.new.clone() } else { change.old.clone() }
        );
        assert_eq!(read_json_file(&change.source)["oauthAccount"]["token"], "fixture-account-secret");
        assert_eq!(std::fs::read_dir(&change.export).unwrap().count(), 1, "atomic export must not leave temp files");
        let requests = fixture.recorded();
        if running {
            assert_exec_only(&requests);
            let execs: Vec<_> = requests
                .iter()
                .filter(|request| request.is("POST", "/containers/original-id/exec"))
                .map(Request::json)
                .collect();
            assert_eq!(execs.len(), 3);
            assert_eq!(execs[0]["Cmd"], json!(["id", "-g", "node"]));
            assert_eq!(execs[0]["User"], "root");
            assert_eq!(execs[1]["Cmd"], json!(["node", "/opt/tdc/tdc-host-config.mjs", "refresh-mcp", "1000"]));
            assert_eq!(execs[1]["User"], "root");
            assert_eq!(execs[2]["Cmd"], json!(["test", "-r", "/var/lib/tdc/host-config/mcp.json"]));
            assert_eq!(execs[2]["User"], "node");
            assert_eq!(*fixture.private_copies.lock().unwrap(), [change.new]);
        } else {
            assert!(requests.is_empty());
            assert!(fixture.private_copies.lock().unwrap().is_empty());
        }
    }
}

#[tokio::test]
async fn failed_mcp_copy_or_readability_check_restores_export_and_private_copy() {
    for failure in [Failure::RefreshCopyOnce, Failure::RefreshReadOnce] {
        let fixture = Fixture::new(failure);
        let change = fixture.mcp_change();
        let error = refresh_mcp(&fixture.docker(), ORIGINAL, true, &change.prepared, &change.export, &change.root)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("已恢复旧配置") && error.contains("当前终端未关闭"));
        assert_eq!(read_json_file(&change.export.join("mcp.json")), change.old);
        assert_eq!(read_json_file(&fixture.directory.join("private-mcp.json")), change.old);
        assert_eq!(
            read_json_file(&change.source)["mcpServers"],
            change.new["mcpServers"],
            "the source file is not rolled back"
        );
        assert_eq!(*fixture.private_copies.lock().unwrap(), [change.new, change.old]);
        assert_exec_only(&fixture.recorded());
    }
}

#[tokio::test]
async fn failed_mcp_rollback_reports_incomplete_recovery_without_stopping_the_container() {
    let fixture = Fixture::new(Failure::RefreshAlways);
    let change = fixture.mcp_change();
    let error = refresh_mcp(&fixture.docker(), ORIGINAL, true, &change.prepared, &change.export, &change.root)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("旧配置恢复未完成") && error.contains("当前终端未关闭"));
    assert!(!error.contains("已恢复旧配置"));
    assert_eq!(read_json_file(&change.export.join("mcp.json")), change.old);
    assert_eq!(read_json_file(&fixture.directory.join("private-mcp.json")), change.new);
    assert_exec_only(&fixture.recorded());
}

#[tokio::test]
async fn configured_start_skips_unconfigured_containers_and_checks_initialization_results() {
    for (configured, issues) in [(false, false), (true, false), (true, true)] {
        let fixture = Fixture::new(if issues { Failure::InitializationIssues } else { Failure::None });
        if configured {
            let metadata = serde_json::to_string(&HostClaudeConfig {
                skills: Some(fixture.directory.join("skills").to_string_lossy().into_owned()),
                mcp_configs: vec![fixture.directory.join("source-mcp.json").to_string_lossy().into_owned()],
                ..Default::default()
            })
            .unwrap();
            fixture.inspect_reply.lock().unwrap()["Config"]["Labels"][spec::LABEL_HOST_CONFIG_SOURCES] =
                json!(metadata);
        }
        let result = verify_configured_start(&fixture.docker(), ORIGINAL).await;
        if issues {
            assert!(result.unwrap_err().to_string().contains("宿主资源初始化失败"));
        } else {
            result.unwrap();
        }
        let requests = fixture.recorded();
        if !configured {
            assert_eq!(requests.len(), 1);
            assert!(requests[0].is("GET", "/containers/original-id/json"));
        } else {
            let execs: Vec<_> = requests
                .iter()
                .filter(|request| request.is("POST", "/containers/original-id/exec"))
                .map(Request::json)
                .collect();
            assert_eq!(execs.len(), 2);
            assert_eq!(execs[0]["User"], "node");
            let shell = execs[0]["Cmd"][2].as_str().unwrap();
            assert!(shell.contains("readlink -f /usr/local/bin/tdc-claude-real"));
            assert!(shell.contains("readlink -f /opt/tdc/tdc-claude.sh"));
            assert!(shell.contains(" != ") && shell.contains("test -r /var/lib/tdc/host-config/mcp.json"));
            assert_eq!(execs[1]["Cmd"], json!(["/opt/tdc/tdc-ctl.sh", "link-shared"]));
            assert_eq!(execs[1]["User"], "node");
        }
        assert!(!requests.iter().any(|request| request.method == "DETACH"
            || request.is("POST", "/containers/create")
            || request.is("POST", "/containers/original-id/start")
            || request.is("POST", "/containers/original-id/stop")));
    }
}

#[test]
fn missing_legacy_group_label_keeps_custom_shared_volume_sources() {
    let fixture = Fixture::new(Failure::None);
    let mut inspect = fixture.inspect(false);
    inspect.config.as_mut().unwrap().labels.as_mut().unwrap().remove(spec::LABEL_GROUP);
    let host = inspect.host_config.as_mut().unwrap();
    for bind in host.binds.as_mut().unwrap() {
        if let Some((_, tail)) = crate::commands::container_cmds::split_bind(bind) {
            match tail.split(':').next().unwrap() {
                spec::PROJECTS_DIR => *bind = format!("custom-existing-projects:{}", spec::PROJECTS_DIR),
                spec::SHARED_DIR => *bind = format!("custom-existing-memory:{}", spec::SHARED_DIR),
                _ => {}
            }
        }
    }
    let body = candidate_body(&inspect, &fixture.request(&inspect), "snapshot:final").unwrap();
    let binds = body.host_config.unwrap().binds.unwrap();
    for (target, expected) in
        [(spec::PROJECTS_DIR, "custom-existing-projects"), (spec::SHARED_DIR, "custom-existing-memory")]
    {
        let sources: Vec<_> = binds
            .iter()
            .filter_map(|bind| {
                let (source, tail) = crate::commands::container_cmds::split_bind(bind)?;
                (tail.split(':').next() == Some(target)).then_some(source)
            })
            .collect();
        assert_eq!(sources, [expected]);
    }
}

#[test]
fn candidate_body_preserves_custom_network_options_without_runtime_identifiers() {
    let fixture = Fixture::new(Failure::None);
    let mut inspect = fixture.inspect(false);
    let id = "0123456789abcdef".repeat(4);
    inspect.id = Some(id.clone());
    inspect.host_config.as_mut().unwrap().network_mode = Some("custom-net".into());
    inspect.network_settings = Some(serde_json::from_value(json!({"Networks":{"custom-net":{
        "Aliases":[id,&id[..12],"frontend",NAME],"Links":["db:db"],"DriverOpts":{"fixture.option":"kept"},"GwPriority":17,
        "IPAddress":"172.31.0.8","MacAddress":"02:42:ac:1f:00:08","EndpointID":"old-endpoint","NetworkID":"old-network"
    }}})).unwrap());
    let body = candidate_body(&inspect, &fixture.request(&inspect), "snapshot:final").unwrap();
    let networks = body.networking_config.unwrap().endpoints_config.unwrap();
    let endpoint = &networks["custom-net"];
    assert_eq!(endpoint.aliases.as_ref().unwrap(), &["frontend", NAME]);
    assert_eq!(endpoint.links.as_ref().unwrap(), &["db:db"]);
    assert_eq!(endpoint.driver_opts.as_ref().unwrap()["fixture.option"], "kept");
    assert_eq!(endpoint.gw_priority, Some(17));
    assert!(
        endpoint.ip_address.is_none()
            && endpoint.mac_address.is_none()
            && endpoint.endpoint_id.is_none()
            && endpoint.network_id.is_none()
    );
}

#[tokio::test]
async fn edit_mounts_rebuild_preserves_account_volumes_ports_env_and_typed_mounts() {
    use crate::commands::container_edit_cmds::read_edit;
    let fixture = Fixture::new(Failure::None);
    let mut inspect = fixture.inspect(false);
    inspect.host_config.as_mut().unwrap().mounts.as_mut().unwrap().extend([
        Mount {
            typ: Some(MountType::BIND),
            source: Some("D:/unchanged".into()),
            target: Some("/workspace/unchanged".into()),
            read_only: Some(true),
            bind_options: Some(serde_json::from_value(json!({"Propagation":"rprivate"})).unwrap()),
            ..Default::default()
        },
        Mount {
            typ: Some(MountType::BIND),
            source: Some("D:/skills".into()),
            target: Some(format!("{HOST_CONFIG_ROOT}/skills")),
            read_only: Some(true),
            ..Default::default()
        },
    ]);
    let mut edit = read_edit(&inspect).unwrap();
    assert_eq!(edit.mounts.len(), 2, "host config and account mounts are not editable projects");
    edit.mounts.iter_mut().find(|mount| mount.container_path == "/workspace/project").unwrap().host_path =
        "D:/new-project".into();
    edit.mounts.push(spec::ProjectMount {
        host_path: "D:/added".into(),
        container_path: "/workspace/added".into(),
        read_only: false,
    });
    edit.cpus = 3.0;
    edit.memory_mb = 1024;
    let request = fixture.request(&inspect);
    rebuild_candidate_with_edit(&fixture.docker(), NAME, &inspect, &request, vec![], Some(&edit), fixture.detach())
        .await
        .unwrap();
    let requests = fixture.recorded();
    let created = requests.iter().rfind(|request| request.is("POST", "/containers/create")).unwrap().json();
    assert_eq!(created["Env"], json!(inspect.config.as_ref().unwrap().env));
    assert_eq!(created["HostConfig"]["PortBindings"], json!(inspect.host_config.as_ref().unwrap().port_bindings));
    assert!(created["HostConfig"]["Binds"]
        .as_array()
        .unwrap()
        .contains(&json!("tdc_home_host-test:/home/node/.claude")));
    assert!(!created["HostConfig"]["Binds"]
        .as_array()
        .unwrap()
        .iter()
        .any(|bind| bind.as_str().unwrap().contains("/workspace/project")));
    let mounts = created["HostConfig"]["Mounts"].as_array().unwrap();
    assert!(mounts.iter().any(|mount| mount["Target"] == "/workspace/project"
        && mount["Source"] == "D:/new-project"
        && mount["ReadOnly"] == true));
    assert!(mounts
        .iter()
        .any(|mount| mount["Target"] == "/workspace/added" && mount["BindOptions"]["CreateMountpoint"] == false));
    assert!(mounts
        .iter()
        .any(|mount| mount["Target"] == "/workspace/unchanged" && mount["BindOptions"]["Propagation"] == "rprivate"));
    assert!(mounts.iter().any(|mount| mount["Source"] == "extra-data"));
    assert_eq!(created["HostConfig"]["NanoCpus"], 3_000_000_000_i64);
    assert_eq!(created["HostConfig"]["Memory"], 1024 * 1024 * 1024);
    assert!(!requests.iter().any(|request| request.path.contains("/volumes/")));
}

#[tokio::test]
async fn edit_mount_failure_restores_original_and_protected_targets_fail_before_mutation() {
    use crate::commands::container_edit_cmds::read_edit;
    let fixture = Fixture::new(Failure::CandidateStart);
    let inspect = fixture.inspect(true);
    let mut edit = read_edit(&inspect).unwrap();
    edit.mounts.clear();
    assert!(rebuild_candidate_with_edit(
        &fixture.docker(),
        NAME,
        &inspect,
        &fixture.request(&inspect),
        vec![],
        Some(&edit),
        fixture.detach()
    )
    .await
    .is_err());
    let requests = fixture.recorded();
    assert_original_preserved(&requests);
    assert!(requests.iter().any(|request| request.is("POST", "/containers/original-id/start")));

    let fixture = Fixture::new(Failure::None);
    let inspect = fixture.inspect(false);
    for target in ["/home/node/.claude", "/home/node", "/opt/tdc/host-config/skills", "/opt/data", "/"] {
        let mut edit = read_edit(&inspect).unwrap();
        edit.mounts.push(spec::ProjectMount {
            host_path: "D:/project".into(),
            container_path: target.into(),
            read_only: false,
        });
        assert!(
            rebuild_candidate_with_edit(
                &fixture.docker(),
                NAME,
                &inspect,
                &fixture.request(&inspect),
                vec![],
                Some(&edit),
                fixture.detach()
            )
            .await
            .is_err(),
            "{target}"
        );
        assert!(fixture.recorded().is_empty(), "invalid targets must be rejected before touching Docker");
    }
}
