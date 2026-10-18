//! 宿主端口分配与端口链接生成。
//!
//! 规则：默认宿主端口 = 容器端口 + 10 × 槽位号；被占用（系统已监听或其他 tdc 容器已映射）时 +1 顺延。

use std::collections::HashSet;
use std::net::TcpListener;

use serde::Serialize;

use crate::quota::model::ListenPort;

/// 判断宿主机 127.0.0.1 上的端口是否空闲。
/// 参数：port——端口；返回：空闲返回 true。
pub fn host_port_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// 为一组容器端口分配宿主端口。
/// 参数：
///   - `container_ports`：容器内端口列表；
///   - `slot`：槽位号（1 起）；
///   - `reserved`：已被其他 tdc 容器占用的宿主端口；
///   - `is_free`：系统端口空闲探测函数（测试中可替换）。
///
/// 返回：(容器端口, 宿主端口) 列表，与输入顺序一致。
pub fn allocate<F: Fn(u16) -> bool>(
    container_ports: &[u16],
    slot: u16,
    reserved: &HashSet<u16>,
    is_free: F,
) -> Vec<(u16, u16)> {
    let mut taken: HashSet<u16> = reserved.clone();
    container_ports
        .iter()
        .map(|&cp| {
            let mut hp = cp.saturating_add(slot.saturating_mul(10)).max(1024);
            while taken.contains(&hp) || !is_free(hp) {
                hp = if hp == u16::MAX { 1024 } else { hp + 1 };
            }
            taken.insert(hp);
            (cp, hp)
        })
        .collect()
}

/// 状态栏展示用的端口链接。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortLink {
    /// 容器内端口
    pub container_port: u16,
    /// 宿主端口（未映射时为 None）
    pub host_port: Option<u16>,
    /// 可点击 URL（未映射或仅环回绑定时为 None）
    pub url: Option<String>,
    /// 进程名
    pub process: Option<String>,
    /// 不可访问的原因（中文提示）
    pub hint: Option<String>,
}

/// 合并"容器内监听端口"与"Docker 端口映射"生成链接。
/// 参数：listening——ports.json 中的监听端口；mappings——(容器端口, 宿主端口)；返回：按容器端口排序的链接。
pub fn build_links(listening: &[ListenPort], mappings: &[(u16, u16)]) -> Vec<PortLink> {
    let mut out: Vec<PortLink> = listening
        .iter()
        .map(|lp| {
            let host = mappings.iter().find(|(c, _)| *c == lp.port).map(|(_, h)| *h);
            let (url, hint) = match (host, lp.loopback_only) {
                (None, _) => (None, Some("未映射到宿主机：创建容器时需预先映射该端口".to_string())),
                (Some(_), true) => {
                    (None, Some("服务仅监听 127.0.0.1，宿主机无法访问；请以 --host 0.0.0.0 启动".to_string()))
                }
                (Some(h), false) => (Some(format!("http://localhost:{h}")), None),
            };
            PortLink { container_port: lp.port, host_port: host, url, process: lp.process.clone(), hint }
        })
        .collect();
    out.sort_by_key(|l| l.container_port);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 按槽位偏移分配并在冲突时顺延() {
        let reserved: HashSet<u16> = [3010].into_iter().collect();
        let busy = |p: u16| p != 5183;
        let got = allocate(&[3000, 5173, 8080], 1, &reserved, busy);
        assert_eq!(got, vec![(3000, 3011), (5173, 5184), (8080, 8090)]);
    }

    #[test]
    fn 同批端口不会互相冲突() {
        let got = allocate(&[3000, 3001], 0, &HashSet::new(), |_| true);
        assert_eq!(got, vec![(3000, 3000), (3001, 3001)]);
        let got = allocate(&[80], 0, &HashSet::new(), |_| true);
        assert_eq!(got, vec![(80, 1024)], "特权端口应抬升到 1024 以上");
    }

    #[test]
    fn 生成链接并识别不可访问场景() {
        let listening = vec![
            ListenPort {
                port: 5173,
                binds: vec!["127.0.0.1".into()],
                loopback_only: true,
                process: Some("node".into()),
            },
            ListenPort {
                port: 3000,
                binds: vec!["0.0.0.0".into()],
                loopback_only: false,
                process: Some("node".into()),
            },
            ListenPort { port: 9229, binds: vec!["0.0.0.0".into()], loopback_only: false, process: None },
        ];
        let links = build_links(&listening, &[(3000, 3010), (5173, 5183)]);
        assert_eq!(links[0].url.as_deref(), Some("http://localhost:3010"));
        assert!(links[1].hint.as_deref().unwrap().contains("0.0.0.0"));
        assert!(links[2].url.is_none() && links[2].hint.as_deref().unwrap().contains("未映射"));
    }
}
