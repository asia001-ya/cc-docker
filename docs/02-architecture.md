# 02 · 架构与模块边界

## 总览

```
┌──────────────────────────── Tauri 2 桌面端（Windows · WebView2）──────────────────────────────┐
│ React 19 + TypeScript + Tailwind（DESIGN.md 令牌）+ zustand + xterm.js 6（WebGL/fit/unicode11）│
│   TitleBar │ SplitView→TerminalView(xtermPool) │ StatusBar │ SidebarDrawer │ QuotaFlyout │ 7 Modal│
│      ▲ invoke（命令）   ▲ Channel（终端字节流，有序）   ▲ event（fleet://update 等低频广播）     │
│ Rust：DockerClient(bollard 0.21, npipe) │ SessionManager(exec+Ring+LimitDetector) │ Poller     │
│       ports(分配/链接) │ ProviderStore·ProxyStore(keyring) │ ConfigStore(%APPDATA%\com.tdc.app)│
└──────────────────────────────────────────────┬────────────────────────────────────────────────┘
                                               │ Docker Engine API（npipe:////./pipe/docker_engine）
           ┌───────────────────────────────────┼────────────────────────────────────┐
     claude-dev-01（账号 A）           claude-dev-02（账号 B）             claude-api-03（API）
     tini → entrypoint.sh（root）      同左                                同左
       ├ tdc-proxy.sh restore / daemon（root：mihomo + TUN + 兜底，见 docs/06）
       └ setpriv 降权 → entrypoint-user.sh（node，以下进程均为 node）
       ├ portwatch.sh  → ~/.claude/tdc/state/ports.json（每 3s）
       ├ tmux（tdc-<id>，前缀禁用、状态栏关闭）
       │   └ tdc-session.sh → claude（tdc-claude.sh）→ tdc-claude-real --settings ~/.claude/tdc/provider-settings.json
       │        statusLine（managed-settings 强制）→ statusline.mjs
       │            → ~/.claude/tdc/state/quota.json + sessions/<id>.json（原子写）
       └ tdc-ctl.sh snapshot / session-stop / account（docker exec -u node）；proxy-*（-u root）
     卷：tdc_home_<名> → ~/.claude（独立凭证）
         tdc_shared_projects → ~/.claude/projects（共享会话 JSONL）
         tdc_shared_memory → ~/.claude-shared（CLAUDE.md / skills，entrypoint 链接）
         宿主项目目录 → /workspace/<项目>（各容器路径一致）
```

## 关键设计决策

| 决策 | 选择 | 理由 / 放弃的方案 |
|---|---|---|
| 桌面框架 | Tauri 2（Rust + WebView2） | 包体小、原生 named pipe；Electron 体积大且无收益 |
| 终端链路 | bollard `create_exec(tty)` + `start_exec` 双向流直送 xterm | 不经 ConPTY 二次编码，避免 Windows 控制台对真彩 / 宽字符的转换问题；回退方案：portable-pty 启动 `docker exec -it`（未实现，仅在 exec 方案验证失败时启用） |
| 会话持久化 | 两层：后端持有 exec + 512KB Ring；容器内 tmux | 切 Tab / 刷新 WebView 用 Ring 回放；应用重启 / 崩溃后 `tmux new -A` 重新附着 |
| 额度来源 | Claude Code statusLine stdin 的 `rate_limits` | 唯一官方可得的数据；不调用未公开的 OAuth usage 接口（不稳定、可能违反条款） |
| 额度采集方式 | 状态文件在 home 卷内，桌面端 `docker exec tdc-ctl snapshot` 轮询 | 放弃 Windows 路径 bind mount（权限 / 延迟 / 路径转换问题）；一次 exec 拿全部状态 |
| statusLine 防覆盖 | `/etc/claude-code/managed-settings.json` | 用户在容器内改 settings 不会使采集失效；自定义 statusline 用 `TDC_STATUSLINE_CHAIN` 串联 |
| 订阅 / API 切换 | 容器内 `claude` 包装入口每次添加 `--settings provider-settings.json`（env 块） | 首次会话与退出后手工重启共用配置；不修改用户 settings，不把供应商 env 固化在 shell；订阅模式写空 env |
| 密钥存储 | Windows 凭据管理器（keyring） + tar 流写入容器（600） | 不落明文配置、不出现在命令行参数 / 进程列表 |
| 端口 | 创建时预映射 + 容器内 `/proc/net/tcp*` 检测 | Docker 不能给运行中的容器加映射；动态转发不在 MVP |
| 共享卷变更 | 重建容器（保留 home 卷） | Docker 不能修改已有容器挂载 |
| 前端状态 | zustand；终端输出永不进 React 状态 | xterm 实例池化，Tab 切换不销毁终端 |
| 进程身份 | PID 1 链路以 root 起、降权为 node；所有 exec 显式指定 user | 代理兜底需要 root 施加 iptables；Claude Code 拒绝 root，交互进程必须是 node（详见 docs/06） |
| 容器内代理 | mihomo + TUN + iptables 兜底（失败即断网） | 放弃 HTTP_PROXY 环境变量：只对部分程序生效、无法防 DNS 泄露、创建后不可改 |

## 后端模块（`src-tauri/src/`）

