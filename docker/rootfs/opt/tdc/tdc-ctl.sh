#!/usr/bin/env bash
# =============================================================================
# tdc-ctl —— 容器内控制命令（桌面端通过 docker exec 调用，也可手工使用）
#
# 用法：
#   tdc-ctl health                          端口守护是否存活（HEALTHCHECK 使用）
#   tdc-ctl quota                           输出 quota.json
#   tdc-ctl ports                           输出 ports.json
#   tdc-ctl snapshot                        一次输出 meta + quota + ports + 账号 + 会话 + 代理（桌面端轮询使用）
#   tdc-ctl account                         输出当前登录账号概要（不含任何令牌）
#   tdc-ctl session-list                    列出 tdc- 前缀的 tmux 会话（JSON 数组）
#   tdc-ctl session-info <id>               输出 sessions/<id>.json
#   tdc-ctl session-stop <id> [超时秒]      优雅退出会话中的 claude（/exit → TERM → KILL）
#   tdc-ctl link-shared                     把共享目录中的 CLAUDE.md / skills 等链接到配置目录
#   tdc-ctl proxy-<子命令> [参数]           代理控制（需 root），转发给 tdc-proxy.sh：apply / off /
#                                           restore / status / nodes / select <节点> / delay / refresh
# 所有输出均为 JSON，便于桌面端解析。
# =============================================================================
set -uo pipefail

: "${CLAUDE_CONFIG_DIR:=/home/node/.claude}"
: "${TDC_STATE_DIR:=/home/node/.claude/tdc/state}"
: "${TDC_SHARED_DIR:=/home/node/.claude-shared}"
: "${TDC_PROXY_STATUS:=/var/lib/tdc/proxy-status.json}"
PROC_ROOT="${PROC_ROOT:-/proc}"

