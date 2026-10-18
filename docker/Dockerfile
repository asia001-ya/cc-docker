# =============================================================================
# tdc/claude-dev —— Claude 多容器终端管理器的标准运行镜像
#
# 构建：桌面端首次启动时经 Docker API 构建（构建上下文随应用内置，经典构建器）；
#       也可手动 docker build。只用经典构建器支持的语法，不声明 syntax，避免额外拉取 dockerfile 前端镜像
#
# 设计要点：
#   1. 真彩：TERM=xterm-256color + COLORTERM=truecolor，tmux 通过 RGB 特性透传 24-bit 色；
#      CLAUDE_CODE_TMUX_TRUECOLOR=1 阻止 Claude Code 在 tmux 中自动降为 256 色
#   2. 会话持久化：tmux 只做"断线重连"，前缀键禁用、状态栏关闭，对用户不可见
#   3. 额度采集：managed-settings 强制 statusLine → statusline.mjs → $TDC_STATE_DIR/quota.json
#   4. 端口检测：portwatch.sh 常驻，扫描 /proc/net/tcp* → $TDC_STATE_DIR/ports.json
#   5. 凭证隔离：CLAUDE_CONFIG_DIR=/home/node/.claude 整体放入每容器独立的命名卷
#      （.claude.json 也随之落在该目录内），projects 子目录再嵌套挂载共享卷
#   6. 代理：mihomo + TUN，兜底规则由 root 施加（详见 docs/06-proxy.md）。
#      进程链为 tini → entrypoint.sh(root) → setpriv 降权 → entrypoint-user.sh(node)，
#      交互进程一律以 node 运行；桌面端与脚本的 docker exec 均显式指定用户
# =============================================================================
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

# Claude Code 版本由镜像锁定（容器内禁用自动更新），升级时改此参数重建镜像
ARG CLAUDE_CODE_VERSION=2.1.300
ARG TZ=Asia/Shanghai
# mihomo 版本锁定：桌面端生成的配置依赖其字段，升级时需同步核对 src-tauri/src/proxy/render.rs
ARG MIHOMO_VERSION=v1.19.32
ARG MIHOMO_SHA256_AMD64=ba3ce607747a07f948fc35780e108a4a7c7f552a38b9bd4d115f313ebcb89c20
ARG MIHOMO_SHA256_ARM64=9dd862e28b46ff7d775f169cceebc28deccaa0a9e804237d421cd2571e0caba0
# 下载地址前缀；国内构建可替换为镜像站（文件名与 sha256 不变）
ARG MIHOMO_BASE_URL=https://github.com/MetaCubeX/mihomo/releases/download
ARG TARGETARCH

ENV TERM=xterm-256color \
    COLORTERM=truecolor \
    CLAUDE_CODE_TMUX_TRUECOLOR=1 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=${TZ} \
    SHELL=/bin/bash \
    EDITOR=vim \
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    DISABLE_AUTOUPDATER=1 \
    TDC_HOME=/home/node/.tdc \
    TDC_STATE_DIR=/home/node/.claude/tdc/state \
    TDC_SHARED_DIR=/home/node/.claude-shared

# 基础工具：tmux（会话持久化）、ncurses-term（tmux-256color terminfo）、tini（PID 1 信号转发）、
#           iproute2 / iptables（代理 TUN 与兜底规则）
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       tmux ncurses-term tini git jq curl ca-certificates ripgrep procps less \
       vim-tiny openssh-client tzdata unzip iproute2 iptables \
    && ln -sf /usr/bin/vim.tiny /usr/local/bin/vim \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force

