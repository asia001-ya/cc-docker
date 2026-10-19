//! 代理命令：节点库 CRUD、新建前自检、单容器开关 / 选节点 / 测延迟 / 刷新订阅、补授代理能力（重建容器）。
//!
//! 容器内执行一律经 `tdc-ctl proxy-*`（root），配置文件以 root 0600 写入 /var/lib/tdc/proxy。

use std::collections::HashMap;
use std::time::Duration;

use bollard::models::{ContainerCreateBody, DeviceMapping, HealthConfig, HostConfig};
use bollard::query_parameters::{CreateContainerOptions, RemoveContainerOptions};

use serde::Serialize;
use tauri::State;

use crate::commands::container_cmds::recreate_container;
use crate::docker::client::DockerClient;
use crate::docker::spec::{self, ProxyCapability, PROXY_CONFIG, PROXY_INTENT};
use crate::error::{AppError, AppResult};
use crate::proxy::{ProxyBinding, ProxyNode, ProxyNodeView};
use crate::state::AppState;

/// apply 包含内核启动与自检（探测最长约 25 秒），给足余量。
const APPLY_TIMEOUT: Duration = Duration::from_secs(150);
/// 其余代理子命令的超时。
const CTL_TIMEOUT: Duration = Duration::from_secs(30);

/// 单容器代理视图。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyInfo {
    /// 期望状态（未配置过为 None）
    pub binding: Option<ProxyBinding>,
    /// 代理能力
    pub capability: ProxyCapability,
    /// 容器是否运行中
    pub running: bool,
}

/// 列出节点。参数：state——全局状态；返回：节点视图列表。
#[tauri::command]
pub fn proxy_node_list(state: State<'_, AppState>) -> Vec<ProxyNodeView> {
    state.proxies.list()
}

/// 保存节点。参数：state——全局状态；node——节点；secret——订阅地址或 vless 链接（None 不修改）；返回：保存后的节点。
#[tauri::command]
pub fn proxy_node_save(state: State<'_, AppState>, node: ProxyNode, secret: Option<String>) -> AppResult<ProxyNode> {
    state.proxies.save(node, secret)
}

/// 删除节点。参数：state——全局状态；id——节点 ID；返回：成功与否。
#[tauri::command]
pub fn proxy_node_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.proxies.delete(&id)
}

/// 读取单容器代理视图。参数：state——全局状态；container——容器名；返回：视图。
#[tauri::command]
pub async fn proxy_get(state: State<'_, AppState>, container: String) -> AppResult<ProxyInfo> {
    let ins = state.docker()?.inspect(&container).await?;
    Ok(ProxyInfo {
        binding: state.proxies.binding_of(&container),
        capability: spec::proxy_capability(&ins),
        running: ins.state.and_then(|s| s.running).unwrap_or(false),
    })
}

/// 应用代理设置：保存绑定 → 生成配置写入容器 → 容器内校验、施加兜底、启动内核并自检。
/// 参数：state——全局状态；container——容器名；binding——期望状态；返回：容器内 apply 的 JSON 结果。
#[tauri::command]
pub async fn proxy_apply(
    state: State<'_, AppState>,
    container: String,
    binding: ProxyBinding,
) -> AppResult<serde_json::Value> {
    if !binding.enabled {
        return proxy_off(state, container).await;
    }
    let docker = state.docker()?;
    let ins = docker.inspect(&container).await?;
    let cap = spec::proxy_capability(&ins);
    ensure_ready(&cap)?;
    if !ins.state.and_then(|s| s.running).unwrap_or(false) {
        return Err(AppError::Invalid("容器未运行，请先启动容器".into()));
    }
    // 先渲染（会校验节点必填与静态中转），通过后才保存绑定，避免存下无法生效的配置
    let rendered = state.proxies.render(&binding)?;
    ensure_engine_supported(&rendered, cap.xray)?;
    state.proxies.bind(&container, binding)?;
    write_bundle(&docker, &container, &rendered.config, &rendered.intent).await?;
    let out = match docker.tdc_ctl_root(&container, &["proxy-apply"], APPLY_TIMEOUT).await {
        Ok(mut result) => {
            add_exit_ip(&docker, &container, &mut result).await;
            Ok(result)
        }
        Err(error) => Err(error),
    };
    state.wake.notify_one();
    out
}

