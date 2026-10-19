#!/usr/bin/env bash
# =============================================================================
# tdc-proxy.sh —— 容器内代理控制（mihomo + TUN + 兜底规则），需 root 执行
#
# 用法（桌面端经 `docker exec -u root <容器> tdc-ctl proxy-<子命令>` 调用）：
#   tdc-proxy.sh apply            校验配置 → 施加兜底 → 启动内核 → 选中节点 → 自检（输出 JSON）
#   tdc-proxy.sh off              停内核、移除兜底、还原 DNS，并把 intent 置为未启用
#   tdc-proxy.sh restore          容器启动时由 entrypoint 调用：intent 已启用则先上兜底再起内核
#   tdc-proxy.sh status           输出 proxy-status.json
#   tdc-proxy.sh nodes            输出节点组 NODE 的全部节点与当前节点
#   tdc-proxy.sh select <节点名>  切换当前节点并写回 intent
#   tdc-proxy.sh delay            对节点组测延迟
#   tdc-proxy.sh refresh          立即刷新订阅
#   tdc-proxy.sh daemon [--once]  常驻守护：内核崩溃重启（退避 5→60s）、兜底自愈、写状态
#
# 文件（$TDC_PROXY_DIR，默认 /var/lib/tdc/proxy，root 0700，位于容器层而非卷）：
#   config.yaml   桌面端生成的 mihomo 配置（JSON 内容）  intent.json  期望状态 {enabled,allow_lan,lan_cidrs,selected}
#   mihomo.sock   控制器 unix socket                    core.pid / mihomo.log / last_error / core.restarts
# 状态输出：$TDC_PROXY_STATUS（默认 /var/lib/tdc/proxy-status.json，0644，node 可读）
#
# 失败策略（fail-closed）：配置校验失败时不改动网络；兜底施加后任何环节失败都保持断网，
# 只有显式的 off 才会恢复直连。
# =============================================================================
set -uo pipefail

PROXY_DIR="${TDC_PROXY_DIR:-/var/lib/tdc/proxy}"
STATUS_FILE="${TDC_PROXY_STATUS:-/var/lib/tdc/proxy-status.json}"
MIHOMO="${TDC_MIHOMO_BIN:-/usr/local/bin/mihomo}"
GUARD="${TDC_PROXY_GUARD:-/opt/tdc/proxy-guard.sh}"
LIB="${TDC_PROXY_LIB:-/opt/tdc/tdc-proxy-lib.mjs}"
XRAY="${TDC_XRAY_BIN:-/usr/local/bin/xray}"
XRAY_LIB="${TDC_XRAY_LIB:-/opt/tdc/tdc-xray.mjs}"
TUN_DEV="${TDC_TUN_DEV:-tdc0}"
APP_USER="${TDC_APP_USER:-node}"
INTERVAL="${TDC_PROXY_INTERVAL:-3}"
PROBE_URL="${TDC_PROXY_PROBE_URL:-https://www.gstatic.com/generate_204}"
CONFIG="$PROXY_DIR/config.yaml"
INTENT="$PROXY_DIR/intent.json"
SOCK="$PROXY_DIR/mihomo.sock"
PIDFILE="$PROXY_DIR/core.pid"
XRAY_PIDFILE="$PROXY_DIR/xray.pid"
XRAY_LOG="$PROXY_DIR/xray.log"
XRAY_CURRENT="$PROXY_DIR/xray-current"
LOG="$PROXY_DIR/mihomo.log"
DAEMON_LOG="$PROXY_DIR/daemon.log"
ERRFILE="$PROXY_DIR/last_error"
RESTARTS_FILE="$PROXY_DIR/core.restarts"
LOCK="$PROXY_DIR/.lock"
GROUP=NODE
# 低于 mihomo auto-route 的 9000 段，确保先于 TUN 规则命中
ROOT_BYPASS_PRIORITY=8990
LOG_MAX_BYTES=$((5 * 1024 * 1024))
SELF=$(readlink -f "$0")
# 以脚本内容识别守护版本；在线同步脚本后，下一次应用会替换旧守护。
RUNTIME_VERSION=$(sha256sum "$SELF" | cut -d ' ' -f 1)

# 函数：当前 epoch 秒
# 参数：无
# 输出：整数
now_s() { printf '%s' "${EPOCHSECONDS:-$(date +%s)}"; }

