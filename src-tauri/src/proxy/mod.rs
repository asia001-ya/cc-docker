//! 容器代理：节点库（订阅 / vless / socks5）+ 每容器绑定，生成 mihomo 配置推入容器。
//!
//! - 非敏感信息（名称、类型、摘要、绑定）存 proxies.json
//! - 订阅地址、vless 链接与 socks5 规范链接存 Windows 凭据管理器（键 proxy:<id>），前端只能看到摘要
//! - 推入容器后位于 /var/lib/tdc/proxy（容器层、root 0700），node 进程读不到
//!
//! 容器内的执行与兜底规则见 docker/rootfs/opt/tdc/tdc-proxy.sh、proxy-guard.sh。

pub mod lan;
pub mod render;
pub mod socks5;
pub mod vless;

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::config::store::write_json_atomic;
use crate::error::{AppError, AppResult};
pub use render::{NodeKind, ProxyEngine};
use render::{Rendered, ResolvedNode};

/// 凭据管理器中的服务名（与 providers 共用）。
const KEYRING_SERVICE: &str = "tht-docker-claude";

/// 节点（不含密钥）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyNode {
    /// 唯一 ID（新建时留空）
    #[serde(default)]
    pub id: String,
    /// 显示名
    pub name: String,
    /// 类型
    pub kind: NodeKind,
    /// 连接内核：作为主节点时决定整条链路使用的内核（静态中转与出口跟随主节点）；旧节点默认 mihomo
    #[serde(default)]
    pub engine: ProxyEngine,
    /// 摘要：订阅显示 scheme://host，vless 显示 host:port · 安全层/传输，socks5 显示 host:port[ · 认证]（由后端生成）
    #[serde(default)]
    pub display: String,
}

/// 前端展示视图（附带密钥是否存在）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyNodeView {
    /// 节点
    #[serde(flatten)]
    pub node: ProxyNode,
    /// 凭据管理器中是否存在密钥
    pub has_secret: bool,
}

/// 单个容器的代理绑定（期望状态）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProxyBinding {
    /// 是否启用代理
    pub enabled: bool,
    /// 旧版按容器选择的内核：只读不写，加载时迁移到主节点上（内核已改为节点属性）
    #[serde(rename = "engine", skip_serializing)]
    pub legacy_engine: ProxyEngine,
    /// 主节点 ID（启用时必填）
    pub node_id: Option<String>,
    /// 静态中转节点 ID（可选，必须是 vless）
    pub static_id: Option<String>,
    /// 出口节点 ID（可选，必须是 socks5）：链路为 [静态中转 →] 节点 → 出口 → 目标
    pub exit_id: Option<String>,
    /// 放行宿主与局域网直连（默认禁止）
    pub allow_lan: bool,
    /// 允许直连的私有 IPv4 地址/网段；旧绑定默认保留原来的三个网段。
    pub lan_cidrs: Vec<String>,
    /// 订阅模式下手动选中的节点名
    pub selected: Option<String>,
}

impl Default for ProxyBinding {
    fn default() -> Self {
        Self {
            enabled: false,
            legacy_engine: ProxyEngine::default(),
            node_id: None,
            static_id: None,
            exit_id: None,
            allow_lan: false,
            lan_cidrs: lan::default_cidrs(),
            selected: None,
        }
    }
}

/// 持久化文件结构。
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxiesFile {
    #[serde(default)]
    nodes: Vec<ProxyNode>,
    /// 容器名 → 绑定
    #[serde(default)]
    bindings: HashMap<String, ProxyBinding>,
}

/// 代理存储。
pub struct ProxyStore {
    path: PathBuf,
    data: Mutex<ProxiesFile>,
}

impl ProxyStore {
    /// 从配置目录加载。参数：dir——应用配置目录；返回：存储。
    pub fn load(dir: &std::path::Path) -> Self {
        let path = dir.join("proxies.json");
        let mut data: ProxiesFile =
            fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        migrate_legacy_engine(&mut data);
        Self { path, data: Mutex::new(data) }
    }