/// 新建前自检：不保存绑定，使用无挂载、无端口的临时容器执行同一套 proxy-apply。
#[tauri::command]
pub async fn proxy_preflight(
    state: State<'_, AppState>,
    image: String,
    binding: ProxyBinding,
) -> AppResult<serde_json::Value> {
    if !binding.enabled {
        return Err(AppError::Invalid("请先开启代理并选择节点".into()));
    }
    let docker = state.docker()?;
    let image = validate_proxy_image(&docker, &image).await?;
    let rendered = state.proxies.render(&binding)?;
    ensure_engine_supported(&rendered, image_has_xray(&docker, &image).await)?;
    run_proxy_preflight(&docker, &image, &rendered).await
}

/// 镜像是否内置 Xray 内核。参数：docker——客户端；image——镜像名或 ID；返回：是否带 tdc.xray 标签。
pub(crate) async fn image_has_xray(docker: &DockerClient, image: &str) -> bool {
    docker
        .raw()
        .inspect_image(image)
        .await
        .ok()
        .and_then(|i| i.config)
        .and_then(|c| c.labels)
        .is_some_and(|l| l.get(spec::LABEL_XRAY_IMAGE).is_some_and(|v| v == "1"))
}

/// 主节点使用 Xray 内核时，镜像必须已内置 Xray（运行时不下载）。
/// 参数：rendered——渲染结果；has_xray——镜像是否内置 Xray；返回：满足时 Ok。
pub(crate) fn ensure_engine_supported(rendered: &crate::proxy::render::Rendered, has_xray: bool) -> AppResult<()> {
    if rendered.intent["engine"] == "xray" && !has_xray {
        return Err(AppError::Invalid(
            "所选节点使用 Xray 内核，但该镜像未内置 Xray：请用最新 docker/Dockerfile 重新构建镜像后重建容器，或在节点编辑中把内核改回 Mihomo".into(),
        ));
    }
    Ok(())
}

/// 与创建预检共用镜像能力检查，返回固定镜像 ID，避免测试期间标签被更新。
pub(crate) async fn validate_proxy_image(docker: &DockerClient, image: &str) -> AppResult<String> {
    let inspected = docker.raw().inspect_image(image).await?;
    let config = inspected.config.as_ref();
    if !config.and_then(|c| c.labels.as_ref()).and_then(|l| l.get(spec::LABEL_PROXY_IMAGE)).is_some_and(|v| v == "1") {
        return Err(AppError::Invalid("所选镜像不支持代理，请先构建最新标准镜像或关闭代理".into()));
    }
    let user = config.and_then(|c| c.user.as_deref()).unwrap_or_default();
    if !matches!(user.split(':').next().unwrap_or_default(), "" | "root" | "0") {
        return Err(AppError::Invalid("所选镜像以非 root 用户启动，无法应用代理，请使用标准镜像或关闭代理".into()));
    }
    Ok(inspected.id.unwrap_or_else(|| image.into()))
}

/// 测试容器只运行限时 sleep；即使桌面端退出，240 秒后也会退出并自动删除。
fn preflight_body(image: &str) -> ContainerCreateBody {
    ContainerCreateBody {
        image: Some(image.into()),
        user: Some("root".into()),
        entrypoint: Some(vec!["/bin/sleep".into(), "240".into()]),
        cmd: Some(vec![]),
        healthcheck: Some(HealthConfig { test: Some(vec!["NONE".into()]), ..Default::default() }),
        labels: Some(HashMap::from([
            (spec::LABEL_MANAGED.into(), "false".into()),
            ("tdc.proxy_check".into(), "true".into()),
        ])),
        host_config: Some(HostConfig {
            auto_remove: Some(true),
            cap_add: Some(vec!["NET_ADMIN".into()]),
            devices: Some(vec![DeviceMapping {
                path_on_host: Some(spec::TUN_DEVICE_PATH.into()),
                path_in_container: Some(spec::TUN_DEVICE_PATH.into()),
                cgroup_permissions: Some("rwm".into()),
            }]),
            sysctls: Some(HashMap::from([
                ("net.ipv6.conf.all.disable_ipv6".into(), "1".into()),
                ("net.ipv6.conf.default.disable_ipv6".into(), "1".into()),
            ])),
            ..Default::default()
        }),
        ..Default::default()
    }
}