# 函数：输出失败 JSON
# 参数：$1 阶段；$2 错误信息
# 输出：{"ok":false,"stage":...,"error":...}
json_fail() { jq -cn --arg s "$1" --arg e "$2" '{ok:false,stage:$s,error:$e}'; }

# 函数：记录最近一次错误（状态文件展示）
# 参数：$1 错误信息
# 返回：无
set_error() { printf '%s\n' "$1" > "$ERRFILE"; }

# 函数：清除最近一次错误
# 参数：无
# 返回：无
clear_error() { rm -f "$ERRFILE"; }

# 函数：守护日志（超过上限时截断）
# 参数：$* 日志内容
# 返回：无
log() {
  [[ -f "$DAEMON_LOG" ]] && (( $(stat -c %s "$DAEMON_LOG" 2>/dev/null || echo 0) > LOG_MAX_BYTES )) && : > "$DAEMON_LOG"
  printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$DAEMON_LOG"
}

# 函数：intent 是否为启用
# 参数：无
# 返回：0 启用，1 未启用或文件缺失
intent_enabled() { [[ "$(jq -r '.enabled // false' "$INTENT" 2>/dev/null)" == "true" ]]; }
xray_enabled() { [[ "$(jq -r '.engine // "mihomo"' "$INTENT" 2>/dev/null)" == "xray" ]]; }
runtime_config() { if xray_enabled; then printf '%s/mihomo.json' "$XRAY_CURRENT"; else printf '%s' "$CONFIG"; fi; }

managed_pid() {
  local pid comm
  pid=$(cat "$1" 2>/dev/null) || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  read -r comm < "/proc/$pid/comm" 2>/dev/null || return 1
  [[ "$comm" == "$2" ]] || return 1
  [[ $(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null) != Z ]] || return 1
  printf '%s' "$pid"
}
xray_pid() { managed_pid "$XRAY_PIDFILE" xray; }

