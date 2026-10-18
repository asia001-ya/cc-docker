# 06 · 容器内代理（mihomo + TUN + 失败即断网）

> 交付物 6。实现：容器侧 `docker/rootfs/opt/tdc/{tdc-proxy.sh,proxy-guard.sh,tdc-proxy-lib.mjs,entrypoint.sh,entrypoint-user.sh}`，
> 桌面端 `src-tauri/src/proxy/`、`src-tauri/src/commands/proxy_cmds.rs`，
> 前端 `src/components/modals/{ProxyModal,ProxyNodesPane}.tsx`。

## 1. 目标与限制

每个容器可单独开关代理。开启后：
- 容器内**全部流量**经 TUN 交给 mihomo 转发到节点（不只是认 `HTTP_PROXY` 的程序）；
- **DNS 不泄露**：所有 53 端口查询被劫持到 mihomo，目标域名在节点远端解析；
- **失败即断网**：内核崩溃、节点不可用、兜底规则被删时，容器宁可断网也不回退直连。

节点必填，可以是 **HTTP(S) 订阅链接**（Clash YAML 或 base64 分享链接列表，均已实测）、**单条 vless 链接**或 **SOCKS5**（分字段录入）；
可选再设一个**静态中转**（必须是单条 vless）和一个**出口**（必须是 SOCKS5），完整链路为 `静态中转 → 节点 → 出口 → 目标`。

- 出口用于固定落地 IP（住宅 / 静态 IP）：目标看到的是出口 IP。出口以 `dialer-proxy: NODE` 引用节点组，订阅里切换节点后仍生效；出口不转发 UDP（QUIC 自动回退 TCP）。
- SOCKS5 作主节点可指向宿主上的代理软件（主机填 `host.docker.internal`，如 v2rayN 的 10808），用于 mihomo 连不上的节点（见限制 8）。此时容器代理依赖宿主软件持续运行，它退出容器即断网。

**限制（必须让用户知道）：**
1. **容器名服务发现失效**：开启代理后 Docker 内嵌 DNS（127.0.0.11）对 node 进程不可达，容器间需用 IP 互访。这是"DNS 不泄露"的代价。
2. **节点域名的引导解析**：节点 / 订阅域名本身需要先解析，走直连 DoH（`223.5.5.5`、`1.12.12.12`）。ISP 看不到内容，但 DoH 服务商能看到"本机解析了哪个节点域名"。目标域名不经过这一路。
3. **兜底防的是容器内普通进程，不防操作者**：`docker exec -u root` 仍可拆掉规则（守护会在 3 秒内自愈）。
4. **代理能力只能在创建容器时授予**（NET_ADMIN + `/dev/net/tun` + 关闭 IPv6），已有容器需重建（凭证卷保留，终端会话会断开）。
5. **订阅节点手动选择**：选中的节点不可用时容器断网，不会自动换节点。
6. 开启代理时默认**禁止直连宿主与局域网**；可按容器放开（私有网段放行，但其中的 53 端口仍拒绝）。
7. 不做分流：全部流量走节点，不写 GEOIP / GEOSITE 规则。
8. **mihomo 连不上 Xray ≥ 26.7.11 且未设 `minClientVer` 的 REALITY 服务端**（报 `REALITY authentication failed`）：mihomo 握手中的客户端版本写死为 1.8.2，Xray 26.7.11 起未设置时默认要求 ≥ 26.3.27；上游明确不修（MetaCubeX/mihomo #2967、#3193）。
   解决：服务端 REALITY 设置 `"minClientVer": "1.8.2"`（2026-10-17 本地 Xray 26.7.11 实测有效，开启 mldsa65Seed 也不影响）；无法改服务端时用 SOCKS5 主节点指向宿主 Xray 客户端。
   Xray ≥ 26.9.8 还要求 X25519MLKEM768 密钥交换（据上游 issue，未实测）。