    /// 列出节点。参数：无；返回：视图列表。
    pub fn list(&self) -> Vec<ProxyNodeView> {
        self.data
            .lock()
            .nodes
            .iter()
            .map(|n| ProxyNodeView { has_secret: read_secret(&n.id).is_ok(), node: n.clone() })
            .collect()
    }

    /// 新增或更新节点；secret 为 Some 时校验并写入凭据管理器。
    /// 参数：node——节点；secret——订阅地址、vless 链接或 socks5 规范链接（None 或空串表示不修改）；返回：保存后的节点。
    pub fn save(&self, mut node: ProxyNode, secret: Option<String>) -> AppResult<ProxyNode> {
        node.name = node.name.trim().to_string();
        if node.name.is_empty() {
            return Err(AppError::Invalid("节点名称不能为空".into()));
        }
        let secret = secret.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let existing = self.data.lock().nodes.iter().find(|n| n.id == node.id && !node.id.is_empty()).cloned();
        match (&secret, &existing) {
            (None, None) => return Err(AppError::Invalid("新节点必须填写地址".into())),
            (None, Some(old)) if old.kind != node.kind => {
                return Err(AppError::Invalid("修改节点类型时必须重新填写地址".into()));
            }
            (None, Some(old)) => node.display = old.display.clone(),
            (Some(s), _) => node.display = describe(node.kind, s)?,
        }
        if node.id.is_empty() {
            node.id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
        }
        // 先检查引用约束再写凭据，避免类型被拒时密钥已被覆盖
        check_kind_change(&self.data.lock().bindings, &node)?;
        if let Some(s) = secret {
            keyring::Entry::new(KEYRING_SERVICE, &secret_key(&node.id))?.set_password(&s)?;
        }
        let mut g = self.data.lock();
        check_kind_change(&g.bindings, &node)?;
        match g.nodes.iter_mut().find(|n| n.id == node.id) {
            Some(slot) => *slot = node.clone(),
            None => g.nodes.push(node.clone()),
        }
        write_json_atomic(&self.path, &*g)?;
        Ok(node)
    }

    /// 删除节点及其密钥（仍被任一容器引用时拒绝）。参数：id——节点 ID；返回：成功与否。
    pub fn delete(&self, id: &str) -> AppResult<()> {
        let mut g = self.data.lock();
        let users: Vec<&String> = g
            .bindings
            .iter()
            .filter(|(_, b)| [&b.node_id, &b.static_id, &b.exit_id].iter().any(|r| r.as_deref() == Some(id)))
            .map(|(c, _)| c)
            .collect();
        if !users.is_empty() {
            let names: Vec<&str> = users.iter().map(|s| s.as_str()).collect();
            return Err(AppError::Invalid(format!(
                "节点仍被容器使用：{}，请先在这些容器中更换或关闭代理",
                names.join("、")
            )));
        }
        g.nodes.retain(|n| n.id != id);
        write_json_atomic(&self.path, &*g)?;
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &secret_key(id)) {
            let _ = entry.delete_credential();
        }
        Ok(())
    }

    /// 校验并保存容器绑定。参数：container——容器名；binding——绑定；返回：成功与否。
    pub fn bind(&self, container: &str, mut binding: ProxyBinding) -> AppResult<()> {
        let mut g = self.data.lock();
        validate_binding(&g.nodes, &binding)?;
        binding.lan_cidrs = lan::validate(binding.enabled && binding.allow_lan, &binding.lan_cidrs)?;
        g.bindings.insert(container.to_string(), binding);
        write_json_atomic(&self.path, &*g)
    }

    /// 修改绑定中的若干字段（关闭代理、记录选中节点时使用，不做节点必填校验）。
    /// 参数：container——容器名；f——修改函数；返回：成功与否。
    pub fn update_binding(&self, container: &str, f: impl FnOnce(&mut ProxyBinding)) -> AppResult<()> {
        let mut g = self.data.lock();
        f(g.bindings.entry(container.to_string()).or_default());
        write_json_atomic(&self.path, &*g)
    }

    /// 删除容器绑定（容器删除时调用）。参数：container——容器名；返回：成功与否。
    pub fn unbind(&self, container: &str) -> AppResult<()> {
        let mut g = self.data.lock();
        if g.bindings.remove(container).is_some() {
            write_json_atomic(&self.path, &*g)?;
        }
        Ok(())
    }

    /// 查询容器绑定。参数：container——容器名；返回：绑定。
    pub fn binding_of(&self, container: &str) -> Option<ProxyBinding> {
        self.data.lock().bindings.get(container).cloned()
    }

    /// 生成推入容器的配置与 intent（读取凭据管理器中的密钥）。
    /// 参数：binding——绑定（须已启用）；返回：渲染结果。
    pub fn render(&self, binding: &ProxyBinding) -> AppResult<Rendered> {
        let nodes = self.data.lock().nodes.clone();
        validate_binding(&nodes, binding)?;
        let resolve = |id: &str| -> AppResult<ResolvedNode> {
            let n = nodes.iter().find(|n| n.id == id).ok_or_else(|| AppError::NotFound(format!("代理节点 {id}")))?;
            let secret = read_secret(id)
                .map_err(|_| AppError::Credential(format!("节点「{}」的地址未保存，请重新编辑该节点", n.name)))?;
            Ok(ResolvedNode { name: n.name.clone(), kind: n.kind, secret })
        };
        let node_id = binding.node_id.as_deref().ok_or_else(|| AppError::Invalid("开启代理必须选择节点".into()))?;
        let node = resolve(node_id)?;
        let static_node = binding.static_id.as_deref().map(resolve).transpose()?;
        let exit_node = binding.exit_id.as_deref().map(resolve).transpose()?;
        let engine = nodes.iter().find(|n| n.id == node_id).map(|n| n.engine).unwrap_or_default();
        render::render_with_engine(
            &node,
            static_node.as_ref(),
            exit_node.as_ref(),
            binding.allow_lan,
            &binding.lan_cidrs,
            binding.selected.as_deref(),
            engine,
        )
    }
}

