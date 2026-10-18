# 使用宿主机 Git 凭据

在容器侧栏中右键容器，选择 **Git 凭据…**，打开 **使用宿主机 Git 凭据**，填写允许访问的 Git 域名（例如 `gitee.com`），点击 **应用**。当前终端立即生效，无需重启 Claude 或重建容器。默认关闭，每个容器分别设置。

该功能使用宿主 Git 已保存的 HTTPS 登录凭据，支持 Gitee、GitHub、GitLab 及自建 HTTPS Git 服务。宿主机需安装 Git 并事先登录目标服务；检测到凭据管理器只表示已配置认证工具，不代表所有仓库都有访问权限。域名必须完全匹配，可指定端口，不接受通配符、URL 路径或 HTTP。

“同步宿主机的提交姓名和邮箱”是独立选项。它读取宿主机当前全局/系统 Git 的 `user.name` 和 `user.email`，未配置的项保留容器原值；项目内 Git 配置优先。登录凭据和提交署名互不替代。

## 运行方式

- 宿主 Git Credential Manager 等工具保管登录凭据。桥接不会复制 Windows 凭据库，也不会把密码或令牌写进镜像、设置文件、Git remote URL 或日志。
- 容器 helper 经仅当前用户可访问的 Unix socket，把认证请求交给 Docker exec 通道；桌面应用校验允许域名后，在宿主机调用 `git credential fill`。响应只在内存与现有 Docker 连接中传递，不额外开放网络端口。
- 宿主 Git 调用禁止交互式登录，忽略继承的 Git 仓库覆盖参数与调试输出。容器无法指定宿主 helper 命令；`store` 和 `erase` 不会修改宿主凭据管理器。
- 设置以非敏感的域名、开关及容器 ID 保存在应用配置目录的 `git-sharing.json`。只有本机 Docker 引擎与 `tdc.managed=true` 的容器可启用。
- 应用启动或容器恢复运行后，桥接自动重连。使用期间需保持桌面应用运行；退出应用后不再提供认证。重建产生的新容器 ID 需要重新启用，避免同名容器继承授权。
- 关闭开关会撤销宿主转发，移除工具添加的 Git include，保留原有 helper、署名和受信任目录。已停止的容器会清空工具生成的 include 内容，保留一个无作用的 include 路径；恢复运行后再次应用关闭可移除该路径。

SSH 私钥和 SSH agent 不在此功能范围内。宿主凭据的实际权限由 Git 服务决定，桥接不会扩大仓库权限。

## 实现与验证

- 界面：`src/components/modals/GitSharingModal.tsx`。
- IPC：`container_git_get`、`container_git_apply`，返回配置和状态，不返回凭据。
- 宿主桥接：`src-tauri/src/git_bridge/`。
- 容器 helper：`docker/rootfs/opt/tdc/tdc-git-bridge.mjs`，同时登记在应用内置构建上下文与 Docker allowlist。旧镜像可由应用在启用时补入脚本。

运行 `npm run test:git-sharing`、`npm run typecheck`、`cargo test --manifest-path src-tauri/Cargo.toml --lib`。针对已授权的容器和仓库可运行集成检查（临时启用 Gitee 转发，验证只读远程 HEAD、拒绝未允许域名、重连与关闭，最后恢复原配置）：

```powershell
cargo run --manifest-path src-tauri/Cargo.toml --example git-sharing-check -- <容器名> <容器内项目路径>
```

界面可从容器右键菜单的「Git 凭据」打开，验证截图仅在本地保存。