9. **Xray 内核由镜像内置、按节点选择**：内核是节点属性（设置 → 代理节点 → 编辑），主节点决定整条链路的内核，静态中转与出口跟随。Xray 二进制只在镜像构建时安装（`tdc.xray` 标签），容器运行时不下载；镜像未内置时桌面端在应用 / 自检 / 新建前直接拒绝，需重建镜像与容器。旧版 `proxies.json` 中绑定上的 `engine: "xray"` 加载时迁移到其主节点。
   从 mihomo 切到 Xray 时旧 TUN 仍接管 root 流量（mihomo 模式不排除 uid 0），旧节点不通会导致订阅拉取失败；`tdc-proxy.sh` 的 `with_root_bypass` 在拉取订阅期间临时加 `ip rule priority 8990 uidrange 0-0 lookup main`，结束即删，node 用户仍被兜底拦截（2026-10-18 用坏节点 + 运行中 mihomo 复现并验证）。

## 2. 关键设计决策

| 决策 | 选择 | 理由 / 放弃的方案 |
|---|---|---|
| 内核 | mihomo v1.19.32（锁定版本 + sha256） | 原生 `proxy-providers` 吃订阅、`dialer-proxy` 做链式。放弃官方 sing-box：不读订阅链接 |
| 权限模型 | PID 1 链路：tini → `entrypoint.sh`(root) → `setpriv` 降权 → `entrypoint-user.sh`(node)；桌面端所有 exec 显式 `user` | `--cap-add` 对非 root 只进 bounding set 不生效；若给 iptables 打 setcap，容器内任何进程一句 `iptables -F` 就能拆兜底 |
| 配置位置 | `/var/lib/tdc/proxy`（容器层、root 0700） | 命名卷只在首次创建时从镜像初始化，已有卷看不到新目录（写入会 404）；0700 让 node 读不到订阅地址与节点 uuid |
| 期望状态 | 桌面端 `proxies.json` + 容器内 `intent.json` 两份 | Docker Desktop 重启时桌面端可能没运行，容器靠 intent 自行恢复 |
| 配置格式 | Rust 生成 JSON（YAML 1.2 子集） | 不引入 YAML 依赖；`mihomo -t` 实测可读 |
| 兜底 | iptables `TDC_GUARD` 链 + 改写 `resolv.conf` | 只靠 `strict-route` 时内核一死，Docker 原默认路由仍在，流量会直连 |
| DNS | fake-ip + `dns-hijack: [any:53, tcp://any:53]` + `respect-rules` | 实测：不改 `resolv.conf` 时查询走 lo 到 127.0.0.11，根本不进 TUN，会泄露 |
| 不开 `auto-redirect` | — | 它会自建 iptables/nft 规则，与 `TDC_GUARD` 及 Docker 的 DNAT 冲突 |
| 静态中转 | 显式 `proxies:` 条目；订阅节点用 `override.dialer-proxy` | `dialer-proxy` 不能引用 provider 里的节点 |
| 出口 | 显式条目 `EXIT`（socks5，`dialer-proxy: NODE`），规则改为 `MATCH,EXIT` | 引用节点组而非具体节点：订阅切换节点后出口仍生效；测延迟 / 选节点仍只作用于 NODE |
| SOCKS5 录入 | 前端分字段表单 → 规范链接 `socks5://user:pass@host:port`（URL 编码）存凭据管理器 | 后端只认一种格式，严格解析；摘要不含用户名与密码 |
| host.docker.internal | 开启代理时**总是**写入 /etc/hosts（不再只在 allow_lan 时） | DNS 被改写后 mihomo 只能经 hosts 解析它；普通进程能否连接仍由兜底规则决定 |
| 节点选择 | 手动，`store-selected` + intent 记住 | 用户决策 |

## 3. 运行时结构

```
桌面端                                                 容器（root 进程 | node 进程）
ProxyStore ── render ──► write_file_owned(uid 0) ──►  /var/lib/tdc/proxy/config.yaml, intent.json（0600）
           ── tdc_ctl_root proxy-apply ──────────►   tdc-proxy.sh apply（flock 串行）
                                                        ├ mihomo -t 校验（失败不动网络）
                                                        ├ proxy-guard.sh apply → TDC_GUARD + resolv.conf
                                                        ├ 停旧内核 / 清残留 tdc0 → setsid mihomo（关闭 fd 9）
                                                        └ 选中节点 → 自检（以 node 身份探测）
Poller ── tdc_ctl snapshot（node）◄──────────────────  /var/lib/tdc/proxy-status.json（0644）
                                                     tdc-proxy.sh daemon（每 3 秒）
                                                        ├ 兜底缺失 → 重新施加
                                                        ├ 内核退出 → 重启（退避 5→60 秒）
                                                        └ 采集事实 → tdc-proxy-lib.mjs 分类 → 写状态
```

