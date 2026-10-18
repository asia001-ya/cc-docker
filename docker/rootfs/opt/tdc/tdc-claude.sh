#!/usr/bin/env bash
# 容器内统一的 claude 入口：每次启动都读取当前供应商设置，不依赖工作目录或父 shell。
# npm 安装的原始入口由 Dockerfile 保留为同一 bin 目录下的 tdc-claude-real。
set -euo pipefail

export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/home/node/.claude}"

# 经典界面在长回答重绘 / 改变宽度时会把旧画面写进 tmux 历史。
# 默认使用全屏渲染，由 Claude 管理对话滚动；显式环境变量仍可选择经典模式。
export CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN="${CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN:-0}"
export CLAUDE_CODE_NO_FLICKER="${CLAUDE_CODE_NO_FLICKER:-1}"

# A running container may receive a new provider binding while its current
# Claude process is still using the old settings.  Promote that binding only
# when a new Claude process is actually about to start; otherwise usage records
# from the old process could be priced or attributed to the new provider.
activate_pending_usage_snapshot() {
  local pending="$CLAUDE_CONFIG_DIR/tdc/usage-provider.pending.json"
  local active="$CLAUDE_CONFIG_DIR/tdc/usage-provider.json"
  if [[ -f "$pending" ]]; then
    if mv -f -- "$pending" "$active"; then
      # The pending file's mtime is the write time of the UI action.  The active
      # mtime is the capture boundary, so refresh it at this process boundary.
      touch -- "$active" || true
    fi
  fi
}

explicit_settings=0
explicit_mcp=0
# 各类显式配置独立生效；-- 之后的内容属于用户输入。
for arg in "$@"; do
  case "$arg" in
    --) break ;;
    --settings|--settings=*) explicit_settings=1 ;;
    --mcp-config|--mcp-config=*|--strict-mcp-config) explicit_mcp=1 ;;
  esac
done

# Explicit settings bypass the managed provider snapshot, so leave a pending
# app snapshot for the next invocation that uses the default settings.
if (( ! explicit_settings )); then activate_pending_usage_snapshot; fi

settings_args=()
provider_settings="$CLAUDE_CONFIG_DIR/tdc/provider-settings.json"
if (( ! explicit_settings )) && [[ -f "$provider_settings" ]]; then
  settings_args=(--settings "$provider_settings")
fi

mcp_settings=/var/lib/tdc/host-config/mcp.json
args=("${settings_args[@]}")
inject_mcp=0
if (( ! explicit_mcp )) && [[ -f "$mcp_settings" && -r "$mcp_settings" ]]; then inject_mcp=1; fi
for arg in "$@"; do
  # --mcp-config 为变长参数：放在末尾或 -- 前，避免将用户的裸 prompt 当配置路径。
  if [[ "$arg" == "--" ]] && (( inject_mcp )); then
    args+=("--mcp-config=$mcp_settings")
    inject_mcp=0
  fi
  args+=("$arg")
done
if (( inject_mcp )); then args+=("--mcp-config=$mcp_settings"); fi

# 只传配置路径，凭据不进入命令行；exec 保留退出码和信号处理。
exec tdc-claude-real "${args[@]}"
