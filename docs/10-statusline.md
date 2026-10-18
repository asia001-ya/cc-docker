# Claude 输入栏下方的状态信息

模型与上下文信息由工具的 `/opt/tdc/statusline.mjs` 生成，通过 Claude 的 `statusLine` 显示。`plan mode on`、`bypass permissions on` 和快捷键提示属于 Claude 内置 footer。

状态栏依次显示模型、思考级别、上下文容量、Git 分支、末级目录名和上下文占用。空间足够时只占一行，只有放不下时按完整字段换行。

- 模型使用 `model.display_name`，缺失时使用模型 ID；青色底标突出当前模型。
- 思考级别使用实时 `effort.level`，直接显示 `high`、`xhigh` 等值，不加“思考”前缀。`thinking.enabled=false` 时显示“关闭”；未提供级别时不猜测默认值。
- 容量读取 `context_window.context_window_size`，1000000 显示 `1M`、200000 显示 `200K`。
- Git 在当前目录只读查询分支，兼容 worktree、未提交仓库和 detached HEAD；非 Git 仓库显示 `—`。单次命令最多 300ms，五秒内复用同一目录结果。
- 目录从 `workspace.current_dir`（回退 `cwd`）提取最后一层文件夹名，以橙色 `#FFA657` 直接显示。兼容两种路径分隔符和末尾分隔符；原始目录仍保留在会话快照中，供 Git 查询等功能使用。
- 占用读取 `context_window.used_percentage`，显示为 `ctx [进度条] 百分比`。尚无数据时显示暗色刻度和 `—`，不显示成 `0%`。百分比来自最后一次 API 响应，与 `/context` 的即时估算可能不同。

不显示会话名，也不显示“思考”“目录”“会话”标签。会话标题仍可由采集脚本保存，供其他功能使用。

## 上下文颜色和尺寸

进度条填充和百分比使用同一颜色，按未经取整的实际占用判断：

| 占用 | 颜色 |
| --- | --- |
| 0%–20%（含 20%） | 绿色 `#16C55D` |
| >20%–50%（含 50%） | 橙色 `#FFA657` |
| >50%–70%（含 70%） | 紫色 `#A78BFA` |
| >70% | 红色 `#F85149` |

方括号为灰色，空余部分使用暗色反斜杠斜纹。填充使用居中的 `■`，避免下部块字符 `▅` 向下偏移，相较早期 `▇` 保持约三分之一的高度缩减；终端字符的离散高度无法精确到任意像素。只改变填充字符，不增加行距或使用整格背景色。

刻度宽度在上一版按可用列数计算的长度上减半，取最近整数，至少保留一格；宽窗最多 16 格，窄窗同步缩短。百分比文字和方括号字号保持不变。

长值按终端显示列截断，并过滤控制序列；列宽计算保留空格，兼顾中文和 emoji。状态栏每五秒刷新，也响应 Claude 原有更新事件。额度信息继续写入 `quota.json`，供桌面底部额度栏使用；用户配置 `TDC_STATUSLINE_CHAIN` 时，仍优先展示自定义输出。

视觉方案来自 Stitch 状态栏设计，详见 [设计落地记录](designs/statusline-stitch.md)。

## 更新与验证

新脚本及依赖登记在应用内置镜像上下文与 `docker/.dockerignore`。已有容器可在不重启 Claude 的情况下更新：

```powershell
node scripts/update-statusline.mjs claude-01 claude-02
```

更新器仅处理显式指定且带 `tdc.managed=true` 标签的运行容器；遇到自定义 statusLine 命令会停止。旧文件保存在容器 `/opt/tdc/.statusline-backups/`，脚本原子替换，managed settings 设置五秒刷新间隔。无活跃 Claude 的容器会在下一次启动 Claude 时显示新状态栏。

针对状态栏运行 `npm run test:statusline` 和 `node --test docker/tests/run-tests.mjs`。开发地址 `/tests/statusline.html` 提供共用实际渲染函数的 xterm 示例，可切换四档占用、未知值、200K 容量及终端列宽。桌面程序使用 `npm run tauri -- build --no-bundle` 构建。

字段依据：[Claude Code statusline 官方说明](https://code.claude.com/docs/en/statusline#available-data)。

状态栏效果可通过 `/tests/statusline.html` 预览，验证截图仅在本地保存。
