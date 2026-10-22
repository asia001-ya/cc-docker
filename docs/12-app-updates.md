# 12 · 应用更新

桌面端从 [GitHub Releases](https://github.com/asia001-ya/cc-docker/releases) 获取已经编译好的 Windows x64 稳定版。更新不需要安装 Git、Node.js、Rust 或编译器。

## 使用更新

“设置 → 应用更新”显示当前版本、最新版本、检查时间与下载进度，也可手动检查更新、下载和安装。

默认在应用启动后检查一次，此后每六小时检查一次。有更新时自动下载并校验，正常退出应用时安装；也可点击“更新并重启”立即使用新版。设置中可以关闭自动检查、自动下载或退出时安装。下载或校验失败会显示原因，可再次检查或下载。

- 安装版使用新的 NSIS 安装包更新现有安装目录。
- 独立运行版在退出后替换原程序文件；替换失败时恢复原文件。“更新并重启”完成后会重新打开原路径。
- 退出时安装完成后保持退出，下次启动使用新版。

更新只替换桌面程序，保留用户应用数据目录中的配置、供应商和代理设置、授权凭据、会话记录与用量。Docker 容器、数据卷、镜像和容器内进程继续运行；重启桌面端后可重新附着已有 tmux 会话。容器镜像或 Claude Code 的版本更新仍按各自的构建流程操作。

只接受比当前版本更新的稳定版本，忽略草稿、预发布和旧版本。下载文件必须来自本仓库的 HTTPS Release 附件，并与 GitHub API 提供的 SHA256 摘要和文件大小一致。摘要缺失、文件不完整或校验不一致时不会安装。SHA256 用于验证下载文件，与发布者签名属于不同机制。

## 生成和发布更新包

发布前将 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 和 `src-tauri/Cargo.lock` 中本项目的版本统一为稳定版本，例如 `1.0.3`。构建和打包：

```powershell
npm ci
npm run tauri build
npm run release:package
```

正式构建会执行公共资源和生产资源隐私检查。打包脚本只复制桌面程序与 NSIS 安装包，并生成校验清单，不会上传或发布文件。它会检查版本一致性和构建输出；存在同名输出目录时会停止，以免混入旧附件。如需重新打包，选择新的空目录：

```powershell
npm run release:package -- --output D:/releases/cc-docker-1.0.3
```

默认目录为 `src-tauri/target/release/release-assets/v1.0.3/`，包含：

```text
cc-docker-1.0.3-windows-x64.exe
cc-docker-1.0.3-windows-x64-setup.exe
SHA256SUMS.txt
```

在本仓库创建标签 `v1.0.3` 的 GitHub Release，上传以上三个文件并发布为稳定版本。只推送 Git 提交或标签不会触发客户端安装；必须发布 Release 并附上对应程序。版本号和附件文件名必须一致。安装版选择 `cc-docker-{版本}-windows-x64-setup.exe`，独立运行版选择 `cc-docker-{版本}-windows-x64.exe`。

GitHub 上传附件后会为文件计算摘要。自动安装要求附件 API 元数据具有 `digest: "sha256:…"`；`SHA256SUMS.txt` 方便人工核验，不能替代 API 摘要。发布后可检查：

```powershell
$release = Invoke-RestMethod https://api.github.com/repos/asia001-ya/cc-docker/releases/latest
$release.assets | Select-Object name, size, digest
```

从上一稳定版本分别验证安装版和独立运行版：检查发现新版本、下载校验、正常退出安装、手动安装并重启，以及容器和已有会话的重新附着。发布前还应验证离线、缺少附件、摘要缺失、损坏下载、无目录写入权限和重复点击时，原程序仍能继续使用。
