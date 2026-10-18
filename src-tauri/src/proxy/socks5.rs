//! SOCKS5 节点：规范链接 `socks5://<user>:<pass>@<host>:<port>` 与 mihomo proxies 条目互转。
//!
//! 前端以分字段表单录入，拼成规范链接后交给后端；凭据管理器中只保存这条链接。
//! 用户名与密码在链接中经过 URL 编码，解析时还原。

use percent_encoding::percent_decode_str;
use serde_json::{json, Map, Value};
use url::Url;

use crate::error::{AppError, AppResult};

/// 解析后的 SOCKS5 节点。
#[derive(Debug, Clone, PartialEq)]
pub struct Socks5Node {
    /// mihomo proxies 条目（不含 name，由渲染时填入）
    pub proxy: Map<String, Value>,
    /// 展示用摘要：host:port，有认证时追加 " · 认证"
    pub display: String,
}

/// 解析 SOCKS5 规范链接。
/// 参数：uri——socks5://[user[:pass]@]host:port；返回：节点或中文错误。
pub fn parse(uri: &str) -> AppResult<Socks5Node> {
    // 错误信息不回显原文：链接里可能带密码
    let url = Url::parse(uri.trim()).map_err(|e| invalid(format!("无法解析：{e}")))?;
    if url.scheme() != "socks5" {
        return Err(invalid(format!("仅支持 socks5://，当前为 {}://", url.scheme())));
    }
    let host = url.host_str().filter(|h| !h.is_empty()).ok_or_else(|| invalid("缺少主机"))?;
    // url 库对 IPv6 主机返回带方括号的形式，mihomo 需要裸地址
    let host = host.trim_start_matches('[').trim_end_matches(']').to_string();
    let port = url.port().filter(|p| *p != 0).ok_or_else(|| invalid("缺少端口或端口为 0"))?;
    if !url.path().is_empty() || url.query().is_some() || url.fragment().is_some() {
        return Err(invalid("链接只能包含主机、端口与认证信息"));
    }
    let username = decode(url.username())?;
    let password = url.password().map(decode).transpose()?.filter(|p| !p.is_empty());
    if username.is_empty() && password.is_some() {
        return Err(invalid("填写了密码时必须填写用户名"));
    }

    let mut p = Map::new();
    p.insert("type".into(), json!("socks5"));
    p.insert("server".into(), json!(host));
    p.insert("port".into(), json!(port));
    if !username.is_empty() {
        p.insert("username".into(), json!(username));
    }
    if let Some(pw) = password {
        p.insert("password".into(), json!(pw));
    }
    // 不转发 UDP：QUIC 会自动回退 TCP，DNS 走 DoH 不受影响；多数 SOCKS5 出口不支持 UDP ASSOCIATE
    p.insert("udp".into(), json!(false));

    let addr = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let display = if username.is_empty() { addr } else { format!("{addr} · 认证") };
    Ok(Socks5Node { proxy: p, display })
}

/// URL 解码用户名或密码。参数：s——编码后的文本；返回：原文。
fn decode(s: &str) -> AppResult<String> {
    percent_decode_str(s).decode_utf8().map(|c| c.into_owned()).map_err(|_| invalid("用户名或密码不是有效的 UTF-8"))
}

/// 构造参数错误。参数：msg——说明；返回：AppError::Invalid。
fn invalid(msg: impl Into<String>) -> AppError {
    AppError::Invalid(format!("SOCKS5 节点：{}", msg.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析_带认证_特殊字符还原() {
        let n = parse("socks5://us%40er:p%40ss%3Aw%2Fd%25@1.2.3.4:1080").unwrap();
        let p = Value::Object(n.proxy);
        assert_eq!(p["type"], "socks5");
        assert_eq!(p["server"], "1.2.3.4");
        assert_eq!(p["port"], 1080);
        assert_eq!(p["username"], "us@er");
        assert_eq!(p["password"], "p@ss:w/d%");
        assert_eq!(p["udp"], false);
        assert_eq!(n.display, "1.2.3.4:1080 · 认证");
    }

    #[test]
    fn 解析_无认证与仅用户名() {
        let n = parse("socks5://host.docker.internal:10808").unwrap();
        assert!(n.proxy.get("username").is_none() && n.proxy.get("password").is_none());
        assert_eq!(n.display, "host.docker.internal:10808");
        let u = parse("socks5://user@h.example.com:1080").unwrap();
        assert_eq!(u.proxy["username"], "user");
        assert!(u.proxy.get("password").is_none());
        assert_eq!(u.display, "h.example.com:1080 · 认证");
    }

    #[test]
    fn 解析_ipv6_主机去掉方括号() {
        let n = parse("socks5://[2001:db8::1]:1080").unwrap();
        assert_eq!(n.proxy["server"], "2001:db8::1");
        assert_eq!(n.display, "[2001:db8::1]:1080");
    }

    #[test]
    fn 首尾空白容忍() {
        assert!(parse("  socks5://h.example.com:1080\n").is_ok());
    }

    #[test]
    fn 拒绝非法链接() {
        assert!(parse("http://h:1080").is_err(), "scheme 必须是 socks5");
        assert!(parse("socks5h://h:1080").is_err(), "规范链接只用 socks5");
        assert!(parse("socks5://h").is_err(), "缺少端口");
        assert!(parse("socks5://h:0").is_err(), "端口不能为 0");
        assert!(parse("socks5://:1080").is_err(), "缺少主机");
        assert!(parse("socks5://:pass@h:1080").is_err(), "有密码必须有用户名");
        assert!(parse("socks5://h:1080/path").is_err(), "不允许路径");
        assert!(parse("socks5://h:1080?x=1").is_err(), "不允许查询串");
        assert!(parse("socks5://h:1080#name").is_err(), "不允许片段");
        assert!(parse("not a url").is_err());
    }

    #[test]
    fn 错误信息不含密码() {
        let e = parse("socks5://user:TOPSECRET@h:1080/x").unwrap_err().to_string();
        assert!(!e.contains("TOPSECRET"), "错误信息泄露了密码：{e}");
    }
}
