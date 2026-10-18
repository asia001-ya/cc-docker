#!/usr/bin/env bash
# =============================================================================
# tdc-switch.sh —— 命令行版"额度耗尽一键切换"（与桌面端热切换流程一致）
#
# 用法：
#   ./tdc-switch.sh <源容器> <会话ID> [目标容器]
#     会话ID：tdc 终端会话 ID（tmux 会话名去掉 tdc- 前缀，可用 `docker exec -u node <源> tdc-ctl session-list` 查看）
#     目标容器：省略时按剩余额度自动选择推荐候选
#
# 流程：
#   1. 读取全部容器快照并排序候选（tdc-lib.mjs rank）
#   2. 在源容器中优雅退出 claude（/exit → TERM → KILL），取得 Claude session_id 与 cwd
#   3. 校验目标容器存在相同 cwd（共享项目挂载）与会话文件（共享 projects 卷）
#   4. 在目标容器中以新 tdc 会话执行 `claude --resume <session_id>` 并附着到终端
#
# 可继承：Claude 对话历史、源码文件；不可继承：shell 进程、环境变量、后台进程、prompt cache。
# =============================================================================
set -euo pipefail
export MSYS_NO_PATHCONV=1
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

# 函数：打印错误并退出
# 参数：$1 错误信息
# 返回：不返回
die() {
  echo "✗ $1" >&2
  exit 1
}

# 函数：在指定容器内用 node 从 JSON 中取字段（宿主机无需 jq）
# 参数：$1 容器名；$2 JS 表达式（变量 j 为解析后的对象）；stdin 为 JSON
# 输出：表达式结果（字符串原样输出，null/undefined 输出空串）
json_get() {
  docker exec -u node -i "$1" node -e '
    let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
      const j = JSON.parse(s); const v = eval(process.argv[1]);
      process.stdout.write(v === null || v === undefined ? "" : String(v));
    });' "$2"
}

# 函数：生成新的 tdc 会话 ID（8 位十六进制）
# 参数：无
# 输出：会话 ID
new_session_id() {
  printf '%04x%04x' $RANDOM $RANDOM
}

main() {
  (( $# >= 2 )) || { sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
  local src=$1 sid=$2 dst=${3:-}
  [[ "$sid" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || die "非法会话 ID: $sid"
  [[ "$(docker inspect -f '{{.State.Running}}' "$src" 2>/dev/null)" == "true" ]] || die "源容器 $src 未运行"

  local data
  data=$("$SCRIPT_DIR/tdc-quota.sh" --raw)

  if [[ -z "$dst" ]]; then
    local ranked
    ranked=$(printf '%s\n' "$data" | docker exec -u node -i "$src" node /opt/tdc/tdc-lib.mjs rank "$src")
    dst=$(printf '%s\n' "$ranked" | json_get "$src" 'j.length ? j[0].name : ""')
    [[ -n "$dst" ]] || die "没有可用的候选容器（其他容器均已耗尽、未运行或为 API 模式）"
    echo "→ 推荐目标：$dst（$(printf '%s\n' "$ranked" | json_get "$src" 'j[0].reason')）"
  fi
  [[ "$dst" != "$src" ]] || die "目标容器不能与源容器相同"
  [[ "$(docker inspect -f '{{.State.Running}}' "$dst" 2>/dev/null)" == "true" ]] || die "目标容器 $dst 未运行"

  echo "→ 正在退出 $src 中会话 $sid 的 claude ..."
  local stop session_id cwd
  stop=$(docker exec -u node "$src" tdc-ctl session-stop "$sid" 5)
  session_id=$(printf '%s\n' "$stop" | json_get "$src" 'j.session_id')
  cwd=$(printf '%s\n' "$stop" | json_get "$src" 'j.cwd')
  echo "  退出方式：$(printf '%s\n' "$stop" | json_get "$src" 'j.method')"
  [[ -n "$session_id" ]] || die "未找到该会话的 Claude session_id（statusline 尚未刷新过，无法 --resume）"
  [[ -n "$cwd" ]] || cwd=/workspace

  docker exec -u node "$dst" test -d "$cwd" || die "目标容器中不存在目录 $cwd：两容器需挂载相同的项目路径"
  docker exec -u node "$dst" sh -c "ls \"\$CLAUDE_CONFIG_DIR\"/projects/*/$session_id.jsonl >/dev/null 2>&1" \
    || die "目标容器中找不到会话文件 $session_id.jsonl：两容器需共享 tdc_shared_projects 卷"

  local new_sid
  new_sid=$(new_session_id)
  echo "✓ 切换到 $dst（新会话 $new_sid，cwd=$cwd，resume=$session_id）"
  echo "  提示：切换后首轮请求无 prompt cache，会按完整上下文计费"
  exec docker exec -u node -it "$dst" tdc-session "$new_sid" "$cwd" claude --resume "$session_id"
}

main "$@"
