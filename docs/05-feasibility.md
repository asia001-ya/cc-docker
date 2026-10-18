# 05 · 可行性结论与 Phase 0 验证清单

## 结论

| 需求 | 结论 | 依据 / 限制 |
|---|---|---|
| 终端占 85–90%+ | ✅ 已实现 | 实测 1920×1080：94.8%；1366×768：92.8%（标题栏 32px + 状态栏 24px，侧栏默认浮层） |
| 24-bit 真彩 | ✅ 已实现（2026-10-17 实测 claude 输出 `38;2;r;g;b`） | xterm WebGL；`COLORTERM=truecolor`；tmux `terminal-features xterm-256color:RGB`；Claude Code 在 tmux 中默认降为 256 色，需 `CLAUDE_CODE_TMUX_TRUECOLOR=1`（应用经 `tmux new-session -e` 注入，镜像 ENV 亦设置） |
| 多 Tab / 分屏 | ✅ 已实现 | Tab 内分屏树，可拖动比例，Alt+方向键切换焦点 |
| 5h / 周额度 | ⚠️ 已实现，有限制 | 只有百分比；仅在 claude 运行时刷新；API 模式无数据 |
| 额度耗尽一键切换 + 继承上下文 | ⚠️ 已实现，有限制 | 继承对话与源码；不继承进程 / 环境 / prompt cache；**跨账号 --resume 待实测** |
| 实时端口 + 点击打开 | ⚠️ 已实现，有限制 | 运行中容器不能新增映射；仅 127.0.0.1 监听不可达 |
| 共享会话卷 | ✅ 已实现 | 变更需重建容器（凭证卷保留） |
| 订阅 / API 切换 | ✅ 已实现 | `claude --settings` + 凭据管理器 |
| 容器内代理（TUN / DNS 防泄露 / 失败即断网） | ✅ 已实现并实测 | 本地 vless 服务端端到端通过（docs/06 第 7 节）；真实互联网 TLS / Reality 节点未测 |

## 风险与需要用户知情的事项

1. **服务条款**：用多个订阅账号轮换来绕开用量上限，可能违反 Anthropic 服务条款，存在封号风险。我无法在此核实具体条款，请自行确认。软件按"用户自有的多个合法账号"实现，不做任何规避检测的处理。
2. **statusline 协议依赖**：`rate_limits` 字段属于 Claude Code 的 statusline 输入，版本升级可能变化；镜像锁定版本。
3. **prompt cache 成本**：切换后首轮请求无缓存，长对话会立即消耗目标账号较多额度。
4. **Windows 盘符挂载**：I/O 慢、inotify 不可靠；建议项目放在 WSL2 文件系统。
5. **代理的代价**：开启后容器名服务发现失效；节点域名经直连 DoH 引导解析；PID 1 改为 root（交互进程仍为 node）。详见 docs/06。

## 本轮已验证

| 项 | 方式 | 结果 |
|---|---|---|
| statusline 解析 / 合并 / 原子写 / 会话映射 | `node --test docker/tests/run-tests.mjs` | 8/8 通过 |
| portwatch `/proc/net/tcp*` 解析（双栈合并、仅环回识别、排除 ESTABLISHED） | 同上（fixture） | 通过 |
| 健康度 / 候选排序 Rust ≡ JS | 共用 `ranking-cases.json` | Rust 5 项 + JS 1 项均通过 |
| 容器创建规格、端口分配、UTF-8 跨帧、限额文案、供应商 env、配置持久化 | `cargo test` | 24/24 通过 |
| Rust 静态检查 | `cargo clippy --all-targets -D warnings` | 通过 |
| 前端类型 / 纯逻辑 | `tsc --noEmit`、`vitest` | 通过；10/10 |
| 前端生产构建 | `vite build` | 通过 |
| 界面（演示模式） | Chrome DevTools：终端面积测量、7 个弹框打开 / 校验 / Esc / Enter / 危险确认 | 通过；验证截图仅在本地保存 |
| shell 语法 | `bash -n` 全部脚本 | 通过 |
| 代理（2026-10-17） | vless 解析 / 配置生成 / 绑定校验 / 能力判断 `cargo test`；状态分类与兜底规则序列 `npm run test:docker`；真实容器端到端 | Rust 41/41、容器侧 11/11（1 项仅 Linux 跳过）、端到端全部通过；详见 docs/06 第 7 节 |

## 尚未验证（Docker 已安装，以下为仍待真机执行的项）

| # | 验证项 | 方法 | 若失败的影响 / 预案 |
|---|---|---|---|
| P0-1 | ✅ 镜像构建与真彩（2026-10-17，Docker 29.8.2） | 镜像 900MB；`TERM=xterm-256color COLORTERM=truecolor`；tmux 3.3a `default-terminal=tmux-256color`、`terminal-features` 含 `xterm-256color:RGB`、prefix=None；portwatch 正确识别 0.0.0.0 与仅 127.0.0.1 监听；宿主 127.0.0.1 端口映射可访问；statusline 真彩输出与 quota/session 文件写入正常；tdc-session 能在 tmux 中拉起 claude 2.1.300 | — |
| P0-2 | 无浏览器容器内订阅登录 | 新建容器 → 终端内登录 | 改用"导入凭证文件"或 `claude setup-token` |
| P0-3 | statusline stdin 含 `rate_limits`（订阅登录 / OAuth token 两种模式） | 运行 claude 一轮后 `docker exec <c> tdc-ctl quota` | 无数据则额度功能仅能依赖限额文案识别 |
| P0-4 | **账号 A 的会话能被账号 B `--resume`** | 共享组内 A 聊几轮 → 切换 → B 中查看历史 | 失败则切换降级为"同目录新开 claude"（代码已支持），文档需改口径 |
| P0-5 | bollard named pipe exec 附着、resize、Channel 推流 | `npm run tauri dev` 打开会话、调整窗口 | 改用 portable-pty + `docker exec -it` |
| P0-6 | tmux 重新附着（关闭应用再打开） | 端到端 | 检查 sessions.json 与 tdc-session |
| P0-7 | ⚠️ `session-stop` 能让 claude 优雅退出 | 首轮测试处于未登录引导界面，`/exit` 无效，回退为 TERM 后成功回落 shell（method=term）。已登录状态下的 `/exit` 待 P0-2 后复测 | 退化为 TERM / KILL，会话文件仍完整 |
| P0-8 | NSIS 打包 | `npm run tauri build` | |
| P0-9 | 代理：真实互联网 TLS / Reality 节点与 MTU | 用真实订阅开启代理，git clone 大仓库 | TLS 卡住时在 render.rs 的 tun 段加 `mtu: 1400` |
| P0-10 | 代理：桌面端 GUI 全流程（ProxyModal、能力重建、告警 toast） | `npm run tauri dev` | 后端命令已用真实 DockerClient 验证；界面待实机点测 |

验证完成后请把结果补回本表。
