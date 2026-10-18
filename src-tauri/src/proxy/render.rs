//! mihomo 配置生成（纯函数）：绑定 + 节点 → config.yaml（JSON 内容）与 intent.json。
//!
//! 设计约束（任何一条改错都会静默失效，测试逐条覆盖）：
//!   - `strict-route` 是连字符；写成下划线 mihomo 不报错但不生效
//!   - 不写任何 GEOIP / GEOSITE 规则：断网状态下启动时下载 geo 数据会死锁
//!   - 不配 inet6 地址、`ipv6: false`：Docker bridge 默认关 IPv6，配了会导致 TUN 建不起来
//!   - 不开 `auto-redirect`：它自己插 iptables/nft 规则，会与兜底链 TDC_GUARD 及 Docker 的 DNAT 冲突
//!   - 节点缺失时拒绝生成：空节点组会"启动成功但一切不通"
//!   - 静态中转只能是显式 proxies 条目：dialer-proxy 不能引用订阅 provider 里的节点
//!   - 出口（socks5）以 dialer-proxy 引用节点组 NODE 而非具体节点：订阅里切换节点后出口仍生效
//!
//! JSON 是 YAML 1.2 的子集，mihomo 用 YAML 解析器可直接读取（已用 v1.19.32 `mihomo -t` 实测）。

use serde_json::{json, Map, Value};

use super::{socks5, vless};
use crate::error::{AppError, AppResult};

/// TUN 设备名（须与容器内 proxy-guard.sh 的 TDC_TUN_DEV 一致）。
pub const TUN_DEVICE: &str = "tdc0";
/// 节点选择组名（容器内 tdc-proxy.sh 的 GROUP 与之一致）。
pub const GROUP_NAME: &str = "NODE";
/// 订阅 provider 名。
pub const PROVIDER_NAME: &str = "sub";
/// 静态中转节点在配置中的名称。
pub const STATIC_NAME: &str = "STATIC";
/// 出口节点在配置中的名称。
pub const EXIT_NAME: &str = "EXIT";
/// 控制器 unix socket（仅 root 可访问）。
pub const CONTROLLER_SOCK: &str = "/var/lib/tdc/proxy/mihomo.sock";
/// 解析节点域名 / 订阅域名的引导 DNS（直连 DoH，IP 形式，避免明文 DNS 与自举死锁）。
pub const BOOTSTRAP_DNS: [&str; 2] = ["https://223.5.5.5/dns-query", "https://1.12.12.12/dns-query"];
/// 解析目标域名的 DNS（respect-rules 下经节点发出）。
pub const REMOTE_DNS: [&str; 2] = ["https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"];
/// 不进入 TUN 的网段：端口映射回包、宿主与局域网（是否允许新建直连由兜底规则决定）。
pub const ROUTE_EXCLUDE: [&str; 4] = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"];
/// 订阅刷新间隔（秒）。
pub const SUBSCRIPTION_INTERVAL: u64 = 86_400;

/// 节点连接内核。Xray 负责出站协议，TUN 与断网保护仍由现有运行时管理。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyEngine {
    #[default]
    Mihomo,
    Xray,
}

/// 节点类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    /// HTTP(S) 订阅链接（mihomo proxy-providers 自行拉取）
    Subscription,
    /// 单条 vless 分享链接
    Vless,
    /// SOCKS5 代理（规范链接 socks5://user:pass@host:port，由前端表单拼接）
    Socks5,
}

/// 渲染所需的节点（含密钥，只在内存中存在）。
#[derive(Debug, Clone)]
pub struct ResolvedNode {
    /// 显示名
    pub name: String,
    /// 类型
    pub kind: NodeKind,
    /// 订阅地址、vless 链接或 socks5 规范链接
    pub secret: String,
}

/// 渲染结果。
#[derive(Debug, Clone, PartialEq)]
pub struct Rendered {
    /// mihomo 配置
    pub config: Value,
    /// 写入容器的期望状态
    pub intent: Value,
}

