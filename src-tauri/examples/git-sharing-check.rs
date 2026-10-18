//! Explicit integration check: enable for one managed container/repo, read HEAD, then restore.
//! Usage: cargo run --example git-sharing-check -- <container> <container-repo-path>
use tdc_lib::{
    docker::client::DockerClient,
    git_bridge::{GitBridge, Sharing},
};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("Expected container and repository path".into());
    }
    let docker = DockerClient::connect("")?;
    let dir = std::env::temp_dir().join(format!("tdc-git-integration-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir)?;
    let mut bridge = GitBridge::load(&dir)?;
    let view = bridge.view(&docker, &args[1]).await?;
    let original = docker.exec(&view.container_id, &["git", "config", "--global", "--list"], None).await?.stdout;
    let config = Sharing { enabled: true, allowed_hosts: vec!["gitee.com".into()], sync_identity: false };
    let result = async {
        let enabled = bridge.apply(&docker, &args[1], &view.container_id, config.clone()).await?;
        if !enabled.connected { return Err(tdc_lib::error::AppError::Other("Bridge not connected".into())); }
        let run = docker
            .exec(
                &view.container_id,
                &["env", "GIT_TERMINAL_PROMPT=0", "git", "-C", &args[2], "ls-remote", "--exit-code", "origin", "HEAD"],
                None,
            )
            .await?;
        if run.exit_code != Some(0) {
            return Err(tdc_lib::error::AppError::Other("Remote HEAD check failed (output suppressed)".into()));
        }
        println!("PASS: existing container reads remote HEAD with host credentials");
        let denied = docker
            .exec(
                &view.container_id,
                &["node", "-e", r#"const {spawnSync}=require('node:child_process'); const r=spawnSync('node',['/opt/tdc/tdc-git-bridge.mjs','helper','get'],{input:'protocol=https\nhost=unapproved.invalid\n\n',encoding:'utf8'}); process.stdout.write(r.stdout); process.exit(r.status??1);"#],
                None,
            )
            .await?;
        if !denied.stdout.is_empty() || denied.exit_code != Some(0) { return Err(tdc_lib::error::AppError::Other("Host restriction failed".into())); }
        println!("PASS: unapproved host receives no credential");
        bridge = GitBridge::load(&dir)?;
        bridge.reconcile(Some(&docker)).await;
        if !bridge.view(&docker, &args[1]).await?.connected { return Err(tdc_lib::error::AppError::Other("Reconnect failed".into())); }
        let run = docker.exec(&view.container_id,
            &["env", "GIT_TERMINAL_PROMPT=0", "git", "-C", &args[2], "ls-remote", "--exit-code", "origin", "HEAD"], None).await?;
        if run.exit_code != Some(0) { return Err(tdc_lib::error::AppError::Other("Reconnected read failed".into())); }
        println!("PASS: saved switch reconnects and authenticates");
        Ok::<_, tdc_lib::error::AppError>(())
    }
    .await;
    // Always revoke, including failed assertions and network errors.
    bridge.apply(&docker, &args[1], &view.container_id, Sharing::default()).await?;
    result?;
    if docker.exec(&view.container_id, &["git", "config", "--global", "--list"], None).await?.stdout != original {
        return Err("Git configuration was not restored (values suppressed)".into());
    }
    println!("PASS: saved switch reconnects; disable restores the original Git settings");
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}
