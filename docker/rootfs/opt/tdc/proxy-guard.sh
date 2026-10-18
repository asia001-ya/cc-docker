#!/usr/bin/env bash
# =============================================================================
# proxy-guard.sh —— 代理兜底规则（fail-closed）：只允许流量经 TUN 或 root 进程出站
#
# 用法（需 root；由 tdc-proxy.sh 在 flock 内调用）：
#   proxy-guard.sh apply [--allow-lan]   施加兜底：iptables TDC_GUARD 链 + 改写 resolv.conf
#   proxy-guard.sh remove                移除兜底：删除规则，还原 resolv.conf 与 hosts
#   proxy-guard.sh check [--allow-lan]   规则与 resolv.conf 均完整返回 0，否则返回 1
#   proxy-guard.sh --print [--allow-lan] 只打印规则序列，不执行（测试用）
#
# 设计要点：
#   1. 规则放在自建链 TDC_GUARD，插在 OUTPUT 第 1 条；mihomo 与 tdc 守护以 root 运行，按 uid 放行
#   2. 已建立连接只放行"回包方向"（--ctdir REPLY），即端口映射进来的连接；
#      开启代理前就存在的直连会被切断，不会继续绕过代理
#   3. 发往 127.0.0.11（Docker 内嵌 DNS）的包走 lo、永远不进 TUN，必须单独拒绝非 root，
#      并把 resolv.conf 改写为会被路由进 TUN 的地址，交给 mihomo 的 dns-hijack 处理
#   4. resolv.conf / hosts 是 Docker bind mount 的文件，只能原地覆写，不能 mv 替换
#   5. 重建规则期间先插一条屏障（拒绝全部非 root 流量），避免出现规则为空的窗口
#
# 环境变量（测试或排障时覆盖）：
#   TDC_IPTABLES / TDC_IP6TABLES  iptables 命令（默认 iptables / ip6tables）
#   TDC_TUN_DEV                   TUN 设备名（默认 tdc0，须与 mihomo 配置一致）
#   TDC_PROXY_DIR                 备份目录（默认 /var/lib/tdc/proxy）
#   TDC_RESOLV_CONF / TDC_HOSTS_FILE  默认 /etc/resolv.conf、/etc/hosts
#   TDC_PROXY_RESOLVER            改写后的 nameserver（默认 1.1.1.1）
# =============================================================================
set -uo pipefail

IPT="${TDC_IPTABLES:-iptables}"
IP6T="${TDC_IP6TABLES:-ip6tables}"
TUN_DEV="${TDC_TUN_DEV:-tdc0}"
PROXY_DIR="${TDC_PROXY_DIR:-/var/lib/tdc/proxy}"
RESOLV="${TDC_RESOLV_CONF:-/etc/resolv.conf}"
HOSTS="${TDC_HOSTS_FILE:-/etc/hosts}"
RESOLVER="${TDC_PROXY_RESOLVER:-1.1.1.1}"
CHAIN=TDC_GUARD
MARK="# tdc-proxy"
DOCKER_DNS=127.0.0.11
PRIVATE_NETS=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16)

# 函数：输出 IPv4 兜底链的规则（每行一条，不含 "-A 链名"）
# 参数：$1 是否放行私有网段（1 / 0）
# 输出：规则参数序列
rule_specs_v4() {
  local allow_lan=$1 net
  echo "-o lo -d $DOCKER_DNS -m owner ! --uid-owner 0 -j REJECT"
  echo "-o lo -j RETURN"
  echo "-m conntrack --ctstate ESTABLISHED,RELATED --ctdir REPLY -j RETURN"
  echo "-o $TUN_DEV -j RETURN"
  echo "-m owner --uid-owner 0 -j RETURN"
  if (( allow_lan )); then
    # 私有网段放行，但其中的 53 端口仍拒绝，防止经局域网 DNS 泄露
    for net in "${PRIVATE_NETS[@]}"; do
      echo "-d $net -p udp --dport 53 -j REJECT"
      echo "-d $net -p tcp --dport 53 -j REJECT"
    done
    for net in "${PRIVATE_NETS[@]}"; do echo "-d $net -j RETURN"; done
  fi
  echo "-j REJECT"
}

# 函数：输出 IPv6 兜底链的规则（容器已用 sysctl 关闭 IPv6，这里是冗余防线）
# 参数：无
# 输出：规则参数序列
rule_specs_v6() {
  echo "-o lo -j RETURN"
  echo "-m owner --uid-owner 0 -j RETURN"
  echo "-j REJECT"
}

# 函数：解析 --allow-lan 参数
# 参数：$@ 命令行剩余参数
# 输出：1 或 0
parse_allow_lan() {
  local a
  for a in "$@"; do [[ "$a" == "--allow-lan" ]] && { echo 1; return; }; done
  echo 0
}

# 函数：按规则序列重建指定链并挂到 OUTPUT 第 1 条
# 参数：$1 iptables 命令；$2 规则生成函数名；其余为生成函数参数
# 返回：0 成功，非 0 失败
build_chain() {
  local ipt=$1 gen=$2; shift 2
  local spec
  "$ipt" -N "$CHAIN" 2>/dev/null || "$ipt" -F "$CHAIN" || return 1
  while IFS= read -r spec; do
    # shellcheck disable=SC2086  # 规则由本脚本生成，按空格拆分是预期行为
    "$ipt" -A "$CHAIN" $spec || return 1
  done < <("$gen" "$@")
  "$ipt" -C OUTPUT -j "$CHAIN" 2>/dev/null || "$ipt" -I OUTPUT 1 -j "$CHAIN"
}

