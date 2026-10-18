//! vless:// 分享链接解析：转换为 mihomo 的 proxies 条目。
//!
//! 字段映射与 mihomo v1.19.32 `common/convert/v.go::handleVShareLink` 保持一致，
//! 但比它更严格：缺少必填项、不认识的 security / type 直接报错，而不是静默跳过。
//! 节点保存时即解析，错误在 UI 上立即呈现。

use serde_json::{json, Map, Value};
use url::Url;

use crate::error::{AppError, AppResult};

/// 解析后的 vless 节点。
#[derive(Debug, Clone, PartialEq)]
pub struct VlessNode {
    /// mihomo proxies 条目（不含 name，由渲染时填入）
    pub proxy: Map<String, Value>,
    /// 展示用摘要：host:port · 安全层/传输
    pub display: String,
}

/// 解析 vless 分享链接。
/// 参数：uri——vless://uuid@host:port?参数#备注；返回：节点或中文错误。
pub fn parse(uri: &str) -> AppResult<VlessNode> {
    let uri = uri.trim();
    let url = Url::parse(uri).map_err(|e| invalid(format!("无法解析链接：{e}")))?;
    if url.scheme() != "vless" {
        return Err(invalid(format!("仅支持 vless:// 链接，当前为 {}://", url.scheme())));
    }
    let uuid = url.username();
    if uuid.is_empty() {
        return Err(invalid("缺少 uuid（vless://<uuid>@host:port）"));
    }
    let host = url.host_str().filter(|h| !h.is_empty()).ok_or_else(|| invalid("缺少服务器地址"))?;
    // url 库对 IPv6 主机返回带方括号的形式，mihomo 需要裸地址
    let host = host.trim_start_matches('[').trim_end_matches(']').to_string();
    let port = url.port().ok_or_else(|| invalid("缺少端口"))?;
    let q =
        |k: &str| url.query_pairs().find(|(key, _)| key == k).map(|(_, v)| v.into_owned()).filter(|v| !v.is_empty());

    let mut p = Map::new();
    p.insert("type".into(), json!("vless"));
    p.insert("server".into(), json!(host));
    p.insert("port".into(), json!(port));
    p.insert("uuid".into(), json!(uuid));
    p.insert("udp".into(), json!(true));

    let security = q("security").unwrap_or_default().to_ascii_lowercase();
    match security.as_str() {
        "" | "none" => {}
        "tls" | "reality" => {
            p.insert("tls".into(), json!(true));
            p.insert("client-fingerprint".into(), json!(q("fp").unwrap_or_else(|| "chrome".into())));
            if let Some(alpn) = q("alpn") {
                p.insert("alpn".into(), json!(alpn.split(',').map(str::trim).collect::<Vec<_>>()));
            }
        }
        other => return Err(invalid(format!("不支持的 security={other}（仅支持 none / tls / reality）"))),
    }
    if let Some(sni) = q("sni") {
        p.insert("servername".into(), json!(sni));
    }
    if security == "reality" {
        let pbk = q("pbk").ok_or_else(|| invalid("reality 节点缺少 pbk（公钥）"))?;
        p.insert("reality-opts".into(), json!({ "public-key": pbk, "short-id": q("sid").unwrap_or_default() }));
    }
    if matches!(q("allowInsecure").or_else(|| q("insecure")).as_deref(), Some("1" | "true")) {
        p.insert("skip-cert-verify".into(), json!(true));
    }
    if let Some(flow) = q("flow") {
        p.insert("flow".into(), json!(flow.to_ascii_lowercase()));
    }
    if let Some(enc) = q("encryption").filter(|e| e != "none") {
        p.insert("encryption".into(), json!(enc));
    }
    match q("packetEncoding").as_deref() {
        Some("none") => {}
        Some("packet") => {
            p.insert("packet-addr".into(), json!(true));
        }
        _ => {
            p.insert("xudp".into(), json!(true));
        }
    }

    let mut network = q("type").unwrap_or_else(|| "tcp".into()).to_ascii_lowercase();
    if network == "tcp" && q("headerType").as_deref() == Some("http") {
        network = "http".into();
    } else if network == "http" {
        network = "h2".into();
    }
    match network.as_str() {
        "tcp" => {}
        "http" => {
            let mut opts = json!({ "path": [q("path").unwrap_or_else(|| "/".into())] });
            if let Some(h) = q("host") {
                opts["headers"] = json!({ "Host": [h] });
            }
            if let Some(m) = q("method") {
                opts["method"] = json!(m);
            }
            p.insert("http-opts".into(), opts);
        }
        "h2" => {
            let mut opts = json!({ "path": q("path").unwrap_or_else(|| "/".into()) });
            if let Some(h) = q("host") {
                opts["host"] = json!([h]);
            }
            p.insert("h2-opts".into(), opts);
        }
        "ws" | "httpupgrade" => {
            let mut opts = json!({ "path": q("path").unwrap_or_else(|| "/".into()) });
            if let Some(h) = q("host") {
                opts["headers"] = json!({ "Host": h });
            }
            if let Some(ed) = q("ed") {
                let n: u32 = ed.parse().map_err(|_| invalid(format!("ed 参数不是数字：{ed}")))?;
                if network == "ws" {
                    opts["max-early-data"] = json!(n);
                    opts["early-data-header-name"] = json!("Sec-WebSocket-Protocol");
                } else {
                    opts["v2ray-http-upgrade-fast-open"] = json!(true);
                }
            }
            if let Some(eh) = q("eh") {
                opts["early-data-header-name"] = json!(eh);
            }
            p.insert("ws-opts".into(), opts);
        }
        "grpc" => {
            p.insert("grpc-opts".into(), json!({ "grpc-service-name": q("serviceName").unwrap_or_default() }));
        }
        "xhttp" => {
            if q("extra").is_some() {
                return Err(invalid("暂不支持带 extra 参数的 xhttp 链接"));
            }
            let mut opts = Map::new();
            for (k, v) in [("path", q("path")), ("host", q("host")), ("mode", q("mode"))] {
                if let Some(v) = v {
                    opts.insert(k.into(), json!(v));
                }
            }
            p.insert("xhttp-opts".into(), Value::Object(opts));
        }
        other => return Err(invalid(format!("不支持的传输 type={other}"))),
    }
    p.insert("network".into(), json!(network));

    let sec_label = if security.is_empty() { "none" } else { security.as_str() };
    let display = if host.contains(':') {
        format!("[{host}]:{port} · {sec_label}/{network}")
    } else {
        format!("{host}:{port} · {sec_label}/{network}")
    };
    Ok(VlessNode { proxy: p, display })
}