# 函数：校验会话 ID 只含安全字符，防止路径穿越与 tmux 目标注入
# 参数：$1 会话 ID
# 返回：0 合法，否则打印错误 JSON 并退出 2
require_id() {
  if [[ ! "${1:-}" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
    printf '{"error":"非法会话 ID"}\n'
    exit 2
  fi
}

# 函数：输出指定 JSON 文件，不存在时输出 null
# 参数：$1 文件路径
# 返回：无
cat_json() {
  if [[ -f "$1" ]]; then cat "$1"; else printf 'null\n'; fi
}

# 函数：端口守护健康检查——ports.json 在 30 秒内更新过即视为健康
# 参数：无
# 返回：0 健康，1 不健康
cmd_health() {
  local file="$TDC_STATE_DIR/ports.json" mtime now
  [[ -f "$file" ]] || return 1
  mtime=$(stat -c %Y "$file" 2>/dev/null) || return 1
  now=${EPOCHSECONDS:-$(date +%s)}
  (( now - mtime < 30 ))
}

# 函数：输出当前账号概要（读取 $CLAUDE_CONFIG_DIR/.claude.json 的 oauthAccount，仅取非敏感字段）
# 参数：无
# 返回：无
cmd_account() {
  node -e '
    const fs = require("fs");
    const dir = process.env.CLAUDE_CONFIG_DIR;
    let acct = null;
    try { acct = JSON.parse(fs.readFileSync(dir + "/.claude.json", "utf8")).oauthAccount || null; } catch {}
    const hasCredentials = fs.existsSync(dir + "/.credentials.json");
    const out = {
      logged_in: hasCredentials || !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
      email: acct && typeof acct.emailAddress === "string" ? acct.emailAddress : null,
      display_name: acct && typeof acct.displayName === "string" ? acct.displayName : null,
      organization_type: acct && typeof acct.organizationType === "string" ? acct.organizationType : null,
      rate_limit_tier: acct && typeof acct.rateLimitTier === "string" ? acct.rateLimitTier : null,
    };
    process.stdout.write(JSON.stringify(out) + "\n");
  '
}

# 函数：列出 tdc- 前缀的 tmux 会话
# 参数：无
# 返回：无（输出 JSON 数组；没有 tmux server 时输出 []）
cmd_session_list() {
  local first=1 name created attached path command
  printf '['
  while IFS=$'\t' read -r name created attached path command; do
    [[ "$name" == tdc-* ]] || continue
    (( first )) || printf ','
    first=0
    printf '{"tmux_session":"%s","id":"%s","created_at":%s,"attached":%s,"cwd":"%s","command":"%s"}' \
      "$name" "${name#tdc-}" "${created:-0}" "${attached:-0}" "${path//\"/}" "${command//\"/}"
  done < <(tmux list-sessions -F $'#{session_name}\t#{session_created}\t#{session_attached}\t#{pane_current_path}\t#{pane_current_command}' 2>/dev/null)
  printf ']\n'
}

# 函数：查找属于指定 tdc 会话的 claude 进程 PID
# 参数：$1 会话 ID
# 输出：PID 列表（每行一个）
find_claude_pids() {
  local id=$1 dir pid comm cmdline
  for dir in "$PROC_ROOT"/[0-9]*; do
    pid=${dir##*/}
    [[ -r "$dir/environ" ]] || continue
    read -r comm < "$dir/comm" 2>/dev/null || continue
    # npm 可安装 Node 或原生 CLI；包装入口调用原生 CLI 时进程名为 tdc-claude-real。
    # 仅接受 CLI 进程名，排除 bash -c "claude ...; exec bash -l"。
    [[ "$comm" == "node" || "$comm" == "claude" || "$comm" == "tdc-claude-real" ]] || continue
    cmdline=$(tr '\0' ' ' < "$dir/cmdline" 2>/dev/null) || continue
    [[ "$cmdline" == *claude* && "$cmdline" != *statusline.mjs* ]] || continue
    tr '\0' '\n' < "$dir/environ" 2>/dev/null | grep -qx "TDC_SESSION_ID=$id" && echo "$pid"
  done
}

# 函数：判断 PID 列表中是否仍有存活进程
# 参数：$@ PID 列表
# 返回：0 有存活，1 全部退出
any_alive() {
  local pid
  for pid in "$@"; do kill -0 "$pid" 2>/dev/null && return 0; done
  return 1
}

# 函数：等待进程退出
# 参数：$1 超时秒数；其余为 PID 列表
# 返回：0 全部退出，1 超时
wait_exit() {
  local timeout=$1; shift
  local deadline=$(( ${EPOCHSECONDS:-$(date +%s)} + timeout ))
  while any_alive "$@"; do
    (( ${EPOCHSECONDS:-$(date +%s)} >= deadline )) && return 1
    sleep 0.2
  done
  return 0
}

# 函数：优雅退出会话中的 claude，并返回最后已知的 Claude session_id（供目标容器 --resume）
# 参数：$1 会话 ID；$2 超时秒数（默认 5）
# 返回：无（输出 JSON）
cmd_session_stop() {
  local id=$1 timeout=${2:-5} method="none" pids=()
  mapfile -t pids < <(find_claude_pids "$id")
  if (( ${#pids[@]} > 0 )); then
    method="exit"
    # 先 Esc 关闭可能打开的菜单，再输入 /exit
    tmux send-keys -t "tdc-$id" Escape 2>/dev/null || true
    sleep 0.3
    tmux send-keys -t "tdc-$id" -l "/exit" 2>/dev/null || true
    tmux send-keys -t "tdc-$id" Enter 2>/dev/null || true
    if ! wait_exit "$timeout" "${pids[@]}"; then
      method="term"
      kill -TERM "${pids[@]}" 2>/dev/null || true
      if ! wait_exit 2 "${pids[@]}"; then
        method="kill"
        kill -KILL "${pids[@]}" 2>/dev/null || true
      fi
    fi
  fi
  local session_id="null" cwd="null" info="$TDC_STATE_DIR/sessions/$id.json"
  if [[ -f "$info" ]]; then
    session_id=$(node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify(s.session_id??null))}catch{process.stdout.write("null")}' "$info")
    cwd=$(node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify(s.cwd??null))}catch{process.stdout.write("null")}' "$info")
  fi
  printf '{"stopped":true,"method":"%s","pids":%d,"session_id":%s,"cwd":%s}\n' "$method" "${#pids[@]}" "$session_id" "$cwd"
}

# 函数：可逆应用宿主只读配置，未启用项沿用本地/共享配置。
# 参数：无
# 返回：无
cmd_link_shared() {
  mkdir -p "$CLAUDE_CONFIG_DIR/tdc" || return 1
  flock "$CLAUDE_CONFIG_DIR/tdc/host-config.lock" node /opt/tdc/tdc-host-config.mjs link-shared
}

# 函数：一次性输出完整状态快照，减少桌面端 docker exec 次数
# 参数：无
# 返回：无（输出 {"meta","quota","ports","account","sessions","tmux","proxy"} JSON）
cmd_snapshot() {
  local tmux_json
  tmux_json=$(cmd_session_list)
  TDC_TMUX_JSON="$tmux_json" TDC_PROXY_STATUS="$TDC_PROXY_STATUS" node --input-type=module -e '
    import fs from "node:fs";
    import path from "node:path";
    import { createSessionTitleReader } from "/opt/tdc/tdc-session-history.mjs";
    const st = process.env.TDC_STATE_DIR;
    const dir = process.env.CLAUDE_CONFIG_DIR;
    const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
    let acct = null;
    try { acct = JSON.parse(fs.readFileSync(dir + "/.claude.json", "utf8")).oauthAccount || null; } catch {}
    const sessions = [];
    const titleFor = createSessionTitleReader(path.join(dir, "projects"));
    try {
      for (const f of fs.readdirSync(path.join(st, "sessions"))) {
        if (f.endsWith(".json")) { const s = read(path.join(st, "sessions", f)); if (s) sessions.push({ ...s, title: titleFor(s) || s.title || null }); }
      }
    } catch {}
    let tmux = [];
    try { tmux = JSON.parse(process.env.TDC_TMUX_JSON || "[]"); } catch {}
    const out = {
      protocol: 1,
      now: Math.floor(Date.now() / 1000),
      meta: read(path.join(st, "meta.json")),
      quota: read(path.join(st, "quota.json")),
      ports: read(path.join(st, "ports.json")),
      provider: (() => { const p = read(dir + "/tdc/provider-settings.json"); return { mode: p && p.env && Object.keys(p.env).length > 0 ? "api" : "subscription", base_url: p?.env?.ANTHROPIC_BASE_URL ?? null, model: p?.env?.ANTHROPIC_MODEL ?? null }; })(),
      account: {
        logged_in: fs.existsSync(dir + "/.credentials.json") || !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
        email: typeof acct?.emailAddress === "string" ? acct.emailAddress : null,
        display_name: typeof acct?.displayName === "string" ? acct.displayName : null,
        organization_type: typeof acct?.organizationType === "string" ? acct.organizationType : null,
        rate_limit_tier: typeof acct?.rateLimitTier === "string" ? acct.rateLimitTier : null,
      },
      sessions,
      tmux,
      proxy: read(process.env.TDC_PROXY_STATUS),
    };
    process.stdout.write(JSON.stringify(out) + "\n");
  '
}

# 函数：只读提取用量元数据，按独立输入历史与请求父链确认容器归属。
# 参数：无；返回：协议 2 单行 JSON，不含提示词、回答或凭据。
cmd_usage() {
  CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" node "$(dirname -- "${BASH_SOURCE[0]}")/tdc-usage.mjs"
}

case "${1:-}" in
  health) cmd_health ;;
  quota) cat_json "$TDC_STATE_DIR/quota.json" ;;
  ports) cat_json "$TDC_STATE_DIR/ports.json" ;;
  snapshot) cmd_snapshot ;;
  account) cmd_account ;;
  session-list) cmd_session_list ;;
  session-info) require_id "${2:-}"; cat_json "$TDC_STATE_DIR/sessions/$2.json" ;;
  session-stop) require_id "${2:-}"; cmd_session_stop "$2" "${3:-5}" ;;
  link-shared) cmd_link_shared ;;
  usage) cmd_usage ;;
  proxy-*) sub=${1#proxy-}; shift; exec /opt/tdc/tdc-proxy.sh "$sub" "$@" ;;
  *)
    sed -n '5,17p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
