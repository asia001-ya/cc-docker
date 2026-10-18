#!/usr/bin/env bash
# =============================================================================
# tdc-session —— 统一的终端会话启动器（桌面端与 CLI 共用，保证行为一致）
#
# 用法：
#   tdc-session [-e K=V]... [--no-tmux] <会话ID> <工作目录> <模式> [参数...]
# 模式：
#   claude [claude 参数...]   以当前 provider-settings 启动 Claude Code（如 --resume <id>）
#   bash                       纯 shell
#   cmd <命令字符串>           自定义命令（bash -lc 执行）
# 行为：
#   - 默认在名为 tdc-<会话ID> 的 tmux 会话中运行；会话已存在时直接重新附着（应用重启后恢复）
#   - 会话进程带 TDC_SESSION_ID 环境变量，statusline 以此写 sessions/<会话ID>.json
#   - claude / cmd 退出后回落到交互 shell，终端不会直接关闭
# =============================================================================
set -euo pipefail

# 函数：内部执行入口（tmux 内或 --no-tmux 时调用），按模式启动实际程序
# 参数：$1 模式；其余为模式参数
# 返回：不返回（exec 替换进程）
run_inner() {
  local mode=$1; shift
  case "$mode" in
    claude)
      # claude 包装入口统一加载供应商设置，退出后在任意目录手工重启也保持一致。
      claude "$@" || true
      exec bash -l
      ;;
    cmd)
      bash -lc "$1" || true
      exec bash -l
      ;;
    bash|*)
      exec bash -l
      ;;
  esac
}

if [[ "${1:-}" == "__run" ]]; then
  shift
  run_inner "$@"
fi

env_args=()
use_tmux=1
while (( $# > 0 )); do
  case "$1" in
    -e) env_args+=(-e "$2"); shift 2 ;;
    --no-tmux) use_tmux=0; shift ;;
    *) break ;;
  esac
done

if (( $# < 3 )); then
  sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi

session_id=$1 cwd=$2 mode=$3
shift 3
if [[ ! "$session_id" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
  echo "tdc-session: 非法会话 ID: $session_id" >&2
  exit 2
fi
[[ -d "$cwd" ]] || cwd=/workspace

if (( use_tmux )); then
  # tmux ≥3.0：多参数命令按 argv 直接执行，无需额外转义
  # -D 配合 -A 在重连时替换旧客户端，避免外壳重启后多个尺寸互相干扰。
  exec tmux new-session -A -D -s "tdc-$session_id" -c "$cwd" \
    -e "TDC_SESSION_ID=$session_id" "${env_args[@]}" \
    "$0" __run "$mode" "$@"
fi

# 不使用 tmux：直接在当前 exec 中运行（应用重启后无法恢复）
export TDC_SESSION_ID="$session_id"
for kv in "${env_args[@]}"; do
  [[ "$kv" == "-e" ]] || export "${kv?}"
done
cd "$cwd"
run_inner "$mode" "$@"
