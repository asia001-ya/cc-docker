//! Update the bundled statusline collector in existing standard containers without restarting sessions.
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::Duration;

use crate::docker::client::DockerClient;
use crate::error::{AppError, AppResult};

const FILES: &[(&str, &str)] = &[
    ("tdc-quota.mjs", include_str!("../../../docker/rootfs/opt/tdc/tdc-quota.mjs")),
    ("statusline-display.mjs", include_str!("../../../docker/rootfs/opt/tdc/statusline-display.mjs")),
    ("tdc-session-history.mjs", include_str!("../../../docker/rootfs/opt/tdc/tdc-session-history.mjs")),
    ("statusline.mjs", include_str!("../../../docker/rootfs/opt/tdc/statusline.mjs")),
];

pub async fn ensure(docker: &DockerClient, id: &str) -> AppResult<()> {
    static INSTALLED: OnceLock<tokio::sync::Mutex<HashSet<String>>> = OnceLock::new();
    let mut installed = INSTALLED.get_or_init(Default::default).lock().await;
    if installed.contains(id) {
        return Ok(());
    }
    let inspect = docker.inspect(id).await?;
    let labels = inspect.config.as_ref().and_then(|config| config.labels.as_ref());
    if labels.and_then(|labels| labels.get("tdc.image")).map(String::as_str) != Some("claude-dev") {
        // Custom images retain their own collectors.
        installed.insert(id.into());
        return Ok(());
    }
    if inspect
        .mounts
        .as_deref()
        .unwrap_or_default()
        .iter()
        .any(|mount| crate::docker::spec::host_config_runtime_overlap(mount.destination.as_deref().unwrap_or("")))
    {
        return Err(AppError::Invalid("额度采集脚本被自定义挂载覆盖，无法更新".into()));
    }
    for (file, source) in FILES {
        let target = format!("/opt/tdc/{file}");
        let staged = format!("{target}.tdc-next");
        docker.write_file_owned(id, &staged, source.replace("\r\n", "\n").as_bytes(), 0o755, 0).await?;
        let moved = docker.exec_as(id, "root", &["mv", "-f", &staged, &target], None, Duration::from_secs(5)).await?;
        if moved.exit_code != Some(0) {
            return Err(AppError::Other("无法安装额度采集脚本".into()));
        }
    }
    installed.insert(id.into());
    Ok(())
}

pub async fn refresh(docker: &DockerClient, name: &str) -> AppResult<(String, super::model::QuotaSnapshot)> {
    let info = docker.get(name).await?;
    if !info.running {
        return Err(AppError::Invalid("请先启动容器再刷新额度".into()));
    }
    ensure(docker, &info.id).await?;
    let output =
        docker.exec_as(&info.id, "node", &["node", "/opt/tdc/tdc-quota.mjs"], None, Duration::from_secs(20)).await?;
    let value: serde_json::Value = serde_json::from_str(output.stdout.trim())
        .map_err(|_| AppError::Other("额度刷新未返回有效结果，请更新标准镜像".into()))?;
    if output.exit_code != Some(0) || value["ok"] != true {
        return Err(AppError::Other(value["error"].as_str().unwrap_or("额度刷新失败").into()));
    }
    Ok((info.id, serde_json::from_value(value["quota"].clone())?))
}