async fn run_proxy_preflight(
    docker: &DockerClient,
    image: &str,
    rendered: &crate::proxy::render::Rendered,
) -> AppResult<serde_json::Value> {
    let name = format!("tdc-proxy-check-{}", uuid::Uuid::new_v4().simple());
    let created = docker
        .raw()
        .create_container(
            Some(CreateContainerOptions { name: Some(name.clone()), ..Default::default() }),
            preflight_body(image),
        )
        .await?;
    let result = tokio::time::timeout(Duration::from_secs(210), async {
        write_bundle(docker, &created.id, &rendered.config, &rendered.intent).await?;
        docker.start(&created.id).await?;
        let mut checked = docker.tdc_ctl_root(&created.id, &["proxy-apply"], APPLY_TIMEOUT).await?;
        if checked.get("ok").and_then(|v| v.as_bool()).is_none()
            || checked.get("stage").and_then(|v| v.as_str()).is_none()
        {
            return Err(AppError::Other("自检返回了无效结果，请确认镜像已更新".into()));
        }
        add_exit_ip(docker, &created.id, &mut checked).await;
        Ok(checked)
    })
    .await
    .unwrap_or_else(|_| Err(AppError::Other("代理自检超时，请检查节点后重试".into())));
    // 成功、检查不通过、命令报错和超时均清理；只操作本次 Docker 返回的唯一 ID。
    let cleanup = docker
        .raw()
        .remove_container(&created.id, Some(RemoveContainerOptions { force: true, v: true, link: false }))
        .await;
    if let Err(error) = cleanup {
        if !matches!(error, bollard::errors::Error::DockerResponseServerError { status_code: 404, .. }) {
            return Err(AppError::Other(format!(
                "自检结束，但临时容器 {name} 清理失败：{error}。运行中的测试容器最多 240 秒后自动退出"
            )));
        }
    }
    result
}

/// 仅从普通应用用户的网络路径查询，避免 root 豁免规则返回直连 IP。
async fn add_exit_ip(docker: &DockerClient, container: &str, result: &mut serde_json::Value) {
    if !result.is_object() {
        return;
    }
    result["exitIp"] = serde_json::Value::Null;
    result["exitIpError"] = serde_json::Value::Null;
    if result["checks"]["proxied"] != true || result["checks"]["guard"] != true {
        result["exitIpError"] = serde_json::json!("代理尚未连通，未查询出口 IP");
        return;
    }
    for url in ["https://api.ipify.org", "https://ipv4.icanhazip.com"] {
        let response = docker
            .exec_as(
                container,
                spec::APP_USER,
                &[
                    "curl",
                    "--ipv4",
                    "--fail",
                    "--silent",
                    "--show-error",
                    "--max-time",
                    "8",
                    "--connect-timeout",
                    "4",
                    "--max-filesize",
                    "128",
                    "--noproxy",
                    "*",
                    url,
                ],
                None,
                Duration::from_secs(9),
            )
            .await;
        if let Ok(out) = response {
            if out.exit_code == Some(0) {
                if let Some(ip) = parse_exit_ip(&out.stdout) {
                    result["exitIp"] = serde_json::json!(ip);
                    return;
                }
            }
        }
    }
    // IP 查询服务不可达不改变已经完成的七项网络自检结果。
    result["exitIpError"] = serde_json::json!("出口 IP 查询服务暂不可用，可重新自检");
}

fn parse_exit_ip(body: &str) -> Option<String> {
    body.trim().parse::<std::net::IpAddr>().ok().map(|ip| ip.to_string())
}

/// 关闭代理（救援入口：不依赖容器网络）。参数：state——全局状态；container——容器名；返回：容器内结果。
#[tauri::command]
pub async fn proxy_off(state: State<'_, AppState>, container: String) -> AppResult<serde_json::Value> {
    let docker = state.docker()?;
    state.proxies.update_binding(&container, |b| b.enabled = false)?;
    let out = docker.tdc_ctl_root(&container, &["proxy-off"], CTL_TIMEOUT).await;
    state.wake.notify_one();
    out
}

/// 列出当前节点组的全部节点。参数：state——全局状态；container——容器名；返回：{now, all}。
#[tauri::command]
pub async fn proxy_nodes(state: State<'_, AppState>, container: String) -> AppResult<serde_json::Value> {
    ctl_ok(state.docker()?.tdc_ctl_root(&container, &["proxy-nodes"], CTL_TIMEOUT).await?)
}

/// 手动切换节点并记录到绑定。参数：state——全局状态；container——容器名；name——节点名；返回：{now}。
#[tauri::command]
pub async fn proxy_select(state: State<'_, AppState>, container: String, name: String) -> AppResult<serde_json::Value> {
    let out = ctl_ok(state.docker()?.tdc_ctl_root(&container, &["proxy-select", &name], CTL_TIMEOUT).await?)?;
    state.proxies.update_binding(&container, |b| b.selected = Some(name))?;
    state.wake.notify_one();
    Ok(out)
}