/// 生成 mihomo 配置与 intent。
/// 参数：node——主节点（必填）；static_node——静态中转（可选，必须是 vless）；
///       exit_node——出口（可选，必须是 socks5）；allow_lan——是否放行宿主与局域网直连；
///       selected——订阅模式下期望选中的节点名；
/// 返回：配置与 intent，或校验错误。
pub fn render(
    node: &ResolvedNode,
    static_node: Option<&ResolvedNode>,
    exit_node: Option<&ResolvedNode>,
    allow_lan: bool,
    selected: Option<&str>,
) -> AppResult<Rendered> {
    render_with_engine(node, static_node, exit_node, allow_lan, selected, ProxyEngine::Mihomo)
}

pub fn render_with_engine(
    node: &ResolvedNode,
    static_node: Option<&ResolvedNode>,
    exit_node: Option<&ResolvedNode>,
    allow_lan: bool,
    selected: Option<&str>,
    engine: ProxyEngine,
) -> AppResult<Rendered> {
    if node.secret.trim().is_empty() {
        return Err(AppError::Invalid(format!("节点「{}」缺少订阅地址或链接", node.name)));
    }
    let mut proxies: Vec<Value> = Vec::new();
    let dialer = match static_node {
        Some(s) => {
            if s.kind != NodeKind::Vless {
                return Err(AppError::Invalid("静态中转只能是单条 vless 节点".into()));
            }
            let mut p = vless::parse(&s.secret)?.proxy;
            p.insert("name".into(), json!(STATIC_NAME));
            proxies.push(Value::Object(p));
            Some(STATIC_NAME)
        }
        None => None,
    };

    let mut providers = Map::new();
    let (group, intent_selected) = match node.kind {
        NodeKind::Vless | NodeKind::Socks5 => {
            let name = node_proxy_name(&node.name);
            let mut p = match node.kind {
                NodeKind::Vless => vless::parse(&node.secret)?.proxy,
                _ => socks5::parse(&node.secret)?.proxy,
            };
            p.insert("name".into(), json!(name));
            if let Some(d) = dialer {
                p.insert("dialer-proxy".into(), json!(d));
            }
            proxies.push(Value::Object(p));
            (json!({ "name": GROUP_NAME, "type": "select", "proxies": [name] }), Some(name))
        }
        NodeKind::Subscription => {
            let url = node.secret.trim();
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err(AppError::Invalid("订阅地址需以 http:// 或 https:// 开头".into()));
            }
            let mut prov = json!({
                "type": "http",
                "url": url,
                "path": format!("./providers/{PROVIDER_NAME}.yaml"),
                "interval": SUBSCRIPTION_INTERVAL,
                "proxy": "DIRECT",
            });
            if let Some(d) = dialer {
                prov["override"] = json!({ "dialer-proxy": d });
            }
            providers.insert(PROVIDER_NAME.into(), prov);
            (
                json!({ "name": GROUP_NAME, "type": "select", "use": [PROVIDER_NAME] }),
                selected.filter(|s| !s.is_empty()).map(str::to_string),
            )
        }
    };

    let exit_rule = match exit_node {
        Some(e) => {
            if e.kind != NodeKind::Socks5 {
                return Err(AppError::Invalid("出口只能是 SOCKS5 节点".into()));
            }
            let mut p = socks5::parse(&e.secret)?.proxy;
            p.insert("name".into(), json!(EXIT_NAME));
            p.insert("dialer-proxy".into(), json!(GROUP_NAME));
            proxies.push(Value::Object(p));
            EXIT_NAME
        }
        None => GROUP_NAME,
    };

    let mut config = json!({
        "mode": "rule",
        "log-level": "warning",
        "ipv6": false,
        "allow-lan": false,
        "find-process-mode": "off",
        "geo-auto-update": false,
        "external-controller-unix": CONTROLLER_SOCK,
        "profile": { "store-selected": true },
        "dns": {
            "enable": true,
            "ipv6": false,
            "enhanced-mode": "fake-ip",
            "fake-ip-range": "198.18.0.1/16",
            "respect-rules": true,
            "default-nameserver": BOOTSTRAP_DNS,
            "proxy-server-nameserver": BOOTSTRAP_DNS,
            "direct-nameserver": BOOTSTRAP_DNS,
            "nameserver": REMOTE_DNS,
        },
        "tun": {
            "enable": true,
            "device": TUN_DEVICE,
            "stack": "mixed",
            "auto-route": true,
            "strict-route": true,
            "auto-detect-interface": true,
            "dns-hijack": ["any:53", "tcp://any:53"],
            "route-exclude-address": ROUTE_EXCLUDE,
        },
        "proxies": proxies,
        "proxy-providers": providers,
        "proxy-groups": [group],
        "rules": [format!("MATCH,{exit_rule}")],
    });
    if engine == ProxyEngine::Xray {
        let source = |n: &ResolvedNode| json!({ "name": n.name, "kind": n.kind, "secret": n.secret });
        config["tdc-xray"] = json!({
            "node": source(node),
            "static": static_node.map(source),
            "exit": exit_node.map(source),
            "bootstrapDns": BOOTSTRAP_DNS,
            "subscriptionInterval": SUBSCRIPTION_INTERVAL,
        });
        // 旧运行时若误读新配置，只能拒绝出站，不能回退直连或尝试不兼容的协议。
        config["proxies"] = json!([]);
        config["proxy-providers"] = json!({});
        config["proxy-groups"] = json!([{ "name": GROUP_NAME, "type": "select", "proxies": ["REJECT"] }]);
        config["rules"] = json!([format!("MATCH,{GROUP_NAME}")]);
        // Xray 与 mihomo 以 root 拨号，避免 Xray 的出站重新进入 TUN 形成循环。
        config["tun"]["exclude-uid"] = json!([0]);
    }
    let intent_selected =
        if engine == ProxyEngine::Xray && node.kind != NodeKind::Subscription { None } else { intent_selected };
    let intent = json!({ "enabled": true, "engine": engine, "allow_lan": allow_lan, "selected": intent_selected });
    Ok(Rendered { config, intent })
}