/// 把旧版绑定上的 Xray 选择迁移到其主节点（只升级为 Xray，不降级），之后保存时不再写出绑定上的内核。
/// 参数：data——刚加载的持久化数据；返回：无。
fn migrate_legacy_engine(data: &mut ProxiesFile) {
    let xray_nodes: Vec<String> = data
        .bindings
        .values()
        .filter(|b| b.legacy_engine == ProxyEngine::Xray)
        .filter_map(|b| b.node_id.clone())
        .collect();
    for n in data.nodes.iter_mut().filter(|n| xray_nodes.contains(&n.id)) {
        n.engine = ProxyEngine::Xray;
    }
}

/// 校验绑定：启用时节点必填；静态中转必须是 vless、出口必须是 socks5，且都不同于主节点；引用的节点必须存在。
/// 参数：nodes——节点库；b——绑定；返回：校验结果。
pub fn validate_binding(nodes: &[ProxyNode], b: &ProxyBinding) -> AppResult<()> {
    lan::validate(b.enabled && b.allow_lan, &b.lan_cidrs)?;
    let find = |id: &str| nodes.iter().find(|n| n.id == id);
    match b.node_id.as_deref() {
        None if b.enabled => return Err(AppError::Invalid("开启代理必须选择节点".into())),
        Some(id) if find(id).is_none() => return Err(AppError::NotFound(format!("代理节点 {id}"))),
        _ => {}
    }
    if let Some(sid) = b.static_id.as_deref() {
        let s = find(sid).ok_or_else(|| AppError::NotFound(format!("静态中转节点 {sid}")))?;
        if s.kind != NodeKind::Vless {
            return Err(AppError::Invalid("静态中转只能是单条 vless 节点".into()));
        }
        if b.node_id.as_deref() == Some(sid) {
            return Err(AppError::Invalid("静态中转不能与节点相同".into()));
        }
    }
    if let Some(eid) = b.exit_id.as_deref() {
        let e = find(eid).ok_or_else(|| AppError::NotFound(format!("出口节点 {eid}")))?;
        if e.kind != NodeKind::Socks5 {
            return Err(AppError::Invalid("出口只能是 SOCKS5 节点".into()));
        }
        if b.node_id.as_deref() == Some(eid) {
            return Err(AppError::Invalid("出口不能与节点相同".into()));
        }
    }
    Ok(())
}