/// 对节点组测延迟。参数：state——全局状态；container——容器名；返回：{delays: {节点: 毫秒}}。
#[tauri::command]
pub async fn proxy_delay(state: State<'_, AppState>, container: String) -> AppResult<serde_json::Value> {
    ctl_ok(state.docker()?.tdc_ctl_root(&container, &["proxy-delay"], CTL_TIMEOUT).await?)
}

/// 立即刷新订阅。参数：state——全局状态；container——容器名；返回：{refreshed: [...]}。
#[tauri::command]
pub async fn proxy_refresh(state: State<'_, AppState>, container: String) -> AppResult<serde_json::Value> {
    let out = ctl_ok(state.docker()?.tdc_ctl_root(&container, &["proxy-refresh"], APPLY_TIMEOUT).await?)?;
    state.wake.notify_one();
    Ok(out)
}

/// 重建容器以授予代理能力（home 卷保留；会断开该容器的终端会话）。
/// 参数：state——全局状态；container——容器名；返回：成功与否。
#[tauri::command]
pub async fn proxy_capability_apply(state: State<'_, AppState>, container: String) -> AppResult<()> {
    let docker = state.docker()?;
    let ins = docker.inspect(&container).await?;
    let image = ins.config.as_ref().and_then(|c| c.image.clone()).unwrap_or_default();
    if !docker.image_supports_proxy(&image).await {
        return Err(AppError::Invalid(format!(
            "镜像 {image} 不支持代理，请先在 docker 目录重新构建：docker build -t {image} ."
        )));
    }
    recreate_container(&state, &container, |req| req.proxy_capable = true).await?;
    state.wake.notify_one();
    Ok(())
}

/// 容器启动或重建前推送代理配置（仅绑定已启用时）：entrypoint 据此在任何用户进程之前施加兜底。
/// 参数：state——全局状态；docker——客户端；container——容器名；返回：是否推送了配置。
pub async fn push_proxy_files(state: &AppState, docker: &DockerClient, container: &str) -> AppResult<bool> {
    let Some(binding) = state.proxies.binding_of(container).filter(|b| b.enabled) else {
        return Ok(false);
    };
    let rendered = state.proxies.render(&binding)?;
    write_bundle(docker, container, &rendered.config, &rendered.intent).await?;
    Ok(true)
}

/// 写入 config 与 intent（root 0600）。
/// 参数：docker——客户端；container——容器名；config——mihomo 配置；intent——期望状态；返回：成功与否。
pub(crate) async fn write_bundle(
    docker: &DockerClient,
    container: &str,
    config: &serde_json::Value,
    intent: &serde_json::Value,
) -> AppResult<()> {
    // 同步运行时脚本后再写期望状态；Xray 二进制只来自镜像（tdc.xray 标签），不在运行时下载。
    for (path, content) in [
        ("/opt/tdc/lan-policy.json", include_str!("../../../docker/rootfs/opt/tdc/lan-policy.json")),
        ("/opt/tdc/tdc-lan.mjs", include_str!("../../../docker/rootfs/opt/tdc/tdc-lan.mjs")),
        ("/opt/tdc/proxy-guard.sh", include_str!("../../../docker/rootfs/opt/tdc/proxy-guard.sh")),
        ("/opt/tdc/tdc-proxy-lib.mjs", include_str!("../../../docker/rootfs/opt/tdc/tdc-proxy-lib.mjs")),
        ("/opt/tdc/tdc-xray.mjs", include_str!("../../../docker/rootfs/opt/tdc/tdc-xray.mjs")),
        ("/opt/tdc/tdc-proxy.sh", include_str!("../../../docker/rootfs/opt/tdc/tdc-proxy.sh")),
    ] {
        docker.write_file_owned(container, path, content.replace("\r\n", "\n").as_bytes(), 0o755, 0).await?;
    }
    docker.write_file_owned(container, PROXY_CONFIG, &serde_json::to_vec_pretty(config)?, 0o600, 0).await?;
    docker.write_file_owned(container, PROXY_INTENT, &serde_json::to_vec(intent)?, 0o600, 0).await
}

/// 能力不足时给出可操作的中文提示。参数：cap——能力；返回：满足时 Ok。
fn ensure_ready(cap: &ProxyCapability) -> AppResult<()> {
    if !cap.image_supported {
        return Err(AppError::Invalid("该容器的镜像不支持代理：请重新构建镜像后，用「授予代理能力」重建容器".into()));
    }
    if !cap.root_entry {
        return Err(AppError::Invalid("该容器以非 root 用户启动，无法施加代理兜底规则，需要重建".into()));
    }
    if !cap.granted {
        return Err(AppError::Invalid("该容器创建时未授予代理能力（NET_ADMIN + /dev/net/tun），需要重建".into()));
    }
    Ok(())
}

