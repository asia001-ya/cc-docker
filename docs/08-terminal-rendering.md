# Claude 终端重绘异常排查与修复

## 结论（2026-10-18）

在 Claude Code 2.1.300 / tmux 3.3a 下复现：经典界面加载一段较长的中文表格回答，之后已有另一轮简短对话，再改变终端宽高，旧回答的部分章节会重复写入 tmux 历史。原始 Claude JSONL 回答没有重复，因此这是界面重绘与终端历史的交互问题，不是模型重复生成，也不是单纯的 WebGL 残影。

工具此前在 Rust 启动命令和容器会话脚本中都强制 `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`，以提供外层历史滚动条。修复改为默认全屏，并保留用户显式选择经典模式的能力；没有修改 Claude 安装包或删除用户历史。

另查到两个实际会话各残留 17 个 tmux 客户端：桌面外壳重启后，旧 Docker exec 的 tmux 客户端可能继续存活。它们会参与窗口尺寸计算，重复重连还会继续累积。修复后的开发版自动重载时，两边都恢复到 1 个客户端，原 tmux 会话继续保留。

## 修改范围

- 后端新建 Claude 会话注入 `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=0` 和 `CLAUDE_CODE_NO_FLICKER=1`，用户环境变量随后覆盖。已有容器的旧会话脚本同样可接收这些参数。
- 全局 `claude` 包装入口使用相同默认值，会话脚本不再额外强制经典模式。新镜像中的 shell 手工启动也保持一致。
- xterm 在首次附着前测量实际尺寸；连续布局变化等待 120 ms 稳定后适配，分屏拖动期间仍暂停适配。
- 每个终端只发送一个在途尺寸请求，期间只保留最新尺寸；成功后才去重，失败最多自动重试两次，持续失败向用户报告。销毁终端会取消待重试请求。
- Docker `ExecConfig.ConsoleSize` 在创建 PTY 时提供 `[rows, cols]`，替代启动后才调用 resize，避免首屏使用错误尺寸。
- 重连已有 tmux 会话时，后端内嵌脚本使用 `attach-session -d` 替换旧客户端；新镜像的会话脚本使用 `new-session -A -D`。这只断开旧客户端，不终止 Claude 进程；旧镜像也能通过后端脚本获得修复。

跨层核对覆盖：组件 → 适配调度 → 尺寸同步队列 → `term_resize` → Docker PTY，以及启动命令 → 会话脚本 → Claude 包装入口。IPC 请求字段保持一致。全屏时现有 tmux 滚动组件根据 `alternate_screen` 停用外层历史处理，滚轮交给 Claude；普通 shell 的滚动逻辑保留。

## 验证

在 PowerShell 中执行：

```powershell
npm test
npm run test:docker
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run tauri -- build --no-bundle

$env:TDC_TEST_CONTAINER = 'claude-01'
node docker/tests/terminal-rendering-smoke.mjs
cargo test --manifest-path src-tauri/Cargo.toml --lib docker_initial_terminal_size -- --ignored
```

渲染实测使用合成 JSONL、独立配置目录和独立 tmux socket，不向模型提交新提示词，不读取真实对话。测试结束清理自身的临时目录和 tmux server。需要容器已安装 Claude 2.1.300；基线断言针对该版本，未来 Claude 修复经典渲染器后需要调整基线。

宽高依次为 `163×37 → 90×30 → 160×37 → 110×32 → 163×37`。经典界面的测试章节从 1 份变成 3 份；全屏界面仍为 1 份，tmux 历史为 0，`PgUp` 可到达回答开头、`PgDn` 可回到末尾。Docker 独立测试确认第一条 `stty size` 输出即为 `37 163`。

重连实测使用 `script` 创建两个不同尺寸的真实 PTY 客户端，再运行后端的同一份重连脚本；验证最终只剩新客户端，两个旧客户端退出，pane 进程 PID 保持不变。

自动检查结果：前端 97 项通过；Rust 181 项通过、4 项需外部环境的测试默认忽略，其中本次新增的 Docker 初始尺寸测试已单独实测通过；容器脚本 76 项通过、7 项因 Windows 环境限制跳过。生产前端构建与分发隐私检查通过。

## 已有会话

应用更新不会替换 tmux 中正在运行的 Claude 进程。旧会话在当前输出完成后执行 `/tui fullscreen` 即可切换；仅重启桌面应用会重新附着原进程。新的默认模式适用于新启动的 Claude 进程。

全屏历史由 Claude 管理，使用滚轮或 `PgUp` / `PgDn`；外层历史滑块不会显示。若显式选择 `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` 或 `/tui default`，仍可能遇到上游经典界面问题。本次不清除已有的重复 tmux 历史，也不把截断的原始输出缓存升级为完整终端状态快照；WebView 重载时的缓存恢复应独立验证。

计划和实现类 Markdown 文件可通过右上角 [输出内容阅读面板](09-output-reader.md) 独立阅读，无需切回经典模式。
