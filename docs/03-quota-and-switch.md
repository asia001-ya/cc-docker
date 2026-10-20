# 03 · 额度采集协议与热切换逻辑

> 交付物 4。实现：容器侧 `docker/rootfs/opt/tdc/{statusline.mjs,tdc-quota.mjs,tdc-ctl.sh,tdc-lib.mjs}`，
> 桌面端 `src-tauri/src/quota/`、`src-tauri/src/commands/term_cmds.rs::switch_execute`，
> 命令行版 `docker/scripts/{tdc-quota.sh,tdc-switch.sh}`。

## 1. 数据来源与限制

Claude Code 每次刷新底栏时，把一段 JSON 通过 stdin 传给 `statusLine.command`。其中与额度相关的字段（已在本机 claude-hud 0.11.1 源码 `src/types.ts` / `src/stdin.ts` 中确认）：

```jsonc
{
  "session_id": "7d1f3c2a-…",              // --resume 用
  "cwd": "/workspace/app",
  "workspace": { "current_dir": "/workspace/app/src" },
  "model": { "id": "claude-opus-5-5", "display_name": "Opus 5.5" },
  "context_window": { "used_percentage": 12.3 },
  "rate_limits": {
    "five_hour": { "used_percentage": 15.25, "resets_at": 1792130400 },  // 0~100，epoch 秒
    "seven_day": { "used_percentage": 40,    "resets_at": 1792562400 }
  }
}
```

**限制（必须让用户知道）：**
1. 只有**百分比**，没有 token 绝对值。
2. 自动采集随 Claude statusline 更新；空闲容器显示“上次已知值 + 新鲜度”。运行中的授权容器还可在额度总览点击“刷新账号额度”，直接查询账号用量，无需发送对话。`resets_at` 已过则推断为已恢复（UI 以 `*` 标注），需新数据确认。
3. API 模式没有 `rate_limits`。
4. 字段属于 Claude Code 的 statusline 协议，未来版本可能变化；镜像锁定 Claude Code 版本（`CLAUDE_CODE_VERSION`）以降低风险。Phase 0 需在真实容器中验证该字段在订阅登录与 `CLAUDE_CODE_OAUTH_TOKEN` 两种模式下都存在。

## 2. 容器内状态文件（协议 1）

位于 `$TDC_STATE_DIR = /home/node/.claude/tdc/state`（home 卷内），均为原子写（tmp + rename）。

### quota.json（账号级，同容器所有会话共享）
```json
{
  "protocol": 1,
  "updated_at": 1792120000,
  "rate_limits_updated_at": 1792120000,
  "container": "claude-dev-01",
  "auth_hint": "subscription",
  "five_hour": { "used_percentage": 15.3, "resets_at": 1792130400 },
  "seven_day": { "used_percentage": 40, "resets_at": 1792562400 },
  "model": { "id": "claude-opus-5-5", "display_name": "Opus 5.5" },
  "claude_version": "2.1.300",
  "last_session": { "session_id": "7d1f…", "tdc_session_id": "a1b2c3d4", "cwd": "/workspace/app/src" }
}
```
合并规则由 `tdc-quota.mjs` 统一实现：

- 限额属于账号，同一容器的多个会话共用，不能相加。同一重置周期保留已用百分比的最大值，避免空闲会话的旧缓存覆盖最新值。
- 忽略更早重置周期的数据；出现更新周期时允许用量下降。缺少某窗口时保留旧值，缺少重置时间的缓存不能建立新周期。
- `rate_limits_updated_at` 只在额度实际变化或主动查询成功时更新，重复的 statusline 缓存不会伪装为新数据。`updated_at` 仍记录最近活动。
- 读、合并、写操作使用跨进程目录锁，配合原子替换，避免多个会话同时写文件时丢失窗口数据。

额度总览的刷新按钮调用 `container_quota_refresh`，容器内通过官方 OAuth usage 接口读取 5 小时和周窗口。令牌只在容器内读取并通过 curl 标准输入传入；错误不输出令牌或服务响应正文。成功查询覆盖旧缓存，并同步卡片摘要、健康度和限额提示；查询失败保留原额度并显示原因。API 容器不提供此按钮，停止的容器需先启动。