/// 把容器内 {ok:false,error} 结果转为错误。参数：v——tdc-ctl 输出；返回：ok 时原样返回。
fn ctl_ok(v: serde_json::Value) -> AppResult<serde_json::Value> {
    if v.get("ok").and_then(|o| o.as_bool()) == Some(false) {
        let msg = v.get("error").and_then(|e| e.as_str()).unwrap_or("容器内命令失败");
        return Err(AppError::Other(msg.to_string()));
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 出口查询只接受单个有效地址() {
        assert_eq!(parse_exit_ip(" 203.0.113.10\n"), Some("203.0.113.10".into()));
        assert_eq!(parse_exit_ip("2001:db8::1"), Some("2001:db8::1".into()));
        for bad in ["", "<html>error</html>", "203.0.113.10\n203.0.113.11", "999.1.1.1"] {
            assert!(parse_exit_ip(bad).is_none());
        }
    }

    #[test]
    fn 自检容器无用户挂载和端口且会限时自动清理() {
        let body = preflight_body("test-image");
        assert_eq!(body.image.as_deref(), Some("test-image"));
        assert_eq!(body.entrypoint.unwrap(), ["/bin/sleep", "240"]);
        assert!(body.cmd.unwrap().is_empty());
        assert!(body.volumes.is_none());
        assert!(body.exposed_ports.is_none());
        assert_eq!(body.labels.unwrap()[spec::LABEL_MANAGED], "false");
        let host = body.host_config.unwrap();
        assert!(host.binds.is_none());
        assert!(host.mounts.is_none());
        assert!(host.port_bindings.is_none());
        assert_eq!(host.auto_remove, Some(true));
        assert_eq!(host.cap_add.unwrap(), ["NET_ADMIN"]);
        assert_eq!(host.devices.unwrap()[0].path_on_host.as_deref(), Some(spec::TUN_DEVICE_PATH));
        assert_eq!(host.sysctls.unwrap()["net.ipv6.conf.all.disable_ipv6"], "1");
    }

    /// 使用不可达的本地节点验证真实检查与清理，不读取任何用户节点或凭据。
    #[tokio::test]
    #[ignore = "requires Docker and the local tdc image; uses only a disposable container and an unreachable local node"]
    async fn proxy_preflight_docker() {
        use crate::proxy::render::{render, NodeKind, ResolvedNode};
        use bollard::query_parameters::ListContainersOptions;
        let docker = DockerClient::connect("").unwrap();
        let image = std::env::var("TDC_PROXY_TEST_IMAGE").unwrap_or_else(|_| "tdc/claude-dev:latest".into());
        let image = validate_proxy_image(&docker, &image).await.unwrap();
        let list = || {
            Some(ListContainersOptions {
                all: true,
                filters: Some(HashMap::from([("label".into(), vec!["tdc.proxy_check=true".into()])])),
                ..Default::default()
            })
        };
        let before: Vec<_> =
            docker.raw().list_containers(list()).await.unwrap().into_iter().filter_map(|c| c.id).collect();
        for invalid_config in [true, false] {
            let node = ResolvedNode {
                name: "自检测试节点".into(),
                kind: NodeKind::Socks5,
                secret: "socks5://127.0.0.1:9".into(),
            };
            let mut rendered = render(&node, None, None, false, None).unwrap();
            if invalid_config {
                rendered.config["port"] = serde_json::json!("not-a-port");
            }
            let result = run_proxy_preflight(&docker, &image, &rendered).await.unwrap();
            assert_eq!(result["ok"], false, "不可达节点不能被误报为通过");
            assert!(result["exitIp"].is_null(), "不可达节点不能返回宿主的直连 IP");
            assert!(result["exitIpError"].is_string());
            if invalid_config {
                assert_eq!(result["stage"], "validate");
            } else {
                assert_eq!(result["checks"]["core"], true, "{result}");
                assert_eq!(result["checks"]["tun"], true, "{result}");
                assert_eq!(result["checks"]["guard"], true, "{result}");
                assert_eq!(result["checks"]["proxied"], false, "{result}");
            }
            let after = docker.raw().list_containers(list()).await.unwrap();
            assert!(after.iter().all(|c| before.contains(c.id.as_ref().unwrap())), "不能残留本次自检容器");
        }
    }
}