/// 节点改类型时检查引用约束：正被用作静态中转的只能是 vless，正被用作出口的只能是 socks5。
/// 参数：bindings——全部绑定；node——待保存的节点；返回：校验结果。
fn check_kind_change(bindings: &HashMap<String, ProxyBinding>, node: &ProxyNode) -> AppResult<()> {
    if node.id.is_empty() {
        return Ok(());
    }
    let used =
        |f: fn(&ProxyBinding) -> &Option<String>| bindings.values().any(|b| f(b).as_deref() == Some(node.id.as_str()));
    if node.kind != NodeKind::Vless && used(|b| &b.static_id) {
        return Err(AppError::Invalid("该节点正被用作静态中转，只能是 vless".into()));
    }
    if node.kind != NodeKind::Socks5 && used(|b| &b.exit_id) {
        return Err(AppError::Invalid("该节点正被用作出口，只能是 SOCKS5".into()));
    }
    Ok(())
}

/// 校验密钥并生成摘要。参数：kind——类型；secret——地址或链接；返回：摘要。
pub fn describe(kind: NodeKind, secret: &str) -> AppResult<String> {
    match kind {
        NodeKind::Vless => Ok(vless::parse(secret)?.display),
        NodeKind::Socks5 => Ok(socks5::parse(secret)?.display),
        NodeKind::Subscription => {
            let u = url::Url::parse(secret).map_err(|e| AppError::Invalid(format!("订阅地址无法解析：{e}")))?;
            if u.scheme() != "http" && u.scheme() != "https" {
                return Err(AppError::Invalid("订阅地址需以 http:// 或 https:// 开头".into()));
            }
            let host = u.host_str().ok_or_else(|| AppError::Invalid("订阅地址缺少主机名".into()))?;
            // 路径与查询串里通常带 token，摘要中不显示
            Ok(match u.port() {
                Some(p) => format!("{}://{host}:{p}", u.scheme()),
                None => format!("{}://{host}", u.scheme()),
            })
        }
    }
}

/// 凭据管理器中的键名。参数：id——节点 ID；返回：键名。
fn secret_key(id: &str) -> String {
    format!("proxy:{id}")
}

