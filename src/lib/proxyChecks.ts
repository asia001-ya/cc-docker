/** 右键代理与新建前自检共用的检查项。 */
export const PROXY_CHECK_LABELS: Record<string, string> = {
  core: "内核运行",
  tun: "TUN 接口已建立",
  guard: "兜底规则完整",
  dns_hijack: "DNS 由代理接管（fake-ip）",
  proxied: "经节点访问外网",
  bypass_blocked: "绕过代理的直连被拒绝",
  docker_dns_blocked: "直连 Docker 内嵌 DNS 被拒绝",
};
