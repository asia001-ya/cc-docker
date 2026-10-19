#!/usr/bin/env node
/** Validate LAN exceptions before any firewall rule is built. */
import fs from "node:fs";
import { isIPv4 } from "node:net";
import { pathToFileURL } from "node:url";

export const LAN_POLICY = JSON.parse(fs.readFileSync(new URL("./lan-policy.json", import.meta.url), "utf8"));

function parse(value) {
  const [ip, bits = "32", extra] = value.split("/");
  if (extra !== undefined || !isIPv4(ip) || !/^(0|[1-9]|[12]\d|3[0-2])$/.test(bits)) {
    throw new Error("需填写有效的 IPv4 地址或 CIDR 网段");
  }
  const prefix = Number(bits);
  const size = 2 ** (32 - prefix);
  const number = ip.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
  return { network: Math.floor(number / size) * size, prefix, size };
}

export function normalizeLanCidrs(values) {
  if (!Array.isArray(values) || values.length > LAN_POLICY.maxEntries) {
    throw new Error(`内网直连需为数组，且最多 ${LAN_POLICY.maxEntries} 项`);
  }
  const ranges = LAN_POLICY.privateCidrs.map(parse);
  return [...new Set(values.map((value, index) => {
    try {
      if (typeof value !== "string") throw new Error("地址需为文本");
      const { network, prefix, size } = parse(value.trim());
      if (!ranges.some((range) => network >= range.network && network + size <= range.network + range.size)) {
        throw new Error("只允许 10/8、172.16/12 或 192.168/16 内的地址，不允许放行公网");
      }
      const ip = [24, 16, 8, 0].map((shift) => (network >>> shift) & 255).join(".");
      return `${ip}/${prefix}`;
    } catch (error) {
      throw new Error(`第 ${index + 1} 项：${error.message}`);
    }
  }))];
}

export function lanCidrsFromIntent(intent) {
  // Missing means an older intent; an explicit empty/invalid list must never widen to defaults.
  const cidrs = normalizeLanCidrs(intent.lan_cidrs === undefined ? LAN_POLICY.privateCidrs : intent.lan_cidrs);
  if (!cidrs.length) throw new Error("允许内网直连时，至少需要一个 IP 或网段");
  return cidrs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] !== "guard-cidrs" || !process.argv[3]) throw new Error("用法：tdc-lan.mjs guard-cidrs <intent.json>");
    let intent = {};
    try {
      intent = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!intent || typeof intent !== "object" || Array.isArray(intent)) throw new Error("内网直连配置无效");
    process.stdout.write(lanCidrsFromIntent(intent).join("\n") + "\n");
  } catch (error) {
    process.stderr.write(`proxy-guard: ${error.message}\n`);
    process.exitCode = 2;
  }
}
