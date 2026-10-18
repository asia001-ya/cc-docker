//! Host Git only sees sanitized HTTPS credential requests; no secrets in logs or IPC views.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Identity {
    pub name: Option<String>,
    pub email: Option<String>,
}
#[derive(Deserialize)]
pub struct CredentialRequest {
    pub protocol: String,
    pub host: String,
    #[serde(default)]
    pub path: String,
    pub username: Option<String>,
}
#[derive(Serialize)]
pub struct Credential {
    pub username: String,
    pub password: String,
}

fn clean(value: &str) -> bool {
    value.len() <= 16384 && !value.chars().any(char::is_control)
}
pub fn normalize_hosts(hosts: &[String]) -> AppResult<Vec<String>> {
    let mut result = Vec::new();
    if hosts.len() > 16 {
        return Err(AppError::Invalid("最多允许 16 个 Git 服务".into()));
    }
    for source in hosts {
        let host = source.trim().to_ascii_lowercase();
        let url = url::Url::parse(&format!("https://{host}"))
            .map_err(|_| AppError::Invalid("请输入 Git 域名，可附带端口，不含路径".into()))?;
        let domain = host.split(':').next().unwrap_or_default();
        let valid_domain = domain.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.as_bytes()[0].is_ascii_alphanumeric()
                && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        });
        if host.is_empty()
            || !valid_domain
            || host.len() > 253
            || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b".-:".contains(&b))
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(AppError::Invalid("请输入 Git 域名，可附带端口，不含路径".into()));
        }
        if !result.contains(&host) {
            result.push(host);
        }
    }
    Ok(result)
}
pub fn credential_input(request: &CredentialRequest, allowed: &[String]) -> Option<String> {
    if request.protocol != "https"
        || !allowed.contains(&request.host.to_ascii_lowercase())
        || !clean(&request.host)
        || !clean(&request.path)
        || request.username.as_deref().is_some_and(|v| !clean(v))
    {
        return None;
    }
    let mut input = format!("protocol=https\nhost={}\npath={}\n", request.host, request.path);
    if let Some(user) = &request.username {
        input += &format!("username={user}\n");
    }
    input.push('\n');
    Some(input)
}
pub async fn git(dir: &Path, args: &[&str], input: Option<&str>) -> AppResult<Option<String>> {
    let mut command = tokio::process::Command::new("git");
    command
        .current_dir(dir)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // Ignore inherited repository/config overrides, tracing and interactive login programs.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") || key.to_string_lossy().starts_with("GCM_") {
            command.env_remove(key);
        }
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let operation = async {
        let mut child =
            command.spawn().map_err(|_| AppError::Other("无法运行宿主 Git，请安装 Git 并加入 PATH".into()))?;
        let mut stdin = child.stdin.take().unwrap();
        if let Some(input) = input {
            stdin.write_all(input.as_bytes()).await?;
        }
        drop(stdin);
        let mut output = Vec::new();
        child.stdout.take().unwrap().take(65537).read_to_end(&mut output).await?;
        if output.len() > 65536 {
            return Err(AppError::Other("宿主 Git 返回内容超过限制".into()));
        }
        if !child.wait().await?.success() {
            return Ok(None);
        }
        Ok(String::from_utf8(output).ok())
    };
    tokio::time::timeout(Duration::from_secs(12), operation)
        .await
        .map_err(|_| AppError::Other("宿主 Git 查询超时".into()))?
}
pub async fn identity(dir: &Path) -> AppResult<Identity> {
    let mut result = Identity::default();
    for (key, target) in [("user.name", &mut result.name), ("user.email", &mut result.email)] {
        if let Some(value) = git(dir, &["config", "--get", key], None).await? {
            let value = value.trim();
            if !value.is_empty() && clean(value) {
                *target = Some(value.to_string());
            }
        }
    }
    Ok(result)
}
pub async fn fill(dir: &Path, request: &CredentialRequest, allowed: &[String]) -> Option<Credential> {
    let input = credential_input(request, allowed)?;
    let text = git(dir, &["-c", "credential.interactive=never", "credential", "fill"], Some(&input)).await.ok()??;
    let mut username = None;
    let mut password = None;
    for line in text.lines() {
        if let Some((key, value)) = line.split_once('=') {
            if !clean(value) {
                return None;
            }
            match key {
                "username" => username = Some(value.to_string()),
                "password" => password = Some(value.to_string()),
                _ => {}
            }
        }
    }
    Some(Credential { username: username?, password: password? })
}