### 兜底规则（`proxy-guard.sh --print` 可查看）

```
-o lo -d 127.0.0.11 -m owner ! --uid-owner 0 -j REJECT   # 非 root 不能直连 Docker 内嵌 DNS
-o lo -j RETURN
-m conntrack --ctstate ESTABLISHED,RELATED --ctdir REPLY -j RETURN   # 只放行回包（端口映射）
-o tdc0 -j RETURN                                        # 交给 TUN
-m owner --uid-owner 0 -j RETURN                         # mihomo 与 tdc 守护
[allow_lan] 私有网段 53 端口 REJECT，其余 RETURN       # 未开启时私有网段（含 host.docker.internal）一律拒绝
-j REJECT
```
重建规则期间先插一条"拒绝全部非 root"的屏障，避免出现规则为空的窗口；施加失败时保留屏障（宁可断网）。

## 4. 状态文件 proxy-status.json（协议 1）

```json
{
  "protocol": 1, "updated_at": 1792212658,
  "state": "ok",
  "enabled": true, "allow_lan": false, "guard": true, "tun": true,
  "core_pid": 123, "restarts": 0,
  "selected": "香港 01",
  "providers": [{ "name": "sub", "count": 42, "updated_at": 1792212658 }],
  "warnings": [],
  "last_error": null
}
```

| state | 条件 | UI |
|---|---|---|
| `off` | 未启用且无兜底 | 灰（直连） |
| `starting` | 内核启动 15 秒内 TUN 未就绪 | 黄（此期间不通） |
| `ok` | 内核 + TUN + 兜底完整 | 绿 |
| `blackhole` | 兜底在但内核或 TUN 不在 | 红：已断网 |
| `leak` | 已启用但兜底缺失 | 红：可能泄露（守护会立即自愈） |

进入 `blackhole` / `leak` 时桌面端发 `proxy://alert` 事件并弹 toast；侧栏容器名旁显示盾牌图标。

## 5. tdc-ctl 子命令（需 `docker exec -u root`）

| 子命令 | 动作 / 输出 |
|---|---|
| `proxy-apply` | 校验 → 兜底 → 起内核 → 选节点 → 自检；`{ok, stage, checks{...}, state, error}` |
| `proxy-off` | 停内核、删 tdc0、移除兜底、还原 resolv.conf / hosts、intent 置为未启用；幂等，**断网时也能用** |
| `proxy-restore` | entrypoint 调用：intent 已启用则先兜底再起内核 |
| `proxy-status` | 输出状态文件 |
| `proxy-nodes` / `proxy-select <名>` / `proxy-delay` / `proxy-refresh` | 节点列表、手动切换（写回 intent）、测延迟、刷新订阅（经 unix socket 控制器） |

自检项：`core` `tun` `guard` `dns_hijack`（getent 返回 198.18.*）`proxied`（经节点访问 generate_204）`bypass_blocked`（绑定 eth0 直连必须失败）`docker_dns_blocked`（直连 127.0.0.11 必须失败）。

## 6. 时序

```mermaid
sequenceDiagram
    participant UI as ProxyModal
    participant R as Rust proxy_apply
    participant C as tdc-proxy.sh
    participant D as 守护 daemon
    UI->>R: binding（节点必填）
    R->>R: render（校验节点 / 静态 / 出口）→ 保存绑定
    R->>C: write_file_owned config+intent → proxy-apply
    C->>C: mihomo -t（失败：返回 validate，不动网络）
    C->>C: 兜底 → 起内核 → 选节点 → 自检
    C-->>UI: {ok, checks}
    Note over D: 每 3 秒：兜底自愈、内核崩溃重启、写状态
    D-->>UI: fleet://update（state）/ proxy://alert
```

容器重启：`entrypoint.sh` 在降权前执行 `proxy-restore`（实测 resolv.conf 改写与内核启动早于用户阶段写 meta.json），没有裸奔窗口。重建容器：先创建不启动 → 推入配置 → 再启动；代理已启用而配置推送失败时容器保持未启动。

## 7. 已实测（2026-10-17，Docker Desktop 29.8.2 / WSL2 6.18，本地 vless 服务端）