/// 构造参数错误。参数：msg——说明；返回：AppError::Invalid。
fn invalid(msg: impl Into<String>) -> AppError {
    AppError::Invalid(format!("vless 链接：{}", msg.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const UUID: &str = "b831381d-6324-4d53-ad4f-8cda48b30811";

    #[test]
    fn 解析_reality_vision() {
        let n = parse(&format!(
            "vless://{UUID}@example.com:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&fp=chrome&pbk=PUBKEY&sid=6ba8&type=tcp#%E8%8A%82%E7%82%B9"
        ))
        .unwrap();
        let p = Value::Object(n.proxy);
        assert_eq!(p["type"], "vless");
        assert_eq!(p["server"], "example.com");
        assert_eq!(p["port"], 443);
        assert_eq!(p["uuid"], UUID);
        assert_eq!(p["tls"], true);
        assert_eq!(p["flow"], "xtls-rprx-vision");
        assert_eq!(p["servername"], "www.microsoft.com");
        assert_eq!(p["reality-opts"]["public-key"], "PUBKEY");
        assert_eq!(p["reality-opts"]["short-id"], "6ba8");
        assert_eq!(p["network"], "tcp");
        assert_eq!(p["xudp"], true);
        assert!(p.get("encryption").is_none(), "encryption=none 不应写入");
        assert_eq!(n.display, "example.com:443 · reality/tcp");
    }

    #[test]
    fn 解析_ws_tls_与早期数据() {
        let n = parse(&format!(
            "vless://{UUID}@1.2.3.4:8443?security=tls&type=ws&path=%2Fray&host=cdn.example.com&ed=2048&allowInsecure=1"
        ))
        .unwrap();
        let p = Value::Object(n.proxy);
        assert_eq!(p["network"], "ws");
        assert_eq!(p["ws-opts"]["path"], "/ray");
        assert_eq!(p["ws-opts"]["headers"]["Host"], "cdn.example.com");
        assert_eq!(p["ws-opts"]["max-early-data"], 2048);
        assert_eq!(p["skip-cert-verify"], true);
        assert_eq!(p["client-fingerprint"], "chrome");
    }

    #[test]
    fn 解析_grpc_与_h2_与_tcp_http_伪装() {
        let g = Value::Object(parse(&format!("vless://{UUID}@h:1?type=grpc&serviceName=svc")).unwrap().proxy);
        assert_eq!(g["grpc-opts"]["grpc-service-name"], "svc");
        let h2 = Value::Object(parse(&format!("vless://{UUID}@h:1?type=http&host=a.com")).unwrap().proxy);
        assert_eq!(h2["network"], "h2");
        assert_eq!(h2["h2-opts"]["host"][0], "a.com");
        let th = Value::Object(parse(&format!("vless://{UUID}@h:1?type=tcp&headerType=http")).unwrap().proxy);
        assert_eq!(th["network"], "http");
        assert_eq!(th["http-opts"]["path"][0], "/");
    }

    #[test]
    fn ipv6_主机去掉方括号() {
        let n = parse(&format!("vless://{UUID}@[2001:db8::1]:443")).unwrap();
        assert_eq!(n.proxy["server"], "2001:db8::1");
        assert_eq!(n.display, "[2001:db8::1]:443 · none/tcp");
    }

    #[test]
    fn 拒绝非法链接() {
        assert!(parse("vmess://abc").is_err());
        assert!(parse("vless://@h:443").is_err(), "缺少 uuid");
        assert!(parse(&format!("vless://{UUID}@h")).is_err(), "缺少端口");
        assert!(parse(&format!("vless://{UUID}@h:443?security=reality")).is_err(), "reality 缺少 pbk");
        assert!(parse(&format!("vless://{UUID}@h:443?security=xtls")).is_err());
        assert!(parse(&format!("vless://{UUID}@h:443?type=kcp")).is_err());
        assert!(parse(&format!("vless://{UUID}@h:443?type=xhttp&extra=%7B%7D")).is_err());
        assert!(parse(&format!("vless://{UUID}@h:443?type=ws&ed=abc")).is_err());
    }
}