# 函数：删除指定 iptables 的兜底链（不存在时静默）
# 参数：$1 iptables 命令
# 返回：无
drop_chain() {
  local ipt=$1
  while "$ipt" -D OUTPUT -j "$CHAIN" 2>/dev/null; do :; done
  "$ipt" -F "$CHAIN" 2>/dev/null
  "$ipt" -X "$CHAIN" 2>/dev/null
  return 0
}

# 函数：插入 / 移除屏障规则（重建期间拒绝全部非 root 流量）
# 参数：$1 add / del
# 返回：无
barrier() {
  local op=-I
  [[ "$1" == "del" ]] && op=-D
  if [[ "$op" == "-I" ]]; then
    "$IPT" -I OUTPUT 1 -m owner ! --uid-owner 0 -j REJECT 2>/dev/null
  else
    while "$IPT" -D OUTPUT -m owner ! --uid-owner 0 -j REJECT 2>/dev/null; do :; done
  fi
}

# 函数：原地覆写文件（bind mount 文件不能 mv 替换）
# 参数：$1 目标文件；stdin 为新内容
# 返回：写入结果
overwrite_in_place() {
  local content
  content=$(cat)
  printf '%s\n' "$content" > "$1"
}

# 函数：改写 resolv.conf 为 TUN 内可劫持的地址（已改写过则跳过），原文件备份到代理目录
# 参数：无
# 返回：无
rewrite_resolv() {
  grep -q "$MARK" "$RESOLV" 2>/dev/null && return 0
  cp -f "$RESOLV" "$PROXY_DIR/resolv.conf.orig" 2>/dev/null
  printf 'nameserver %s %s\noptions timeout:2 attempts:2\n' "$RESOLVER" "$MARK" | overwrite_in_place "$RESOLV"
}

# 函数：还原 resolv.conf（仅当当前内容是本脚本写入的）
# 参数：无
# 返回：无
restore_resolv() {
  if grep -q "$MARK" "$RESOLV" 2>/dev/null && [[ -f "$PROXY_DIR/resolv.conf.orig" ]]; then
    overwrite_in_place "$RESOLV" < "$PROXY_DIR/resolv.conf.orig"
  fi
  rm -f "$PROXY_DIR/resolv.conf.orig"
}

# 函数：删除 hosts 中本脚本注入的行
# 参数：无
# 返回：无
strip_hosts() {
  grep -q "$MARK" "$HOSTS" 2>/dev/null || return 0
  grep -v "$MARK" "$HOSTS" | overwrite_in_place "$HOSTS"
}

# 函数：用当前（未改写的）解析器解析 host.docker.internal 并写入 hosts，
#       开启代理后 DNS 被劫持为 fake-ip，必须在改写 resolv.conf 之前完成。
#       无论是否允许局域网都注入：mihomo 拨号 SOCKS5 节点（如宿主上的 v2rayN）时只能经 hosts 解析该域名；
#       普通进程能否连过去仍由兜底规则决定（未允许局域网时私有网段一律拒绝）
# 参数：无
# 返回：无（解析不到时静默跳过，非 Docker Desktop 环境没有该域名）
inject_hosts() {
  local ip
  ip=$(getent ahostsv4 host.docker.internal 2>/dev/null | awk 'NR==1{print $1}')
  [[ -n "$ip" ]] || return 0
  # 只接受私有地址，防止误把 fake-ip 写进去
  case "$ip" in 10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) ;; *) return 0 ;; esac
  printf '%s\n%s host.docker.internal %s\n' "$(cat "$HOSTS")" "$ip" "$MARK" | overwrite_in_place "$HOSTS"
}

# 函数：施加兜底（屏障 → 清理旧状态 → 注入 hosts → 建链 → 改写 resolv.conf → 撤屏障）
# 参数：$1 是否放行私有网段（1 / 0）
# 返回：0 成功；失败时保留屏障（宁可断网）并返回 1
cmd_apply() {
  local allow_lan=$1
  mkdir -p "$PROXY_DIR"
  barrier add || { echo "proxy-guard: 无法插入屏障规则（iptables 不可用？）" >&2; return 1; }
  restore_resolv
  strip_hosts
  inject_hosts
  if ! build_chain "$IPT" rule_specs_v4 "$allow_lan"; then
    echo "proxy-guard: 建立 $CHAIN 失败，保留屏障（网络保持断开）" >&2
    return 1
  fi
  build_chain "$IP6T" rule_specs_v6 2>/dev/null || true
  rewrite_resolv
  barrier del
  return 0
}

# 函数：移除兜底并还原 DNS 配置
# 参数：无
# 返回：0
cmd_remove() {
  barrier del
  drop_chain "$IPT"
  drop_chain "$IP6T"
  restore_resolv
  strip_hosts
  return 0
}

# 函数：检查兜底是否完整（链已挂载、规则条数正确、resolv.conf 已改写）
# 参数：$1 是否放行私有网段（1 / 0）
# 返回：0 完整，1 不完整
cmd_check() {
  local allow_lan=$1 expected actual
  "$IPT" -C OUTPUT -j "$CHAIN" 2>/dev/null || return 1
  expected=$(rule_specs_v4 "$allow_lan" | wc -l)
  actual=$("$IPT" -S "$CHAIN" 2>/dev/null | grep -c '^-A ')
  (( expected == actual )) || return 1
  grep -q "$MARK" "$RESOLV" 2>/dev/null
}

case "${1:-}" in
  apply) shift; cmd_apply "$(parse_allow_lan "$@")" ;;
  remove) cmd_remove ;;
  check) shift; cmd_check "$(parse_allow_lan "$@")" ;;
  --print)
    shift
    rule_specs_v4 "$(parse_allow_lan "$@")" | sed "s/^/iptables -A $CHAIN /"
    rule_specs_v6 | sed "s/^/ip6tables -A $CHAIN /"
    ;;
  *)
    sed -n '4,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