新版桌面端在首次轮询已有标准容器时更新配套采集脚本，不重启容器或 Claude 会话；自定义镜像继续使用自己的采集器。镜像构建上下文也包含这些脚本。

底部状态栏的 5 小时和周额度采用 10 格进度条，每格宽 5px、高 6px，间隔 1px。填充与空余斜纹使用同一尺寸，垂直居中显示，避免方块字符与阴影字符的字形高度差异。

### sessions/<tdc_session_id>.json（会话级）
```json
{ "protocol": 1, "updated_at": 1792120000, "tdc_session_id": "a1b2c3d4",
  "session_id": "7d1f…", "transcript_path": "…/7d1f….jsonl", "cwd": "/workspace/app/src",
  "model": {…}, "context_used_percentage": 12.3, "cost_usd": 0.42 }
```
`tdc_session_id` 由桌面端通过 `TDC_SESSION_ID` 环境变量注入，建立"桌面终端会话 ↔ Claude 会话"映射，这是热切换能 `--resume` 的关键。

### ports.json
```json
{ "protocol": 1, "updated_at": 1792120000,
  "ports": [ { "port": 3000, "binds": ["0.0.0.0","::"], "family": "dual", "loopback_only": false, "pid": 812, "process": "node" } ] }
```

### `tdc-ctl snapshot`（桌面端每轮一次 exec）
```json
{ "protocol": 1, "now": …, "meta": {…}, "quota": {…}, "ports": {…},
  "provider": { "mode": "subscription|api", "base_url": null, "model": null },
  "account": { "logged_in": true, "email": "…", "organization_type": "claude_max", "rate_limit_tier": "…" },
  "sessions": [ … ], "tmux": [ { "id": "a1b2c3d4", "created_at": …, "attached": 1, "cwd": "…", "command": "node" } ] }
```
`account` 只读取 `.claude.json` 的 `oauthAccount` 非敏感字段，**从不输出令牌**。

## 3. 健康度算法（`quota/switch.rs` ≡ `tdc-lib.mjs`）

```
effective_used(win) = (now ≥ win.resets_at) ? 0（推断）: win.used_percentage
remaining           = 100 − max(effective_used(5h), effective_used(7d))   // 两窗口都无数据 → 未知

health =
  stopped    若容器未运行
  api        若 provider.mode == api
  exhausted  若终端检测到限额文案 或 任一窗口 effective_used ≥ switch_threshold(默认 100)
  unknown    若 remaining 未知
  healthy    若 remaining > warn_threshold(30)
  warning    若 remaining ≥ critical_threshold(5)
  exhausted  否则
blocked_until = 所有达到阈值窗口中最晚的 resets_at
```

## 4. 候选排序

```
排除：源容器
tier 1  运行中 · 订阅 · 未耗尽 · 剩余已知且 > 0
tier 2  运行中 · 订阅 · 剩余未知
tier 3  已停止 · 订阅                     （仅 include_stopped）
tier 4  运行中 · API                      （仅 allow_api_fallback，会产生费用）
排序：tier ↑ → remaining ↓ → 5h resets_at ↑（早重置者优先）→ 名称
```
用例 `docker/tests/fixtures/ranking-cases.json` 同时被 Rust（`cargo test`）和 Node（`node --test`）测试，保证 CLI 与桌面端结论一致。

## 5. 触发

```mermaid
sequenceDiagram
    participant C as 容器 claude
    participant S as statusline.mjs
    participant P as Poller(Rust)
    participant T as SessionManager(Rust)
    participant UI as 前端
    C->>S: stdin JSON（含 rate_limits）
    S->>S: 写 quota.json / sessions/<id>.json
    loop 每 refresh_secs 或 Docker 事件 / 限额命中
        P->>C: docker exec tdc-ctl snapshot
        P->>P: health_of(...)，与上一轮比较
        P-->>UI: fleet://update
        alt 从未耗尽 → 耗尽（边沿）
            P-->>UI: quota://exhausted
        end
    end
    C-->>T: 终端输出 "…5-hour limit reached…"
    T->>T: LimitDetector 命中
    T->>P: quota://limit-hit → limit_hits[容器]=now，立即唤醒
    UI->>UI: autoPrompt && 未"稍后" && 有候选 → 弹框 4
```

