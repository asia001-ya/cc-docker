# SOCKS5 节点（出口 / 主节点）设计

> 2026-10-17 · 状态：已实现并实测 · 关联：docs/06-proxy.md

## 目标

节点库新增 **SOCKS5** 类型，可用于两个位置：

| 位置 | 链路 | 典型用途 |
|---|---|---|
| 出口（新增，可选） | 容器 → [静态中转] → 节点 → **SOCKS5** → 目标 | 住宅 / 静态 IP 固定落地，目标看到的是出口 IP |
| 主节点 | 容器 → [静态中转] → **SOCKS5** → 目标 | 指向宿主 v2rayN（`host.docker.internal:10808`），绕开 mihomo 与 Xray REALITY 的兼容问题 |

不做：SOCKS5 作静态中转（第一跳明文）、粘贴链接录入、出口 UDP。

## 数据模型

- `NodeKind::Socks5`（序列化为 `socks5`）。
- 密钥：凭据管理器中存规范链接 `socks5://<user>:<pass>@<host>:<port>`（用户名与密码 URL 编码；无认证时为 `socks5://host:port`）。
  前端用分字段表单（主机 / 端口 / 用户名 / 密码）拼接，后端严格解析，`proxy_node_save(node, secret)` 接口不变。
- 摘要：`host:port`，有认证时追加 ` · 认证`；IPv6 显示为 `[addr]:port`。不含用户名与密码。
- `ProxyBinding.exit_id: Option<String>`（serde default，旧 proxies.json 兼容）。

## 校验

| 项 | 规则 |
|---|---|
| SOCKS5 链接 | scheme 必须是 `socks5`；主机必填；端口 1–65535；有密码必须有用户名；不允许路径、查询串、片段 |
| 主节点 | 订阅 / vless / socks5 |
| 静态中转 | 仍只能是 vless（不变） |
| 出口 | 只能是 socks5；不能与主节点相同；引用的节点必须存在 |
| 节点改类型 | 正被用作静态中转的只能是 vless；正被用作出口的只能是 socks5 |
| 删除节点 | 被任一绑定的主节点 / 静态中转 / 出口引用时拒绝 |

## 配置生成（render）

- 主节点为 socks5：与单条 vless 相同，生成显式 `proxies` 条目放入组 `NODE`；有静态中转时加 `dialer-proxy: STATIC`。
- 有出口：追加条目 `{name: EXIT, type: socks5, ..., udp: false, dialer-proxy: NODE}`，规则改为 `MATCH,EXIT`；无出口时仍为 `MATCH,NODE`。
- `dialer-proxy` 引用节点组 `NODE`（不是具体节点）：订阅里切换节点后出口仍然生效。已在 mihomo v1.19.32 实测（链路两跳日志 + 密码错误时报 `rejected username/password`）。
- socks5 条目一律 `udp: false`（QUIC 自动回退 TCP；目标 DNS 走 DoH，不受影响）。
- `EXIT` 加入保留名，用户节点名与之冲突时加后缀。
- 测延迟、选节点、刷新订阅仍只作用于 `NODE`（不含出口段）；自检探测走完整链路。

## 容器侧

- `proxy-guard.sh`：`host.docker.internal` 写入 `/etc/hosts` 改为**无论是否允许局域网都执行**。
  原因：开启代理后 DNS 被改写，mihomo 只能经 hosts 解析该域名；SOCKS5 主节点指向宿主时需要它。
  安全性不变：普通进程连接私有网段仍被兜底规则拒绝（除非开启"允许直连宿主与局域网"）；mihomo 以 root 运行、该网段在 `route-exclude-address` 内，可直连。
- 该改动在镜像内，已有容器需重建镜像后才生效；不重建时可直接把主机填成 `host.docker.internal` 解析出的 IP（Docker Desktop 为 `192.168.65.254`，已实测）。

## 界面

- 节点编辑：第三种类型"SOCKS5"，四个输入框。编辑已有节点时四项全空表示不修改；改动任一项需四项完整重填（与 vless 重贴整条链接一致）。
- 容器代理弹框：新增"出口（可选）"下拉，只列 SOCKS5 节点；显示整条链路 `静态中转 → 节点 → 出口 → 目标`。
- 主节点下拉加 `[SOCKS5]` 前缀。

## 测试

- Rust 单元测试：socks5 解析（特殊字符、无认证、IPv6、各类非法输入）、绑定校验（出口类型 / 与主节点重复 / 不存在）、渲染（`MATCH,EXIT`、`dialer-proxy`、socks5 主节点 + 静态中转）、节点改类型与删除时的引用检查。
- 前端：`tsc` 类型检查。
- 容器实测（`tdc/claude-dev:proxy-test` 独立容器，不碰用户容器）：
  1. 主节点 SOCKS5 → 宿主 v2rayN，7 项自检全部通过；
  2. 主节点 SOCKS5 + 出口 SOCKS5（容器内另起 SOCKS 服务端模拟），7 项自检通过，出口服务端看到目标域名。
