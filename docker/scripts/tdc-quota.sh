#!/usr/bin/env bash
# =============================================================================
# tdc-quota.sh —— 在宿主机（Git Bash / WSL / Linux）上查看全部 tdc 容器的 Claude 额度
#
# 用法：
#   ./tdc-quota.sh            表格输出
#   ./tdc-quota.sh --json     JSON 输出（含健康度与剩余百分比）
#   ./tdc-quota.sh --raw      输出原始容器快照数组（供 tdc-switch.sh 复用）
#
# 原理：枚举 label tdc.managed=true 的容器 → 对运行中的容器执行 `tdc-ctl snapshot`
#       → 交给任一运行中容器内的 /opt/tdc/tdc-lib.mjs 计算（宿主机无需安装 Node / jq）
# 注意：额度数据只在容器内 claude 运行、statusline 刷新时更新，空闲容器显示的是上次已知值。
# =============================================================================
set -euo pipefail
export MSYS_NO_PATHCONV=1  # 防止 Git Bash 把 /opt/tdc/... 改写成 Windows 路径

# 函数：检查 docker CLI 与引擎是否可用
# 参数：无
# 返回：不可用时打印中文提示并退出 1
require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "未找到 docker 命令，请先安装 Docker Desktop（WSL2 后端）" >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "Docker 引擎未就绪，请启动 Docker Desktop" >&2
    exit 1
  fi
}

# 函数：收集全部 tdc 容器的快照，拼成 JSON 数组
# 参数：无
# 输出：[{"name":..,"running":..,"snapshot":..}, ...]
collect_snapshots() {
  local first=1 name state snap
  printf '['
  while IFS=$'\t' read -r name state; do
    [[ -n "$name" ]] || continue
    snap=null
    if [[ "$state" == "running" ]]; then
      snap=$(docker exec -u node "$name" tdc-ctl snapshot 2>/dev/null | tail -n 1) || snap=null
      [[ "$snap" == \{* ]] || snap=null
    fi
    (( first )) || printf ','
    first=0
    printf '{"name":"%s","running":%s,"snapshot":%s}' "$name" \
      "$([[ "$state" == "running" ]] && echo true || echo false)" "$snap"
  done < <(docker ps -a --filter label=tdc.managed=true --format $'{{.Names}}\t{{.State}}' | sort)
  printf ']\n'
}

# 函数：找到一个运行中的 tdc 容器，用于执行 tdc-lib.mjs
# 参数：无
# 输出：容器名；没有运行中的容器时输出空串
pick_runner() {
  docker ps --filter label=tdc.managed=true --format '{{.Names}}' | sort | head -n 1
}

# 函数：调用 tdc-lib.mjs（优先容器内执行，没有运行中容器时回退宿主机 node）
# 参数：$@ 传给 tdc-lib.mjs 的子命令与参数；stdin 为容器数组 JSON
# 返回：tdc-lib.mjs 的退出码
run_lib() {
  local runner
  runner=$(pick_runner)
  if [[ -n "$runner" ]]; then
    docker exec -u node -i "$runner" node /opt/tdc/tdc-lib.mjs "$@"
  elif command -v node >/dev/null 2>&1; then
    node "$(dirname "$0")/../rootfs/opt/tdc/tdc-lib.mjs" "$@"
  else
    echo "没有运行中的 tdc 容器，宿主机也未安装 node，无法计算额度" >&2
    return 1
  fi
}

main() {
  require_docker
  local data
  data=$(collect_snapshots)
  case "${1:-}" in
    --raw) printf '%s\n' "$data" ;;
    --json) printf '%s\n' "$data" | run_lib table --json ;;
    "") printf '%s\n' "$data" | run_lib table ;;
    *) sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
  esac
}

main "$@"
