#!/usr/bin/env bash
# =============================================================================
# entrypoint-user.sh —— 容器入口的用户阶段（以 node 身份运行，由 entrypoint.sh 降权后 exec）
#   1. 初始化配置目录、状态目录与默认 provider-settings（订阅模式）
#   2. 链接共享记忆（CLAUDE.md / skills / commands / agents）
#   3. 后台启动 portwatch 端口监听守护
#   4. exec 执行 CMD（默认 sleep infinity，由 tini 负责信号转发与僵尸回收）
# =============================================================================
set -euo pipefail

: "${CLAUDE_CONFIG_DIR:=/home/node/.claude}"
: "${TDC_STATE_DIR:=/home/node/.claude/tdc/state}"

# 函数：确保运行所需目录存在
# 参数：无
# 返回：无
init_dirs() {
  mkdir -p "$CLAUDE_CONFIG_DIR/projects" "$CLAUDE_CONFIG_DIR/tdc" "$TDC_STATE_DIR/sessions"
}

# 函数：首次启动时写入默认 provider-settings（空 env = 使用订阅登录凭证）
# 参数：无
# 返回：无
init_provider_settings() {
  local file="$CLAUDE_CONFIG_DIR/tdc/provider-settings.json"
  if [[ ! -f "$file" ]]; then
    printf '{\n  "env": {}\n}\n' > "$file"
  fi
  chmod 600 "$file" 2>/dev/null || true
}

# 函数：写入容器元信息，桌面端用于校验镜像协议版本
# 参数：无
# 返回：无
write_meta() {
  local claude_version
  claude_version=$(claude --version 2>/dev/null | head -n1 || true)
  printf '{"protocol":1,"container":"%s","started_at":%s,"claude_version":"%s"}\n' \
    "${TDC_CONTAINER_NAME:-$(hostname)}" "${EPOCHSECONDS:-$(date +%s)}" "${claude_version//\"/}" \
    > "$TDC_STATE_DIR/meta.json"
}

init_dirs
init_provider_settings
/opt/tdc/tdc-ctl.sh link-shared || true
write_meta || true

# 端口守护随容器生命周期运行；退出时由 tini 一并回收
/opt/tdc/portwatch.sh &

exec "$@"