| 模块 | 职责 | 关键函数 |
|---|---|---|
| `docker/client.rs` | 连接、列表、创建 / 启停 / 删除、exec、tar 写文件、事件流 | `connect` `list` `create` `exec` `tdc_ctl` `write_file` `watch_events` |
| `docker/spec.rs` | 表单 → `ContainerCreateBody`（纯函数） | `build_create_body` `validate_name` 卷名规则 |
| `terminal/manager.rs` | exec 会话生命周期、输出泵（12ms / 64KB 聚合）、Channel 推流、退出事件 | `open` `attach` `write` `resize` `close` `build_command` |
| `terminal/ring.rs` | 环形缓冲、UTF-8 跨帧拼接 | `Ring::push/snapshot` `split_utf8` |
| `terminal/detect.rs` | 去 ANSI 后匹配限额文案（跨帧保留尾部） | `LimitDetector::scan` |
| `quota/switch.rs` | 健康度、剩余额度、候选排序（与 tdc-lib.mjs 共用用例） | `health_of` `remaining_of` `rank_candidates` `blocked_until` |
| `quota/poller.rs` | 周期 / 事件触发采集，生成 FleetState，广播耗尽事件（边沿触发） | `poll_once` `run_loop` |
| `ports/mod.rs` | 宿主端口分配（槽位偏移 + 顺延）、监听端口 → 链接 | `allocate` `build_links` |
| `providers/mod.rs` | 供应商 CRUD、Token 存取、生成 provider-settings | `save` `render_settings` `provider_env` |
| `proxy/` | 代理节点库与容器绑定（keyring 存地址）、vless 解析、mihomo 配置生成 | `ProxyStore` `vless::parse` `render::render` |
| `config/store.rs` | settings.json / sessions.json 原子读写 | `ConfigStore` `write_json_atomic` |
| `commands/*` | Tauri 命令薄层 | 见下表 |

### 命令清单

| 命令 | 说明 |
|---|---|
| `engine_info` `fleet_get` `fleet_refresh` | 引擎状态、汇总读取、立即刷新 |
| `container_list` `container_defaults` `container_precheck` `container_create` | 列表、新建默认值（槽位 / 端口）、预检、创建 |
| `container_action`（start/stop/restart/kill） `container_remove`（需 confirm_name） | 生命周期 |
| `container_account` `container_set_provider` `container_import_credentials` | 授权 |
| `shared_group_apply` | 共享组变更（重建容器） |
| `proxy_node_*` `proxy_get` `proxy_apply` `proxy_off` `proxy_nodes` `proxy_select` `proxy_delay` `proxy_refresh` `proxy_capability_apply` | 代理（见 docs/06） |
| `term_open` `term_attach`(Channel) `term_write` `term_paste_image` `term_resize` `term_close` `term_rename` `term_records` `term_list` | 终端（`term_paste_image`：原始字节请求体 + `x-session-id`/`x-mime` 头，把剪贴板图片写入容器 `/tmp` 并返回路径） |
| `switch_candidates` `switch_execute` | 热切换 |
| `settings_get` `settings_set` `docker_test` `provider_*` | 设置与供应商 |
| `debug_inject_quota` | 仅 debug 构建：注入额度快照模拟耗尽 |

### 事件

| 事件 | 载荷 | 触发 |
|---|---|---|
| `fleet://update` | FleetState | 每轮轮询 |
| `quota://exhausted` | {container, blockedUntil, reason} | 容器从未耗尽变为耗尽（边沿） |
| `quota://limit-hit` | {sessionId, container, text} | 终端输出命中限额正则（后端内部消费，转为耗尽判定） |
| `term://exit` | {sessionId, container, code} | exec 结束 |
| `docker://container` | {name, action} | Docker 事件流 |
| `proxy://alert` | {container, state, lastError} | 代理进入 blackhole / leak（边沿） |

## 前端模块（`src/`）

| 路径 | 职责 |
|---|---|
| `api/commands.ts` `api/types.ts` | 命令 / 事件封装与类型（与 Rust serde 对应）；`isTauri()` 判定演示模式 |
| `store/fleetStore.ts` | 容器汇总 |
| `store/tabStore.ts` | Tab、分屏树、会话元数据、退出 / 迁移标记 |
| `store/uiStore.ts` | 侧栏、弹框、浮层、通知、设置、"稍后"暂停 |
| `components/terminal/xtermPool.ts` | xterm 实例池、插件、Channel 附着、尺寸同步、设置热应用、剪贴板（粘贴文本 / 图片、OSC 52） |
| `components/terminal/SplitView.tsx` `TerminalView.tsx` | 分屏递归渲染、可拖分隔条、窗格 |
| `components/shell/*` | 标题栏、状态栏、侧栏、额度浮层、通知、搜索 |
| `components/modals/*` | 7 个弹框 |
| `lib/splitTree.ts` `quota.ts` `validators.ts` `shortcuts.ts` `themes.ts` | 纯逻辑（有单测） |
| `lib/demo.ts` | 浏览器演示数据 |

## 持久化

```
%APPDATA%\com.tdc.app\
├── settings.json    外观 / Docker / 额度 / 快捷键
├── sessions.json    终端会话元数据（id、容器、标题、cwd、模式、参数、env、tmux）
└── providers.json   供应商（不含 Token）+ 容器→供应商绑定
Windows 凭据管理器：服务名 tht-docker-claude，用户名 = 供应商 ID
```
