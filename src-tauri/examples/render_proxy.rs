//! 端到端验证辅助：用与桌面端完全相同的渲染逻辑生成 mihomo 配置与 intent，供真机测试注入容器。
//!
//! 用法：
//!   cargo run --example render_proxy -- <输出目录> <节点类型 subscription|vless|socks5> <节点地址>
//!       [--static=<vless 链接>] [--exit=<socks5 链接>] [--allow-lan]
//! 输出：<输出目录>/config.yaml 与 <输出目录>/intent.json

use std::path::PathBuf;

use tdc_lib::proxy::render::{render_with_engine, NodeKind, ProxyEngine, ResolvedNode};

/// 入口。参数：命令行；返回：无（失败时以非零码退出）。
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let allow_lan = args.iter().any(|a| a == "--allow-lan");
    let opt = |key: &str| args.iter().find_map(|a| a.strip_prefix(&format!("--{key}=")).map(str::to_string));
    let pos: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    if pos.len() < 3 {
        eprintln!("用法：render_proxy <输出目录> <subscription|vless|socks5> <节点地址> [--static=<vless 链接>] [--exit=<socks5 链接>] [--allow-lan]");
        std::process::exit(2);
    }
    let kind = match pos[1].as_str() {
        "subscription" => NodeKind::Subscription,
        "vless" => NodeKind::Vless,
        "socks5" => NodeKind::Socks5,
        other => {
            eprintln!("未知节点类型：{other}");
            std::process::exit(2);
        }
    };
    let node = ResolvedNode { name: "主节点".into(), kind, secret: pos[2].clone() };
    let static_node = opt("static").map(|s| ResolvedNode { name: "中转".into(), kind: NodeKind::Vless, secret: s });
    let exit_node = opt("exit").map(|s| ResolvedNode { name: "出口".into(), kind: NodeKind::Socks5, secret: s });
    let engine = if opt("engine").as_deref() == Some("xray") { ProxyEngine::Xray } else { ProxyEngine::Mihomo };
    let out = render_with_engine(&node, static_node.as_ref(), exit_node.as_ref(), allow_lan, None, engine)
        .unwrap_or_else(|e| {
            eprintln!("渲染失败：{e}");
            std::process::exit(1);
        });
    let dir = PathBuf::from(pos[0]);
    std::fs::create_dir_all(&dir).expect("创建输出目录");
    std::fs::write(dir.join("config.yaml"), serde_json::to_vec_pretty(&out.config).unwrap()).expect("写入 config.yaml");
    std::fs::write(dir.join("intent.json"), serde_json::to_vec(&out.intent).unwrap()).expect("写入 intent.json");
    println!("{}", dir.display());
}
