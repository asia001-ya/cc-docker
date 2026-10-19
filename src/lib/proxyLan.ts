import policy from "../../docker/rootfs/opt/tdc/lan-policy.json";

export const DEFAULT_LAN_CIDRS = policy.privateCidrs;
export const MAX_LAN_CIDRS = policy.maxEntries;

function parse(value: string) {
  const [ip, bits = "32", extra] = value.split("/");
  const octets = ip.split(".");
  if (extra !== undefined || octets.length !== 4 || octets.some((v) => !/^(0|[1-9]\d{0,2})$/.test(v) || Number(v) > 255)
    || !/^(0|[1-9]|[12]\d|3[0-2])$/.test(bits)) {
    throw new Error("需填写有效的 IPv4 地址或 CIDR 网段");
  }
  const prefix = Number(bits);
  const size = 2 ** (32 - prefix);
  const number = octets.reduce((n, octet) => n * 256 + Number(octet), 0);
  return { network: Math.floor(number / size) * size, prefix, size };
}

/** Public addresses and CIDRs overlapping public space can never become direct exceptions. */
export function normalizeLanCidrs(values: string[]): string[] {
  if (values.length > MAX_LAN_CIDRS) throw new Error(`内网直连最多配置 ${MAX_LAN_CIDRS} 个 IP 或网段`);
  const ranges = DEFAULT_LAN_CIDRS.map(parse);
  return [...new Set(values.map((value, index) => {
    try {
      const { network, prefix, size } = parse(value.trim());
      if (!ranges.some((range) => network >= range.network && network + size <= range.network + range.size)) {
        throw new Error("只能位于 10/8、172.16/12 或 192.168/16 内；不允许放行公网地址");
      }
      const ip = [24, 16, 8, 0].map((shift) => (network >>> shift) & 255).join(".");
      return `${ip}/${prefix}`;
    } catch (error) {
      throw new Error(`第 ${index + 1} 项：${(error as Error).message}`);
    }
  }))];
}

export function lanCidrsError(values: string[]): string | null {
  if (!values.length) return "请至少填写一个内网 IP 或网段";
  try { normalizeLanCidrs(values); return null; } catch (error) { return (error as Error).message; }
}
