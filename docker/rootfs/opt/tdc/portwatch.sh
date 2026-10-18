#!/usr/bin/env bash
# =============================================================================
# portwatch.sh —— 容器内端口监听守护
#
# 周期扫描 /proc/net/tcp 与 /proc/net/tcp6 中处于 LISTEN（状态 0A）的端口，
# 合并 IPv4/IPv6 后写入 $TDC_STATE_DIR/ports.json，桌面端据此生成 http://localhost:<宿主端口> 链接。
#
# 环境变量：
#   TDC_STATE_DIR            输出目录（默认 /home/node/.claude/tdc/state）
#   TDC_PORTWATCH_INTERVAL   扫描间隔秒数（默认 3）
#   TDC_PORTWATCH_IGNORE     忽略的端口，空格分隔
#   PROC_NET_DIR / PROC_ROOT 测试用：替换 /proc/net 与 /proc
# 参数：
#   --once                   只扫描一轮并把 JSON 打印到 stdout（测试用）
# =============================================================================
set -uo pipefail

PROC_NET_DIR="${PROC_NET_DIR:-/proc/net}"
PROC_ROOT="${PROC_ROOT:-/proc}"
STATE_DIR="${TDC_STATE_DIR:-/home/node/.claude/tdc/state}"
INTERVAL="${TDC_PORTWATCH_INTERVAL:-3}"
IGNORE=" ${TDC_PORTWATCH_IGNORE:-} "

declare -A PORT_BINDS=()      # 端口 → 绑定地址列表（空格分隔）
declare -A PORT_NONLOOP=()    # 端口 → 1 表示至少有一个非环回绑定
declare -A PORT_FAMILY=()     # 端口 → ipv4 / ipv6 / dual
declare -A PORT_INODE=()      # 端口 → 任一监听 socket 的 inode
declare -A INODE_PID=()       # inode → pid
LAST_INODE_SIG=""

# 函数：把 /proc/net/tcp 中小端序的 8 位十六进制 IPv4 地址转为点分十进制
# 参数：$1 十六进制地址（如 0100007F）
# 输出：点分十进制字符串（如 127.0.0.1）
hex_to_ipv4() {
  local h=$1
  printf '%d.%d.%d.%d' "0x${h:6:2}" "0x${h:4:2}" "0x${h:2:2}" "0x${h:0:2}"
}

# 函数：把 /proc/net/tcp6 的 32 位十六进制地址转为可读形式（仅识别常见的通配/环回/IPv4 映射地址）
# 参数：$1 十六进制地址
# 输出：::、::1、::ffff:a.b.c.d 或原始十六进制
ipv6_to_text() {
  local h=$1
  case "$h" in
    00000000000000000000000000000000) printf '::' ;;
    00000000000000000000000001000000) printf '::1' ;;
    0000000000000000FFFF0000*) printf '::ffff:%s' "$(hex_to_ipv4 "${h:24:8}")" ;;
    *) printf '%s' "$h" ;;
  esac
}

# 函数：判断地址是否为环回地址
# 参数：$1 可读地址
# 返回：0 表示环回，1 表示非环回
is_loopback() {
  case "$1" in
    127.*|::1|::ffff:127.*) return 0 ;;
    *) return 1 ;;
  esac
}