测试拓扑：独立网络 `172.30.99.0/24`；服务端两个 mihomo 进程分别作为主节点（vless+ws）与中转（vless+tcp），另起 HTTP 订阅服务；客户端按桌面端参数创建，配置由 `cargo run --example render_proxy -- <目录> <subscription|vless|socks5> <地址> [--static=<vless>] [--exit=<socks5>] [--allow-lan]` 生成。

| 项 | 结果 |
|---|---|
| bridge 网络、仅 IPv4 下建立 tdc0 | ✅ |
| 进程链与降权：sleep / portwatch 为 node，守护为 root；HOME=/home/node | ✅ |
| 7 项自检（单 vless + 静态中转 / 订阅 + 静态中转 / base64 订阅 / allow_lan） | ✅ 全部通过 |
| 链式：主节点看到的来源为中转 IP，收到的是域名（远端解析） | ✅ |
| 冷启动 + 主机名订阅（sslip.io）经引导 DoH 拉取，无死锁 | ✅ 2.4 秒 |
| DNS：getent → 198.18.*；硬编码 8.8.8.8 / 223.5.5.5 也被劫持；127.0.0.11 与局域网 DNS 被拒 | ✅ |
| `kill -9` 内核：立即断网（不回退直连），守护 4 秒内重启恢复 | ✅ |
| root 删除兜底链：5 秒内自愈；node 无法执行 iptables | ✅ |
| `docker restart`：兜底与内核早于用户阶段恢复 | ✅ |
| `proxy-off`：规则、tdc0、内核、resolv.conf 全部清理；重启后保持直连 | ✅ |
| 端口映射（宿主 127.0.0.1:39010 → 容器 3000） | ✅ |
| allow_lan：局域网 HTTP 可达、局域网 53 被拒、host.docker.internal 注入 | ✅ |
| 大流量：git clone、npm install、22MB 下载 sha256 校验（默认 MTU） | ✅ |
| Claude Code 2.1.300 经代理访问 api.anthropic.com | ✅ |
| 真实 DockerClient 路径：write_file_owned(uid 0) / exec 默认 node / 超时保护 | ✅ |
| 实测中发现并修复：内核继承 flock 描述符导致全局锁永久占用 | ✅ 已修复（启动内核时关闭 fd 9） |

### SOCKS5 节点与出口（2026-10-17，镜像 `tdc/claude-dev:proxy-test` + 本次修改的 proxy-guard.sh）

测试拓扑：独立网络 `172.30.98.0/24`；服务端两个 mihomo SOCKS 监听（hop 无认证、exit 带认证且密码含 `@:/`）；客户端按桌面端参数创建，配置由 `render_proxy` 生成（`--exit=` 指定出口）。

| 项 | 结果 |
|---|---|
| SOCKS5 主节点 → 宿主 v2rayN（`host.docker.internal:10808`，宿主只监听 127.0.0.1） | ✅ 7 项自检通过 |
| 未开启 allow_lan：hosts 已注入；node 进程直连宿主 v2rayN 被拒 | ✅ |
| SOCKS5 主节点 → SOCKS5 出口：第一跳只看到出口地址，出口看到目标域名 | ✅ 7 项自检通过 |
| 出口密码错误：`proxied` 失败，网络保持断开；内核日志 `rejected username/password` | ✅ |
| `proxy-off` 清理注入的 hosts 行 | ✅ |
| 对照：旧镜像（guard 只在 allow_lan 时注入 hosts）主机填 `host.docker.internal` → `proxied` 失败；填 `192.168.65.254` → 通过 | ✅ 证实 hosts 改动必要；未重建镜像的容器可先填 IP |
| 订阅 + 出口、vless + 静态中转 + 出口 | 单测覆盖配置结构；`dialer-proxy` 引用节点组的链路另在 mihomo v1.19.32 实测 |

**未验证的前提**：以上节点均为本机明文 vless；真实互联网上的 TLS / Reality 节点、长距离链路下的 MTU 行为未测。协议实现属于 mihomo，本项目负责的字段映射与 `common/convert/v.go` 对齐并有单测；若遇到"TCP 能连、TLS 卡住"，先在 `src-tauri/src/proxy/render.rs` 的 tun 段加 `"mtu": 1400` 排查。
