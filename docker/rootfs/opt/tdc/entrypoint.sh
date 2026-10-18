#!/usr/bin/env bash
# =============================================================================
# entrypoint.sh —— 容器入口的 root 阶段（PID 1 为 tini，本脚本以 root 运行）
#   1. 恢复代理：intent 已启用时先施加兜底规则再启动 mihomo，保证任何用户进程启动前网络已受控
#   2. 后台启动代理守护（内核崩溃重启、兜底自愈、写 proxy-status.json）
#   3. 降权为 node 后 exec 用户阶段 entrypoint-user.sh
#
# 为什么 PID 1 要是 root：TUN 与 iptables 需要 NET_ADMIN，而 Docker 的 --cap-add 对非 root
# 进程只进入 bounding set、不生效；若改用 setcap 给 iptables 授权，容器内任何进程都能一句
# `iptables -F` 拆掉兜底。因此由 root 施加规则，交互进程（claude、终端会话）一律以 node 运行，
# 桌面端所有 docker exec 都显式指定 user=node。
# =============================================================================
set -uo pipefail

APP_USER="${TDC_APP_USER:-node}"

# 同目录保留 npm 相对链接，兼容旧镜像补入包装脚本；绝不把 wrapper 备份成真实 CLI。
install_claude_launcher() {
  local cli=/usr/local/bin/claude real=/usr/local/bin/tdc-claude-real wrapper=/opt/tdc/tdc-claude.sh
  if [[ ! -e "$real" && ! -L "$real" ]]; then
    [[ -x "$cli" && "$(readlink -f "$cli")" != "$(readlink -f "$wrapper")" ]] || return 1
    mv -- "$cli" "$real" || return 1
  fi
  [[ -x "$real" && "$(readlink -f "$real")" != "$(readlink -f "$wrapper")" ]] || return 1
  ln -sfn -- "$wrapper" "$cli"
}

if (( EUID == 0 )); then
  install_claude_launcher || echo "entrypoint: Claude 包装入口初始化失败" >&2
  node /opt/tdc/tdc-host-config.mjs prepare-mcp "$(id -g "$APP_USER")" \
    || echo "entrypoint: 宿主 MCP 配置不可用，未修改宿主源文件" >&2
  # 同步系统时区；TZ 环境变量也会被 docker exec 与新建 tmux 会话继承。
  if [[ "${TZ:-}" =~ ^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$ && -f "/usr/share/zoneinfo/$TZ" ]]; then
    ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime
    printf '%s\n' "$TZ" > /etc/timezone
  fi
  /opt/tdc/tdc-proxy.sh restore || echo "entrypoint: 代理恢复失败，详见 tdc-ctl proxy-status" >&2
  /opt/tdc/tdc-proxy.sh daemon &
  # Dockerfile 未设置 HOME，降权后必须显式指定，否则会沿用 root 的 /root
  exec setpriv --reuid="$APP_USER" --regid="$APP_USER" --init-groups \
    env HOME="/home/$APP_USER" USER="$APP_USER" LOGNAME="$APP_USER" \
    /opt/tdc/entrypoint-user.sh "$@"
fi

# 以非 root 启动（例如 docker run --user node）：跳过代理，容器照常可用
echo "entrypoint: 未以 root 启动，代理功能不可用" >&2
exec /opt/tdc/entrypoint-user.sh "$@"