# mihomo：Go 静态二进制；amd64 用 compatible 构建（不要求 AVX 等新指令集）。
# 经典构建器不注入 TARGETARCH，此时按基础镜像的 dpkg 架构判断。
# 末尾确认 util-linux 的 setpriv / flock / setsid 可用（入口降权与代理脚本依赖）
RUN set -eu; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) asset="mihomo-linux-amd64-compatible-${MIHOMO_VERSION}.gz"; sum="${MIHOMO_SHA256_AMD64}" ;; \
      arm64) asset="mihomo-linux-arm64-${MIHOMO_VERSION}.gz"; sum="${MIHOMO_SHA256_ARM64}" ;; \
      *) echo "不支持的架构: ${arch}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 -o /tmp/mihomo.gz "${MIHOMO_BASE_URL}/${MIHOMO_VERSION}/${asset}"; \
    echo "${sum}  /tmp/mihomo.gz" | sha256sum -c -; \
    gunzip -c /tmp/mihomo.gz > /usr/local/bin/mihomo; \
    chmod 0755 /usr/local/bin/mihomo; \
    rm -f /tmp/mihomo.gz; \
    /usr/local/bin/mihomo -v; \
    command -v setpriv flock setsid

# Xray 内核在构建时内置（tdc.xray 标签），容器运行时不下载；二进制下载后必须校验 sha256。
COPY rootfs/opt/tdc/xray-release.json rootfs/opt/tdc/tdc-install-xray.sh /opt/tdc/
RUN bash /opt/tdc/tdc-install-xray.sh

# 区域选项与桌面表单共用，预生成 UTF-8 locale，容器启动时不需要下载语言包。
COPY rootfs/opt/tdc/region-options.json /opt/tdc/region-options.json
RUN apt-get update \
    && apt-get install -y --no-install-recommends locales \
    && node -e 'const o=require("/opt/tdc/region-options.json"); console.log(o.locales.filter(l=>l.value!=="C.UTF-8").map(l=>l.value+" UTF-8").join("\n"))' > /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/*

COPY tmux.conf /etc/tmux.conf
COPY rootfs/ /

# 保留 npm 的原始入口（相对 symlink 仍位于同一目录），让所有 claude 调用加载供应商设置。
# 包括 tdc-session、退出后手工重启、纯 shell 与自定义命令。
RUN mv /usr/local/bin/claude /usr/local/bin/tdc-claude-real \
    && ln -s /opt/tdc/tdc-claude.sh /usr/local/bin/claude

# 预建目录并交给 node 用户：命名卷首次挂载时会继承镜像中的属主与权限。
# 代理目录放在容器层（不是卷）且仅 root 可读：订阅地址与节点密钥不暴露给 node 进程
RUN chmod 0755 /opt/tdc/*.sh /opt/tdc/*.mjs \
    && ln -sf /opt/tdc/tdc-ctl.sh /usr/local/bin/tdc-ctl \
    && ln -sf /opt/tdc/tdc-session.sh /usr/local/bin/tdc-session \
    && mkdir -p /workspace /home/node/.claude/projects /home/node/.claude/tdc \
                /home/node/.claude/tdc/state/sessions /home/node/.claude-shared \
    && chown -R node:node /workspace /home/node \
    && install -d -m 0755 /var/lib/tdc \
    && install -d -o root -g node -m 0750 /var/lib/tdc/host-config \
    && install -d -m 0700 /var/lib/tdc/proxy /var/lib/tdc/proxy/providers

# 不设置 USER：入口需要 root 施加代理兜底规则，随后由 entrypoint.sh 降权为 node。
# Claude Code 拒绝以 root 运行 --dangerously-skip-permissions，交互进程必须保持 node 身份，
# 因此 docker exec 一律带 -u node（代理控制命令带 -u root）
WORKDIR /workspace

# portwatch 每 3 秒刷新一次 ports.json，超过 30 秒未刷新视为不健康
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD /opt/tdc/tdc-ctl.sh health || exit 1

LABEL tdc.image="claude-dev" \
      tdc.protocol="1" \
      tdc.proxy="1" \
      tdc.xray="1" \
      tdc.locales="1" \
      tdc.host_config="1"

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/tdc/entrypoint.sh"]
CMD ["sleep", "infinity"]