/// 单条 vless / socks5 主节点在配置中的名称：避开 mihomo 内置名与本模块保留名。
/// 参数：name——用户填写的显示名；返回：配置内名称。
fn node_proxy_name(name: &str) -> String {
    let n = name.trim();
    let reserved = ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE", GROUP_NAME, STATIC_NAME, EXIT_NAME];
    if n.is_empty() || reserved.iter().any(|r| r.eq_ignore_ascii_case(n)) {
        format!("{n} (节点)").trim().to_string()
    } else {
        n.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VLESS_A: &str =
        "vless://b831381d-6324-4d53-ad4f-8cda48b30811@a.example.com:443?security=tls&type=ws&path=%2Fa";
    const VLESS_S: &str =
        "vless://b831381d-6324-4d53-ad4f-8cda48b30811@relay.example.com:8443?security=reality&pbk=K&sid=1";

    #[test]
    fn xray_保留原始订阅和链路且旧内核只会拒绝连接() {
        let node = n("DMIT", NodeKind::Subscription, "https://sub.example.com/api?token=secret");
        let relay = n("中转", NodeKind::Vless, VLESS_S);
        let exit = n("出口", NodeKind::Socks5, "socks5://u:p@exit.test:1080");
        let result =
            render_with_engine(&node, Some(&relay), Some(&exit), false, Some("香港 01"), ProxyEngine::Xray).unwrap();
        assert_eq!(result.intent["engine"], "xray");
        assert_eq!(result.intent["selected"], "香港 01");
        assert_eq!(result.config["tdc-xray"]["node"]["secret"], node.secret);
        assert_eq!(result.config["tdc-xray"]["static"]["secret"], VLESS_S);
        assert_eq!(result.config["tdc-xray"]["exit"]["kind"], "socks5");
        assert_eq!(result.config["proxy-groups"][0]["proxies"], json!(["REJECT"]));
        assert_eq!(result.config["rules"], json!(["MATCH,NODE"]));
        assert_eq!(result.config["tun"]["exclude-uid"], json!([0]));
        assert_eq!(result.config["tun"]["strict-route"], true);
    }

    #[test]
    fn xray_单节点保留pqv且不沿用mihomo节点名() {
        let link = format!("{VLESS_S}&pqv=complete-post-quantum-verification-key#original-name");
        let result =
            render_with_engine(&n("我的节点", NodeKind::Vless, &link), None, None, true, None, ProxyEngine::Xray)
                .unwrap();
        assert_eq!(result.config["tdc-xray"]["node"]["secret"], link);
        assert!(result.intent["selected"].is_null());
        assert_eq!(result.intent["allow_lan"], true);
    }

    /// 构造节点。参数：name——名称；kind——类型；secret——密钥；返回：节点。
    fn n(name: &str, kind: NodeKind, secret: &str) -> ResolvedNode {
        ResolvedNode { name: name.into(), kind, secret: secret.into() }
    }

    #[test]
    fn 订阅节点_无静态() {
        let r =
            render(&n("机场", NodeKind::Subscription, "https://sub.example.com/x?token=t"), None, None, false, None)
                .unwrap();
        let c = &r.config;
        assert_eq!(c["proxy-providers"]["sub"]["url"], "https://sub.example.com/x?token=t");
        assert_eq!(c["proxy-providers"]["sub"]["proxy"], "DIRECT");
        assert!(c["proxy-providers"]["sub"].get("override").is_none(), "无静态时不应出现 override");
        assert_eq!(c["proxy-groups"][0]["use"][0], "sub");
        assert_eq!(c["rules"][0], "MATCH,NODE");
        assert_eq!(c["proxies"].as_array().unwrap().len(), 0);
        assert_eq!(r.intent, json!({ "enabled": true, "engine": "mihomo", "allow_lan": false, "selected": null }));
    }

    #[test]
    fn 订阅节点_带静态与期望节点() {
        let r = render(
            &n("机场", NodeKind::Subscription, "https://sub.example.com/x"),
            Some(&n("中转", NodeKind::Vless, VLESS_S)),
            None,
            true,
            Some("香港 01"),
        )
        .unwrap();
        assert_eq!(r.config["proxy-providers"]["sub"]["override"]["dialer-proxy"], STATIC_NAME);
        assert_eq!(r.config["proxies"][0]["name"], STATIC_NAME);
        assert_eq!(r.config["proxies"][0]["server"], "relay.example.com");
        assert_eq!(r.intent["allow_lan"], true);
        assert_eq!(r.intent["selected"], "香港 01");
    }

    #[test]
    fn vless_节点_带静态时链式() {
        let r =
            render(&n("东京", NodeKind::Vless, VLESS_A), Some(&n("中转", NodeKind::Vless, VLESS_S)), None, false, None)
                .unwrap();
        let proxies = r.config["proxies"].as_array().unwrap();
        assert_eq!(proxies.len(), 2);
        assert_eq!(proxies[1]["name"], "东京");
        assert_eq!(proxies[1]["dialer-proxy"], STATIC_NAME);
        assert_eq!(r.config["proxy-groups"][0]["proxies"][0], "东京");
        assert!(r.config["proxy-providers"].as_object().unwrap().is_empty());
        assert_eq!(r.intent["selected"], "东京");
        let solo = render(&n("东京", NodeKind::Vless, VLESS_A), None, None, false, None).unwrap();
        assert!(solo.config["proxies"][0].get("dialer-proxy").is_none());
    }

    #[test]
    fn tun_与_dns_关键字段() {
        let r = render(&n("东京", NodeKind::Vless, VLESS_A), None, None, false, None).unwrap();
        let tun = r.config["tun"].as_object().unwrap();
        assert_eq!(tun["strict-route"], true);
        assert!(!tun.contains_key("strict_route"));
        assert!(!tun.contains_key("auto-redirect"));
        assert!(!tun.contains_key("inet6-address"));
        assert_eq!(tun["device"], TUN_DEVICE);
        assert_eq!(tun["dns-hijack"], json!(["any:53", "tcp://any:53"]));
        assert_eq!(r.config["ipv6"], false);
        assert_eq!(r.config["dns"]["enhanced-mode"], "fake-ip");
        assert_eq!(r.config["dns"]["respect-rules"], true);
        assert!(!r.config["dns"]["proxy-server-nameserver"].as_array().unwrap().is_empty());
        let text = r.config.to_string().to_ascii_uppercase();
        assert!(!text.contains("GEOIP") && !text.contains("GEOSITE"), "不得出现 GEO 规则");
    }

    #[test]
    fn 拒绝非法组合() {
        assert!(render(&n("空", NodeKind::Vless, " "), None, None, false, None).is_err());
        assert!(render(&n("坏", NodeKind::Subscription, "ftp://x"), None, None, false, None).is_err());
        let sub_static = render(
            &n("东京", NodeKind::Vless, VLESS_A),
            Some(&n("机场", NodeKind::Subscription, "https://x")),
            None,
            false,
            None,
        );
        assert!(sub_static.is_err(), "静态中转不能是订阅");
    }

    #[test]
    fn 节点名避开保留字() {
        assert_eq!(node_proxy_name("DIRECT"), "DIRECT (节点)");
        assert_eq!(node_proxy_name("static"), "static (节点)");
        assert_eq!(node_proxy_name("exit"), "exit (节点)");
        assert_eq!(node_proxy_name(" 东京 "), "东京");
    }

    const SOCKS_EXIT: &str = "socks5://u1:p%40ss@203.0.113.9:1080";

    #[test]
    fn socks5_主节点_带静态() {
        let r = render(
            &n("宿主", NodeKind::Socks5, "socks5://host.docker.internal:10808"),
            Some(&n("中转", NodeKind::Vless, VLESS_S)),
            None,
            false,
            None,
        )
        .unwrap();
        let proxies = r.config["proxies"].as_array().unwrap();
        assert_eq!(proxies.len(), 2);
        assert_eq!(proxies[1]["name"], "宿主");
        assert_eq!(proxies[1]["type"], "socks5");
        assert_eq!(proxies[1]["server"], "host.docker.internal");
        assert_eq!(proxies[1]["dialer-proxy"], STATIC_NAME);
        assert_eq!(r.config["proxy-groups"][0]["proxies"][0], "宿主");
        assert_eq!(r.config["rules"][0], "MATCH,NODE");
        assert_eq!(r.intent["selected"], "宿主");
    }

    #[test]
    fn 出口_订阅节点_经节点组链式() {
        let r = render(
            &n("机场", NodeKind::Subscription, "https://sub.example.com/x"),
            None,
            Some(&n("住宅", NodeKind::Socks5, SOCKS_EXIT)),
            false,
            None,
        )
        .unwrap();
        let exit = &r.config["proxies"][0];
        assert_eq!(exit["name"], EXIT_NAME);
        assert_eq!(exit["type"], "socks5");
        assert_eq!(exit["password"], "p@ss");
        assert_eq!(exit["udp"], false);
        assert_eq!(exit["dialer-proxy"], GROUP_NAME, "出口必须经节点组，切换订阅节点后仍生效");
        assert_eq!(r.config["rules"][0], format!("MATCH,{EXIT_NAME}"));
        assert_eq!(r.config["proxy-groups"][0]["use"][0], "sub");
    }

    #[test]
    fn 出口_与静态中转同时使用() {
        let r = render(
            &n("东京", NodeKind::Vless, VLESS_A),
            Some(&n("中转", NodeKind::Vless, VLESS_S)),
            Some(&n("住宅", NodeKind::Socks5, SOCKS_EXIT)),
            false,
            None,
        )
        .unwrap();
        let names: Vec<&str> =
            r.config["proxies"].as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
        assert_eq!(names, [STATIC_NAME, "东京", EXIT_NAME]);
        assert_eq!(r.config["proxies"][1]["dialer-proxy"], STATIC_NAME);
        assert_eq!(r.config["proxies"][2]["dialer-proxy"], GROUP_NAME);
        assert_eq!(r.config["rules"][0], format!("MATCH,{EXIT_NAME}"));
    }

    #[test]
    fn 出口与静态的类型约束() {
        let bad_exit =
            render(&n("东京", NodeKind::Vless, VLESS_A), None, Some(&n("v", NodeKind::Vless, VLESS_S)), false, None);
        assert!(bad_exit.is_err(), "出口只能是 socks5");
        let bad_static = render(
            &n("东京", NodeKind::Vless, VLESS_A),
            Some(&n("s", NodeKind::Socks5, SOCKS_EXIT)),
            None,
            false,
            None,
        );
        assert!(bad_static.is_err(), "静态中转只能是 vless");
        assert!(render(&n("坏", NodeKind::Socks5, "socks5://h"), None, None, false, None).is_err());
    }
}