# 函数：解析一个 /proc/net/tcp* 文件，把 LISTEN 端口累积到全局关联数组
# 参数：$1 文件路径；$2 地址族（ipv4 / ipv6）
# 返回：无（文件不存在时直接跳过）
scan_file() {
  local file=$1 family=$2
  [[ -r "$file" ]] || return 0
  local sl local_addr rem st txrx trtm retr uid timeout inode rest addr port text
  {
    read -r _ # 跳过表头
    while read -r sl local_addr rem st txrx trtm retr uid timeout inode rest; do
      [[ "$st" == "0A" ]] || continue
      addr=${local_addr%:*}
      port=$((16#${local_addr##*:}))
      [[ "$IGNORE" == *" $port "* ]] && continue
      if [[ "$family" == "ipv4" ]]; then text=$(hex_to_ipv4 "$addr"); else text=$(ipv6_to_text "$addr"); fi
      PORT_BINDS[$port]="${PORT_BINDS[$port]:-}${PORT_BINDS[$port]:+ }$text"
      is_loopback "$text" || PORT_NONLOOP[$port]=1
      if [[ -z "${PORT_FAMILY[$port]:-}" ]]; then PORT_FAMILY[$port]=$family
      elif [[ "${PORT_FAMILY[$port]}" != "$family" ]]; then PORT_FAMILY[$port]=dual; fi
      [[ -n "${PORT_INODE[$port]:-}" || "$inode" == "0" ]] || PORT_INODE[$port]=$inode
    done
  } < "$file"
}

# 函数：建立 socket inode → pid 映射（一次 find 调用，且仅在监听集合变化时重建）
# 参数：无（读取 PORT_INODE）
# 返回：无（写入 INODE_PID）
refresh_inode_map() {
  local sig="${PORT_INODE[*]:-}"
  [[ "$sig" == "$LAST_INODE_SIG" ]] && return 0
  LAST_INODE_SIG=$sig
  INODE_PID=()
  [[ -z "$sig" ]] && return 0
  local dir link pid inode
  while read -r dir link; do
    inode=${link#socket:[}; inode=${inode%]}
    pid=${dir#"$PROC_ROOT"/}; pid=${pid%%/*}
    INODE_PID[$inode]=$pid
  done < <(find "$PROC_ROOT"/[0-9]*/fd -maxdepth 1 -lname 'socket:*' -printf '%h %l\n' 2>/dev/null)
}

# 函数：对 JSON 字符串做最小转义（进程名只可能含可打印字符）
# 参数：$1 原始字符串
# 输出：转义后的字符串
json_escape() {
  local s=${1//\\/\\\\}
  printf '%s' "${s//\"/\\\"}"
}

# 函数：执行一轮扫描并输出 ports.json 内容
# 参数：无
# 输出：JSON 文本
scan_once() {
  PORT_BINDS=(); PORT_NONLOOP=(); PORT_FAMILY=(); PORT_INODE=()
  scan_file "$PROC_NET_DIR/tcp" ipv4
  scan_file "$PROC_NET_DIR/tcp6" ipv6
  refresh_inode_map

  local first=1 port pid comm binds_json b
  printf '{"protocol":1,"updated_at":%s,"ports":[' "${EPOCHSECONDS:-$(date +%s)}"
  for port in "${!PORT_BINDS[@]}"; do
    pid=""; comm=""
    if [[ -n "${PORT_INODE[$port]:-}" ]]; then
      pid=${INODE_PID[${PORT_INODE[$port]}]:-}
      [[ -n "$pid" && -r "$PROC_ROOT/$pid/comm" ]] && read -r comm < "$PROC_ROOT/$pid/comm"
    fi
    binds_json=""
    for b in ${PORT_BINDS[$port]}; do binds_json+="${binds_json:+,}\"$b\""; done
    (( first )) || printf ','
    first=0
    printf '{"port":%d,"binds":[%s],"family":"%s","loopback_only":%s,"pid":%s,"process":%s}' \
      "$port" "$binds_json" "${PORT_FAMILY[$port]}" \
      "$([[ -n "${PORT_NONLOOP[$port]:-}" ]] && echo false || echo true)" \
      "${pid:-null}" "$([[ -n "$comm" ]] && printf '"%s"' "$(json_escape "$comm")" || echo null)"
  done
  printf ']}\n'
}

# 函数：主循环，周期写入 ports.json（原子替换）
# 参数：无
# 返回：不返回（随容器生命周期运行）
main_loop() {
  mkdir -p "$STATE_DIR"
  local target="$STATE_DIR/ports.json" tmp="$STATE_DIR/.ports.json.tmp"
  while true; do
    scan_once > "$tmp" && mv -f "$tmp" "$target"
    sleep "$INTERVAL"
  done
}

if [[ "${1:-}" == "--once" ]]; then
  scan_once
else
  main_loop
fi