# 老镜像的 daemon 已在内存中加载旧脚本；只替换该脚本自己的守护进程。
ensure_daemon() {
  local pid args=()
  if pid=$(managed_pid "$PROXY_DIR/daemon.pid" bash) && [[ $(cat "$PROXY_DIR/daemon.version" 2>/dev/null) == "$RUNTIME_VERSION" ]]; then return 0; fi
  while read -r pid; do
    args=()
    mapfile -d '' -t args < "/proc/$pid/cmdline" 2>/dev/null || continue
    if [[ ${#args[@]} == 3 && "${args[1]}" == "$SELF" && "${args[2]}" == daemon ]]; then kill -TERM "$pid" 2>/dev/null; fi
  done < <(pgrep -f 'tdc-proxy.sh daemon$' || true)
  setsid "$SELF" daemon >> "$DAEMON_LOG" 2>&1 < /dev/null 8>&- 9>&- &
}

# 函数：根据 intent 输出 proxy-guard.sh 的局域网参数
# 参数：无
# 输出：--allow-lan 或空串
lan_flag() { [[ "$(jq -r '.allow_lan // false' "$INTENT" 2>/dev/null)" == "true" ]] && printf -- '--allow-lan'; }

# 函数：读取存活的内核 PID（校验进程名，防止 PID 复用误判）
# 参数：无
# 输出：PID；不存在时无输出并返回 1
core_pid() {
  managed_pid "$PIDFILE" mihomo
}

# 函数：内核是否存活
# 参数：无
# 返回：0 存活，1 不存活
core_alive() { core_pid >/dev/null && { ! xray_enabled || xray_pid >/dev/null; }; }

# 函数：TUN 设备是否存在
# 参数：无
# 返回：0 存在，1 不存在
tun_up() { ip link show dev "$TUN_DEV" >/dev/null 2>&1; }

# 函数：调用 mihomo 控制器（unix socket，仅 root 可访问）
# 参数：$1 HTTP 方法；$2 路径；$3 可选 JSON 请求体
# 输出：响应体；返回：curl 退出码
ctl() {
  local args=(-sS --fail --max-time 10 --unix-socket "$SOCK" -X "$1")
  [[ -n "${3:-}" ]] && args+=(-H 'Content-Type: application/json' --data "$3")
  curl "${args[@]}" "http://mihomo$2"
}

# 函数：让 root 发起的命令绕过当前 TUN 路由直连（从 mihomo 切到 Xray 时旧节点可能不通，订阅仍要能拉取）。
#       root 本就被兜底规则豁免，Xray 模式下 mihomo 也排除 uid 0；node 用户的流量不受影响
# 参数：$@ 要执行的命令
# 返回：命令退出码
with_root_bypass() {
  local rc
  while ip rule del priority "$ROOT_BYPASS_PRIORITY" 2>/dev/null; do :; done
  ip rule add priority "$ROOT_BYPASS_PRIORITY" uidrange 0-0 lookup main 2>/dev/null
  "$@"; rc=$?
  while ip rule del priority "$ROOT_BYPASS_PRIORITY" 2>/dev/null; do :; done
  return "$rc"
}

# 函数：以 mihomo -t 校验配置（不启动、不动网络）；Xray 内核由镜像内置，运行时不下载
# 参数：无
# 返回：0 通过；失败时写 last_error 并返回 1
core_validate() {
  local out
  [[ -f "$CONFIG" ]] || { set_error "缺少配置文件 $CONFIG"; return 1; }
  if xray_enabled; then
    [[ -x "$XRAY" ]] || { set_error "该容器的镜像未内置 Xray 内核：请用最新 docker/Dockerfile 重新构建镜像后重建容器，或把节点内核改回 Mihomo"; return 1; }
    if ! out=$(with_root_bypass node "$XRAY_LIB" prepare "$@" 2>&1); then set_error "$out"; return 1; fi
    return 0
  fi
  if ! out=$("$MIHOMO" -t -d "$PROXY_DIR" -f "$(runtime_config)" 2>&1); then
    set_error "配置校验失败：$(printf '%s' "$out" | tail -n 5)"
    return 1
  fi
  return 0
}

# 函数：后台启动内核。stdout/stderr/stdin 全部重定向，避免占住 docker exec 的输出流；
#       必须关闭锁文件描述符 9，否则内核继承 flock 后会永久持有全局锁，apply / off / 守护全部卡死
# 参数：无
# 返回：0 已启动，1 启动失败
core_start() {
  local pid
  [[ -f "$LOG" ]] && (( $(stat -c %s "$LOG" 2>/dev/null || echo 0) > LOG_MAX_BYTES )) && : > "$LOG"
  if xray_enabled; then
    [[ -f "$XRAY_LOG" ]] && (( $(stat -c %s "$XRAY_LOG" 2>/dev/null || echo 0) > LOG_MAX_BYTES )) && : > "$XRAY_LOG"
    setsid "$XRAY" run -config "$XRAY_CURRENT/xray.json" >> "$XRAY_LOG" 2>&1 < /dev/null 8>&- 9>&- &
    printf '%s\n' "$!" > "$XRAY_PIDFILE"
    sleep 0.3
    xray_pid >/dev/null || { set_error "Xray 内核启动失败，请检查节点配置或本地端口占用"; return 1; }
  fi
  setsid "$MIHOMO" -d "$PROXY_DIR" -f "$(runtime_config)" >> "$LOG" 2>&1 < /dev/null 8>&- 9>&- &
  printf '%s\n' "$!" > "$PIDFILE"
  sleep 0.5
  if ! core_alive; then
    # setsid 在少数情况下会 fork，$! 不是内核 PID，按进程名兜底查找
    pid=$(pgrep -n -x mihomo) && printf '%s\n' "$pid" > "$PIDFILE"
  fi
  core_alive || { set_error "内核启动即退出：$(tail -n 5 "$LOG" 2>/dev/null)"; return 1; }
  if xray_enabled; then node "$XRAY_LIB" cleanup >/dev/null 2>&1 || true; fi
  return 0
}

# 函数：停止内核并清理残留 TUN 设备（kill -9 后设备可能残留，下次启动会报 file exists）
# 参数：无
# 返回：0
core_stop() {
  local pids=() deadline
  mapfile -t pids < <({ core_pid; echo; xray_pid; echo; pgrep -x mihomo; } | grep -E '^[0-9]+$' | sort -u)
  if (( ${#pids[@]} > 0 )); then
    kill -TERM "${pids[@]}" 2>/dev/null
    deadline=$(( $(now_s) + 5 ))
    while kill -0 "${pids[@]}" 2>/dev/null && (( $(now_s) < deadline )); do sleep 0.2; done
    kill -KILL "${pids[@]}" 2>/dev/null
  fi
  rm -f "$PIDFILE" "$XRAY_PIDFILE" "$SOCK"
  tun_up && ip link del dev "$TUN_DEV" 2>/dev/null
  return 0
}

# 函数：等待 TUN 与控制器就绪
# 参数：$1 超时秒数
# 返回：0 就绪，1 超时
wait_ready() {
  local deadline=$(( $(now_s) + $1 ))
  while (( $(now_s) < deadline )); do
    core_alive || return 1
    tun_up && ctl GET /version >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

# 函数：按 intent.selected 切换节点（未设置或切换失败时保持内核默认的第一个节点）
# 参数：无
# 返回：0
select_from_intent() {
  local sel
  sel=$(jq -r '.selected // empty' "$INTENT" 2>/dev/null)
  [[ -n "$sel" ]] || return 0
  ctl PUT "/proxies/$GROUP" "$(jq -cn --arg n "$sel" '{name:$n}')" >/dev/null 2>&1 || true
}

# 函数：以应用用户身份执行命令（自检探测要模拟普通进程）
# 参数：$@ 命令
# 返回：命令退出码
run_as_app() {
  setpriv --reuid="$APP_USER" --regid="$APP_USER" --init-groups env HOME="/home/$APP_USER" "$@"
}

# 函数：自检，证明"走代理通、绕过代理不通、DNS 经过 mihomo"
# 参数：无
# 输出：checks JSON 对象
self_check() {
  local lan core=false tun=false guard=false dns=false proxied=false bypass=false ddns=false ip code dev
  lan=$(lan_flag)
  core_alive && core=true
  tun_up && tun=true
  # shellcheck disable=SC2086
  "$GUARD" check $lan && guard=true
  ip=$(run_as_app getent ahostsv4 example.com 2>/dev/null | awk 'NR==1{print $1}')
  [[ "$ip" == 198.18.* ]] && dns=true
  code=$(run_as_app curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$PROBE_URL" 2>/dev/null)
  [[ "$code" == "204" ]] && proxied=true
  dev=$(ip -4 route show table main default 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); exit}}')
  if [[ -n "$dev" ]]; then
    run_as_app curl -sS -o /dev/null --max-time 4 --interface "$dev" https://1.1.1.1/ >/dev/null 2>&1 || bypass=true
  fi
  run_as_app node -e '
    const { Resolver } = require("dns").promises;
    const r = new Resolver({ timeout: 2000, tries: 1 });
    r.setServers(["127.0.0.11"]);
    r.resolve4("example.com").then(() => process.exit(1), () => process.exit(0));
  ' >/dev/null 2>&1 && ddns=true
  jq -cn --argjson core "$core" --argjson tun "$tun" --argjson guard "$guard" --argjson dns "$dns" \
    --argjson proxied "$proxied" --argjson bypass "$bypass" --argjson ddns "$ddns" \
    '{core:$core,tun:$tun,guard:$guard,dns_hijack:$dns,proxied:$proxied,bypass_blocked:$bypass,docker_dns_blocked:$ddns}'
}

# 函数：采集原始事实（供 tdc-proxy-lib.mjs 分类）
# 参数：无
# 输出：事实 JSON
collect_facts() {
  local intent pid="" xpid="" alive=false age=null tun=false guard=false restarts providers=null sel="" lan xmeta=null
  intent=$(jq -c . "$INTENT" 2>/dev/null) || intent=null
  [[ -n "$intent" ]] || intent=null
  if pid=$(core_pid); then
    core_alive && alive=true
    age=$(( $(now_s) - $(stat -c %Y "$PIDFILE" 2>/dev/null || now_s) ))
    providers=$(ctl GET /providers/proxies 2>/dev/null) || providers=null
    [[ -n "$providers" ]] || providers=null
    sel=$(ctl GET "/proxies/$GROUP" 2>/dev/null | jq -r '.now // empty' 2>/dev/null)
  fi
  if xray_enabled; then
    xpid=$(xray_pid) || xpid=""
    xmeta=$(cat "$XRAY_CURRENT/meta.json" 2>/dev/null) || xmeta=null
    if [[ $(printf '%s' "$xmeta" | jq -r '.subscription // false') == true ]]; then
      providers=$(printf '%s' "$xmeta" | jq -c '{providers:{sub:{name:"sub",vehicleType:"File",proxies:(.names|map({name:.})),updatedAt:(.updatedAt|todateiso8601)}}}')
    fi
  fi
  tun_up && tun=true
  lan=$(lan_flag)
  # shellcheck disable=SC2086
  "$GUARD" check $lan && guard=true
  restarts=$(cat "$RESTARTS_FILE" 2>/dev/null); [[ "$restarts" =~ ^[0-9]+$ ]] || restarts=0
  jq -cn --argjson intent "$intent" --argjson pid "${pid:-null}" --argjson alive "$alive" --argjson age "$age" \
    --argjson tun "$tun" --argjson guard "$guard" --argjson restarts "$restarts" \
    --arg err "$(cat "$ERRFILE" 2>/dev/null)" --argjson providers "$providers" --arg sel "$sel" --argjson xpid "${xpid:-null}" --argjson xmeta "$xmeta" \
    '{intent:$intent,core:{pid:$pid,alive:$alive,age:$age},tun:$tun,guard:$guard,restarts:$restarts,
      xray:{pid:$xpid,warnings:($xmeta.warnings // [])},last_error:$err,controller:{now:(if $sel=="" then null else $sel end),providers:$providers}}'
}

# 函数：把事实分类后原子写入状态文件
# 参数：$1 可选，已采集的事实 JSON
# 返回：无
write_status() {
  local facts=${1:-} tmp="$STATUS_FILE.$$.tmp"
  [[ -n "$facts" ]] || facts=$(collect_facts)
  printf '%s' "$facts" | jq -c --argjson now "$(now_s)" '. + {now:$now}' | node "$LIB" status > "$tmp" \
    && chmod 0644 "$tmp" && mv -f "$tmp" "$STATUS_FILE"
}

# 函数：获取全局锁（apply / off / restore 互斥；守护用非阻塞模式跳过本轮）
# 参数：$1 等待秒数（0 表示不等待）
# 返回：0 获得，1 未获得
take_lock() {
  exec 9> "$LOCK"
  if (( $1 == 0 )); then flock -n 9; else flock -w "$1" 9; fi
}

# 函数：apply 子命令
# 参数：无
# 输出：{"ok":bool,"stage":...,"checks":{...},"state":...,"error":...}
cmd_apply() {
  local lan checks ok state guard_err
  take_lock 60 || { json_fail lock "另一个代理操作正在进行"; return 0; }
  ensure_daemon
  [[ -f "$INTENT" ]] || { json_fail intent "缺少 $INTENT"; return 0; }
  intent_enabled || { flock -u 9; cmd_off; return 0; }
  # 1. 先校验，失败则不触碰网络（保持当前状态）
  core_validate || { json_fail validate "$(cat "$ERRFILE")"; return 0; }
  # 2. 先施加兜底，再重启内核：任何时刻都不存在"无规则也无代理"的窗口
  lan=$(lan_flag)
  # shellcheck disable=SC2086
  if ! guard_err=$("$GUARD" apply $lan 2>&1 >/dev/null); then
    set_error "兜底规则施加失败：$(printf '%s' "$guard_err" | tail -n 3)"
    write_status
    json_fail guard "$(cat "$ERRFILE")"
    return 0
  fi
  core_stop
  printf '0\n' > "$RESTARTS_FILE"
  clear_error
  if ! core_start || ! wait_ready 20; then
    [[ -s "$ERRFILE" ]] || set_error "内核未就绪：$(tail -n 5 "$LOG" 2>/dev/null)"
    write_status
    jq -cn --arg e "$(cat "$ERRFILE")" '{ok:false,stage:"core",error:$e,state:"blackhole"}'
    return 0
  fi
  select_from_intent
  checks=$(self_check)
  ok=$(printf '%s' "$checks" | jq 'all(.[]; . == true)')
  [[ "$ok" == "true" ]] || set_error "自检未通过：$(printf '%s' "$checks" | jq -r 'to_entries | map(select(.value != true) | .key) | join(", ")')"
  write_status
  state=$(jq -r '.state // "unknown"' "$STATUS_FILE" 2>/dev/null)
  jq -cn --argjson ok "$ok" --argjson checks "$checks" --arg state "$state" --arg e "$(cat "$ERRFILE" 2>/dev/null)" \
    '{ok:$ok,stage:"done",checks:$checks,state:$state,error:(if $e=="" then null else $e end)}'
}

# 函数：off 子命令（救援入口：不依赖网络，随时可恢复直连）
# 参数：无
# 输出：{"ok":true}
cmd_off() {
  take_lock 60 || { json_fail lock "另一个代理操作正在进行"; return 0; }
  core_stop
  "$GUARD" remove
  if [[ -f "$INTENT" ]]; then
    jq '.enabled = false' "$INTENT" > "$INTENT.tmp" && mv -f "$INTENT.tmp" "$INTENT"
  fi
  clear_error
  write_status
  printf '{"ok":true,"state":"off"}\n'
}

# 函数：restore 子命令（entrypoint 调用，必须在任何用户进程之前完成兜底）
# 参数：无
# 返回：0（错误写入 last_error，由状态文件呈现）
cmd_restore() {
  local lan
  mkdir -p "$PROXY_DIR/providers"
  take_lock 30 || return 0
  if intent_enabled; then
    lan=$(lan_flag)
    # shellcheck disable=SC2086
    "$GUARD" apply $lan || set_error "启动时兜底规则施加失败（网络保持断开）"
    rm -f "$PIDFILE" "$XRAY_PIDFILE" "$SOCK"
    core_validate && core_start
  fi
  write_status
  return 0
}

# 函数：nodes 子命令
# 参数：无
# 输出：{"now":...,"all":[...]}
cmd_nodes() {
  local out
  core_alive || { json_fail core "内核未运行"; return 0; }
  out=$(ctl GET "/proxies/$GROUP" 2>&1) || { json_fail controller "$out"; return 0; }
  printf '%s' "$out" | jq -c '{ok:true,now:(.now // null),all:(.all // [])}'
}

# 函数：select 子命令
# 参数：$1 节点名
# 输出：{"ok":true,"now":...}
cmd_select() {
  local name=${1:-} out
  [[ -n "$name" ]] || { json_fail args "缺少节点名"; return 0; }
  core_alive || { json_fail core "内核未运行"; return 0; }
  out=$(ctl PUT "/proxies/$GROUP" "$(jq -cn --arg n "$name" '{name:$n}')" 2>&1) || { json_fail controller "切换失败：$out"; return 0; }
  if [[ -f "$INTENT" ]]; then
    jq --arg n "$name" '.selected = $n' "$INTENT" > "$INTENT.tmp" && mv -f "$INTENT.tmp" "$INTENT"
  fi
  write_status
  jq -cn --arg n "$name" '{ok:true,now:$n}'
}

# 函数：delay 子命令（对整个节点组测延迟，单位毫秒；超时的节点不出现在结果中）
# 参数：无
# 输出：{"ok":true,"delays":{节点名:毫秒}}
cmd_delay() {
  local url out
  core_alive || { json_fail core "内核未运行"; return 0; }
  url=$(jq -rn --arg u "$PROBE_URL" '$u|@uri')
  out=$(ctl GET "/group/$GROUP/delay?url=$url&timeout=5000" 2>&1) || { json_fail controller "$out"; return 0; }
  printf '%s' "$out" | jq -c '{ok:true,delays:.}'
}

# 函数：refresh 子命令（立即重新拉取全部订阅）
# 参数：无
# 输出：{"ok":true,"refreshed":[...]}
cmd_refresh() {
  local names=() n done_list=()
  take_lock 60 || { json_fail lock "另一个代理操作正在进行"; return 0; }
  core_alive || { json_fail core "内核未运行"; return 0; }
  if xray_enabled; then
    if [[ $(jq -r '.subscription // false' "$XRAY_CURRENT/meta.json" 2>/dev/null) != true ]]; then printf '{"ok":true,"refreshed":[]}\n'; return 0; fi
    if refresh_xray; then printf '{"ok":true,"refreshed":["sub"]}\n'; else json_fail refresh "$(cat "$ERRFILE")"; fi
    return 0
  fi
  mapfile -t names < <(ctl GET /providers/proxies 2>/dev/null | jq -r '.providers[] | select(.vehicleType=="HTTP") | .name')
  for n in "${names[@]}"; do
    ctl PUT "/providers/proxies/$(jq -rn --arg n "$n" '$n|@uri')" >/dev/null 2>&1 && done_list+=("$n")
  done
  write_status
  printf '%s\n' "${done_list[@]}" | jq -Rsc 'split("\n") | map(select(. != "")) | {ok:true,refreshed:.}'
}

# 刷新失败时保留旧内核；只有新订阅与两份运行配置都校验通过才切换。
refresh_xray() {
  core_validate --refresh || return 1
  core_stop
  clear_error
  if ! core_start || ! wait_ready 20; then
    [[ -s "$ERRFILE" ]] || set_error "Xray 刷新后内核未就绪，网络保持断开"
    write_status
    return 1
  fi
  select_from_intent
  write_status
}

# 函数：守护的一轮：兜底自愈 + 内核崩溃重启（指数退避）
# 参数：无
# 返回：无
daemon_tick() {
  local lan restarts now due retry
  intent_enabled || return 0
  lan=$(lan_flag)
  # shellcheck disable=SC2086
  if ! "$GUARD" check $lan; then
    if "$GUARD" apply $lan; then log "自愈：兜底规则缺失，已重新施加"; else set_error "兜底规则自愈失败"; fi
  fi
  now=$(now_s)
  if core_alive; then
    tun_up && BACKOFF=5
    if xray_enabled; then
      due=$(jq -r '.refreshAt // 0' "$XRAY_CURRENT/meta.json" 2>/dev/null)
      retry=$(cat "$PROXY_DIR/xray.refresh-retry" 2>/dev/null) || retry=0
      if [[ "$due" =~ ^[0-9]+$ && "$retry" =~ ^[0-9]+$ ]] && (( due > 0 && now >= due && now >= retry )); then
        printf '%s\n' "$(( now + 300 ))" > "$PROXY_DIR/xray.refresh-retry"
        refresh_xray || log "Xray 订阅刷新失败：$(cat "$ERRFILE" 2>/dev/null)"
      fi
    fi
    return 0
  fi
  (( now >= NEXT_TRY )) || return 0
  NEXT_TRY=$(( now + BACKOFF ))
  (( BACKOFF = BACKOFF * 2 > 60 ? 60 : BACKOFF * 2 ))
  if core_validate && core_stop && core_start; then
    wait_ready 20 && select_from_intent
    restarts=$(cat "$RESTARTS_FILE" 2>/dev/null); [[ "$restarts" =~ ^[0-9]+$ ]] || restarts=0
    printf '%s\n' "$(( restarts + 1 ))" > "$RESTARTS_FILE"
    log "内核已重启（第 $(( restarts + 1 )) 次）"
  else
    log "内核重启失败：$(cat "$ERRFILE" 2>/dev/null)"
  fi
}

# 函数：常驻守护主循环。拿不到锁说明 apply / off 正在进行，本轮跳过（避免在切换窗口内写出
#       误导性的 blackhole 状态）
# 参数：$1 --once 时只执行一轮
# 返回：不返回（--once 除外）
cmd_daemon() {
  BACKOFF=5 NEXT_TRY=0
  mkdir -p "$PROXY_DIR/providers"
  if [[ "${1:-}" != "--once" ]]; then
    exec 8> "$PROXY_DIR/.daemon.lock"
    flock -n 8 || return 0
    printf '%s\n' "$$" > "$PROXY_DIR/daemon.pid"
    printf '%s\n' "$RUNTIME_VERSION" > "$PROXY_DIR/daemon.version"
  fi
  while true; do
    if take_lock 0; then
      daemon_tick
      write_status
      flock -u 9
    fi
    [[ "${1:-}" == "--once" ]] && return 0
    sleep "$INTERVAL"
  done
}

if (( EUID != 0 )); then
  json_fail auth "tdc-proxy 需要 root 执行（docker exec -u root）"
  exit 2
fi

case "${1:-}" in
  apply) cmd_apply ;;
  off) cmd_off ;;
  restore) cmd_restore ;;
  status) if [[ -f "$STATUS_FILE" ]]; then cat "$STATUS_FILE"; else printf 'null\n'; fi ;;
  nodes) cmd_nodes ;;
  select) cmd_select "${2:-}" ;;
  delay) cmd_delay ;;
  refresh) cmd_refresh ;;
  daemon) cmd_daemon "${2:-}" ;;
  *)
    sed -n '4,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