/// 读取节点密钥。参数：id——节点 ID；返回：密钥。
fn read_secret(id: &str) -> AppResult<String> {
    Ok(keyring::Entry::new(KEYRING_SERVICE, &secret_key(id))?.get_password()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_binding_defaults_persistence_and_validation() {
        let old: ProxyBinding = serde_json::from_str(r#"{"allowLan":true}"#).unwrap();
        assert_eq!(old.lan_cidrs, lan::default_cidrs());
        assert_eq!(ProxyBinding::default().lan_cidrs, old.lan_cidrs);
        let dir = std::env::temp_dir().join(format!("tdc-lan-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let store = ProxyStore::load(&dir);
        store.data.lock().nodes.push(node("n", NodeKind::Socks5));
        let binding = ProxyBinding {
            enabled: true,
            node_id: Some("n".into()),
            allow_lan: true,
            lan_cidrs: vec!["192.168.1.20".into(), "10.20.3.4/16".into()],
            ..Default::default()
        };
        store.bind("test", binding.clone()).unwrap();
        let saved = ProxyStore::load(&dir).binding_of("test").unwrap();
        assert_eq!(saved.lan_cidrs, ["192.168.1.20/32", "10.20.0.0/16"]);
        assert!(store.bind("test", ProxyBinding { lan_cidrs: vec!["0.0.0.0/0".into()], ..binding }).is_err());
        assert_eq!(ProxyStore::load(&dir).binding_of("test").unwrap(), saved);
        let inactive = ProxyBinding { allow_lan: false, lan_cidrs: vec!["0.0.0.0/0".into()], ..saved };
        store.bind("test", inactive.clone()).unwrap();
        assert!(store.bind("test", ProxyBinding { allow_lan: true, ..inactive.clone() }).is_err());
        assert_eq!(ProxyStore::load(&dir).binding_of("test").unwrap(), inactive);
        fs::remove_dir_all(dir).unwrap();
    }

    /// 构造节点。参数：id——ID；kind——类型；返回：节点。
    fn node(id: &str, kind: NodeKind) -> ProxyNode {
        ProxyNode { id: id.into(), name: id.into(), kind, engine: ProxyEngine::Mihomo, display: String::new() }
    }

    #[test]
    fn 旧版绑定上的_xray_迁移到主节点且不再写出() {
        let dir = std::env::temp_dir().join(format!("tdc-proxy-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("proxies.json"), r#"{"nodes":[
            {"id":"sub","name":"DMIT","kind":"subscription","display":"x"},
            {"id":"v1","name":"自建","kind":"vless","display":"y"}],
          "bindings":{"c1":{"enabled":true,"engine":"xray","nodeId":"sub"},"c2":{"enabled":true,"engine":"mihomo","nodeId":"v1"}}}"#).unwrap();
        let store = ProxyStore::load(&dir);
        let engines: HashMap<String, ProxyEngine> =
            store.data.lock().nodes.iter().map(|n| (n.id.clone(), n.engine)).collect();
        assert_eq!(engines["sub"], ProxyEngine::Xray);
        assert_eq!(engines["v1"], ProxyEngine::Mihomo);
        store.update_binding("c1", |b| b.allow_lan = true).unwrap();
        let text = fs::read_to_string(dir.join("proxies.json")).unwrap();
        let saved: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert!(saved["bindings"]["c1"].get("engine").is_none(), "绑定不再写出内核");
        assert_eq!(saved["nodes"][0]["engine"], "xray", "内核持久化到节点");
        assert_eq!(ProxyStore::load(&dir).data.lock().nodes[0].engine, ProxyEngine::Xray, "重新加载后保持");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 绑定校验() {
        let nodes = vec![node("sub", NodeKind::Subscription), node("v1", NodeKind::Vless), node("v2", NodeKind::Vless)];
        let ok = |b: ProxyBinding| validate_binding(&nodes, &b).is_ok();
        assert!(!ok(ProxyBinding { enabled: true, ..Default::default() }), "启用时节点必填");
        assert!(ok(ProxyBinding { enabled: false, ..Default::default() }), "未启用可以不选节点");
        assert!(ok(ProxyBinding { enabled: true, node_id: Some("sub".into()), ..Default::default() }));
        assert!(ok(ProxyBinding {
            enabled: true,
            node_id: Some("sub".into()),
            static_id: Some("v1".into()),
            ..Default::default()
        }));
        assert!(
            !ok(ProxyBinding {
                enabled: true,
                node_id: Some("v1".into()),
                static_id: Some("sub".into()),
                ..Default::default()
            }),
            "静态中转不能是订阅"
        );
        assert!(
            !ok(ProxyBinding {
                enabled: true,
                node_id: Some("v1".into()),
                static_id: Some("v1".into()),
                ..Default::default()
            }),
            "静态不能与节点相同"
        );
        assert!(!ok(ProxyBinding { enabled: true, node_id: Some("ghost".into()), ..Default::default() }));
    }

    #[test]
    fn 出口校验() {
        let nodes = vec![
            node("sub", NodeKind::Subscription),
            node("v1", NodeKind::Vless),
            node("s1", NodeKind::Socks5),
            node("s2", NodeKind::Socks5),
        ];
        let ok = |b: ProxyBinding| validate_binding(&nodes, &b).is_ok();
        let with = |node_id: &str, exit: &str| ProxyBinding {
            enabled: true,
            node_id: Some(node_id.into()),
            exit_id: Some(exit.into()),
            ..Default::default()
        };
        assert!(ok(with("sub", "s1")), "订阅 → socks5 出口");
        assert!(ok(with("s2", "s1")), "socks5 主节点 → socks5 出口");
        assert!(ok(ProxyBinding { static_id: Some("v1".into()), ..with("sub", "s1") }), "中转 + 出口同时使用");
        assert!(!ok(with("sub", "v1")), "出口不能是 vless");
        assert!(!ok(with("v1", "sub")), "出口不能是订阅");
        assert!(!ok(with("s1", "s1")), "出口不能与节点相同");
        assert!(!ok(with("sub", "ghost")), "出口节点必须存在");
        assert!(
            ok(ProxyBinding { enabled: true, node_id: Some("s1".into()), ..Default::default() }),
            "socks5 可作主节点"
        );
        assert!(
            !ok(ProxyBinding {
                enabled: true,
                node_id: Some("sub".into()),
                static_id: Some("s1".into()),
                ..Default::default()
            }),
            "socks5 不能作静态中转"
        );
    }

    #[test]
    fn 被引用的节点改类型受限() {
        let mut bindings = HashMap::new();
        bindings.insert(
            "c1".to_string(),
            ProxyBinding {
                node_id: Some("sub".into()),
                static_id: Some("v1".into()),
                exit_id: Some("s1".into()),
                ..Default::default()
            },
        );
        assert!(check_kind_change(&bindings, &node("s1", NodeKind::Vless)).is_err(), "出口不能改成 vless");
        assert!(check_kind_change(&bindings, &node("s1", NodeKind::Socks5)).is_ok());
        assert!(check_kind_change(&bindings, &node("v1", NodeKind::Socks5)).is_err(), "静态中转不能改成 socks5");
        assert!(check_kind_change(&bindings, &node("sub", NodeKind::Socks5)).is_ok(), "主节点可以改成任意类型");
        assert!(check_kind_change(&bindings, &node("", NodeKind::Subscription)).is_ok(), "新节点不受限");
    }

    #[test]
    fn 旧版绑定文件缺少出口字段时兼容() {
        let b: ProxyBinding =
            serde_json::from_str(r#"{"enabled":true,"nodeId":"a","staticId":null,"allowLan":false,"selected":null}"#)
                .unwrap();
        assert_eq!(b.exit_id, None);
        assert_eq!(b.legacy_engine, ProxyEngine::Mihomo);
        assert_eq!(b.node_id.as_deref(), Some("a"));
    }

    #[test]
    fn socks5_摘要不含认证信息() {
        let d = describe(NodeKind::Socks5, "socks5://user:TOPSECRET@1.2.3.4:1080").unwrap();
        assert_eq!(d, "1.2.3.4:1080 · 认证");
        assert!(describe(NodeKind::Socks5, "socks5://1.2.3.4").is_err());
    }

    #[test]
    fn 订阅摘要不含路径与查询() {
        assert_eq!(
            describe(NodeKind::Subscription, "https://sub.example.com/api/v1/client?token=secret").unwrap(),
            "https://sub.example.com"
        );
        assert_eq!(describe(NodeKind::Subscription, "http://1.2.3.4:8080/s").unwrap(), "http://1.2.3.4:8080");
        assert!(describe(NodeKind::Subscription, "ftp://x").is_err());
        assert!(describe(NodeKind::Subscription, "not a url").is_err());
    }

    #[test]
    fn 被引用的节点不能删除_绑定持久化() {
        let dir = std::env::temp_dir().join(format!("tdc-proxy-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let store = ProxyStore::load(&dir);
        // 直接写入节点（绕过凭据管理器，测试环境不一定可用）
        store.data.lock().nodes.push(node("v1", NodeKind::Vless));
        store.data.lock().nodes.push(node("s1", NodeKind::Socks5));
        store
            .bind(
                "c1",
                ProxyBinding {
                    enabled: true,
                    node_id: Some("v1".into()),
                    exit_id: Some("s1".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(store.delete("v1").is_err());
        assert!(store.delete("s1").is_err(), "被用作出口的节点不能删除");
        store.update_binding("c1", |b| b.enabled = false).unwrap();
        let reloaded = ProxyStore::load(&dir);
        let b = reloaded.binding_of("c1").unwrap();
        assert!(!b.enabled);
        assert_eq!(b.node_id.as_deref(), Some("v1"));
        reloaded.unbind("c1").unwrap();
        assert!(reloaded.binding_of("c1").is_none());
        reloaded.delete("v1").unwrap();
        reloaded.delete("s1").unwrap();
        assert!(reloaded.list().is_empty());
    }
}
