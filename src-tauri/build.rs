/// 构建脚本：校验公共打包边界，再生成 Tauri 上下文。
fn main() {
    let root =
        std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).parent().unwrap().to_path_buf();
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    for path in [
        "../scripts/check-bundle-privacy.mjs",
        "../src/data",
        "../docker/rootfs",
        "tauri.conf.json",
        "tauri.windows.conf.json",
        "tauri.macos.conf.json",
        "tauri.linux.conf.json",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    if root.join("public").exists() {
        println!("cargo:rerun-if-changed=../public");
    }
    let mut check = std::process::Command::new("node");
    check.arg(root.join("scripts/check-bundle-privacy.mjs")).current_dir(&root);
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        println!("cargo:rerun-if-changed=../dist");
        check.arg("--dist");
    }
    let status = check.status().expect("打包隐私检查需要 Node.js，请安装项目构建前置环境");
    assert!(status.success(), "公共资源检查失败，已阻止将用户配置编入程序");
    tauri_build::build()
}