辅助信号只识别明确达到上限的文案（例如 `You've hit your limit`、`5-hour limit reached`）。接近上限的预警、单独的 `weekly limit` / `5-hour limit` 和重置时间说明不会触发耗尽；状态点继续按实际额度阈值显示。升级时自动替换旧版默认识别规则，用户自定义或禁用的规则保持原样。限额文案命中后，在额度数据比命中时间新 60 秒以上时自动清除。

## 6. 热切换执行（`switch_execute`）

```mermaid
sequenceDiagram
    participant UI
    participant R as Rust
    participant A as 源容器
    participant B as 目标容器
    UI->>R: switch_execute(sessionId, target, cols, rows)
    R->>A: 检查源容器运行状态与 session-info（读取 cwd / 已知 Claude session_id）
    R->>B: 同步已绑定的供应商配置；未运行则按完整配置流程启动
    R->>B: test -d <cwd>            （不存在 → 报错，源会话仍保持运行）
    R->>B: 已知 session_id 时先检查 projects/*/<session_id>.jsonl
    R->>A: tdc-ctl session-stop <id> 5
    A->>A: tmux send-keys Esc, "/exit", Enter → 等待 5s → TERM → 2s → KILL
    A-->>R: {method, session_id, cwd}
    R->>B: 新 session_id 时再次检查 projects/*/<session_id>.jsonl
    R->>B: 历史不存在 → 降级：新开 claude，提示未继承
    R->>B: term_open: tdc-session <新id> <cwd> claude --resume <session_id>
    R-->>UI: {session, resumed, stopMethod, notes}
    UI->>UI: 分屏树中原位替换窗格，旧终端销毁，Toast 提示
```

| 继承 | 不继承 |
|---|---|
| Claude 对话历史（共享 `tdc_shared_projects` + `--resume`） | shell 进程、环境变量（会话自定义 env 会复制） |
| 项目源码（同一宿主目录挂到相同路径） | 后台进程（dev server 需在目标容器重启） |
| 工作目录 | prompt cache：首轮按完整上下文计费，长对话会立即消耗目标账号较多额度 |

恢复预检确认目标能够读取会话文件；只有历史缺失时才降级为新对话。文件存在不代表供应商已经接受恢复后的首轮请求。第三方 API 默认关闭不兼容的思考进度扩展（`CLAUDE_CODE_THINKING_DISPLAY_UPDATES=0`）；如果原服务的思考签名被拒绝，Claude 自身会重试，不需要改写共享历史或关闭思考能力。

`docker/tests/provider-resume-tests.mjs` 使用真实 Claude Code 和本地模拟 API，覆盖交互恢复、首轮请求字段、旧签名重试与终端显示回复，全程只用合成历史。`npm run test:provider-resume` 需要 Linux、Claude CLI 与 tmux；Windows 会跳过，可在标准容器镜像中用 `node --test` 执行该文件。

## 7. 命令行版（无桌面端时）

```bash
cd docker
./scripts/tdc-quota.sh            # 表格：🟢/🟡/🔴/⚪/🔵 容器 模式 5h剩余@重置 周剩余@重置 模型
./scripts/tdc-quota.sh --json     # 带 health / remaining
docker exec claude-dev-01 tdc-ctl session-list     # 查会话 ID
./scripts/tdc-switch.sh claude-dev-01 a1b2c3d4     # 自动选目标并 --resume，直接附着终端
./scripts/tdc-switch.sh claude-dev-01 a1b2c3d4 claude-dev-02   # 指定目标
```
宿主机无需 Node/jq：计算在运行中的容器内执行 `node /opt/tdc/tdc-lib.mjs`。

## 8. 调试：模拟额度耗尽

真实撞限额难以复现。debug 构建提供 `debug_inject_quota`，可在 WebView DevTools 控制台执行：
```js
await window.__TAURI_INTERNALS__.invoke("debug_inject_quota", {
  container: "claude-dev-01",
  quota: { five_hour: { used_percentage: 100, resets_at: Math.floor(Date.now()/1000) + 3600 }, seven_day: null }
});
// 清除：quota: null
```
