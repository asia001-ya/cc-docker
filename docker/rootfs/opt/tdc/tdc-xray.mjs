#!/usr/bin/env node
/** Xray 出站适配：保留分享链接的 REALITY / pqv 参数，复用 mihomo 的 TUN 与节点控制器。 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 256;
const FIRST_PORT = 23000;
const RESERVED_NAMES = new Set(["NODE", "STATIC", "EXIT", "DIRECT", "REJECT", "REJECT-DROP", "GLOBAL", "PASS", "COMPATIBLE"]);

function fail(message) { throw new Error(message); }
function linkUrl(text, protocol) {
  let url;
  try { url = new URL(text); } catch { fail(`无法解析 ${protocol} 节点地址`); }
  if (url.protocol !== `${protocol}:` || !url.hostname || !url.port) fail(`${protocol} 节点缺少服务器或端口`);
  return url;
}
function decode(text) { try { return decodeURIComponent(text); } catch { fail("节点参数含无效 URL 编码"); } }
function host(url) { return url.hostname.replace(/^\[|\]$/g, ""); }

/** 分享链接只映射协议字段，不能注入任意 Xray 入站、路由或本地文件路径。 */
export function parseVless(text, fallbackName = "VLESS") {
  const url = linkUrl(text, "vless");
  if (!url.username) fail("VLESS 节点缺少用户 ID");
  const q = url.searchParams;
  const get = (key, fallback = "") => q.get(key) || fallback;
  const user = { id: decode(url.username), encryption: get("encryption", "none") };
  if (get("flow")) user.flow = get("flow");
  const transport = get("type", "tcp").toLowerCase();
  const stream = { network: transport === "raw" ? "tcp" : transport, sockopt: { domainStrategy: "UseIPv4" } };
  const security = get("security", "none").toLowerCase();
  if (security === "reality") {
    if (!get("pbk")) fail("REALITY 节点缺少公钥");
    stream.security = "reality";
    stream.realitySettings = {
      serverName: get("sni"), fingerprint: get("fp", "chrome"),
      publicKey: get("pbk"), shortId: get("sid"), spiderX: get("spx", "/"),
    };
    if (get("pqv")) stream.realitySettings.mldsa65Verify = get("pqv");
  } else if (security === "tls") {
    stream.security = "tls";
    stream.tlsSettings = { serverName: get("sni"), fingerprint: get("fp", "chrome") };
    if (get("alpn")) stream.tlsSettings.alpn = get("alpn").split(",").map((s) => s.trim());
    if (["true", "1"].includes(get("allowInsecure", get("insecure")))) stream.tlsSettings.allowInsecure = true;
  } else if (security !== "none") fail("Xray 节点的安全协议不受支持");
  switch (stream.network) {
    case "tcp":
      if (get("headerType") === "http") {
        stream.tcpSettings = { header: { type: "http", request: { path: [get("path", "/")], headers: { Host: [get("host", host(url))] } } } };
      } else if (get("headerType") && get("headerType") !== "none") fail("Xray 不支持该 TCP 伪装类型");
      break;
    case "ws":
      stream.wsSettings = { path: get("path", "/") };
      if (get("host")) stream.wsSettings.headers = { Host: get("host") };
      break;
    case "grpc":
      stream.grpcSettings = { serviceName: get("serviceName"), multiMode: get("mode") === "multi" };
      if (get("authority")) stream.grpcSettings.authority = get("authority");
      break;
    case "httpupgrade":
      stream.httpupgradeSettings = { path: get("path", "/"), host: get("host") };
      break;
    case "xhttp":
      stream.xhttpSettings = { path: get("path", "/"), host: get("host"), mode: get("mode", "auto") };
      // 分享链接 extra 可包含任意传输对象，本版不接收它，避免静默丢弃或注入文件引用。
      if (get("extra")) fail("Xray 暂不支持带 extra 的 XHTTP 分享链接，请使用基础 XHTTP 参数");
      break;
    default: fail("Xray 暂不支持该 VLESS 传输方式");
  }
  return {
    name: decode(url.hash.slice(1)) || fallbackName,
    outbound: { protocol: "vless", settings: { vnext: [{ address: host(url), port: Number(url.port), users: [user] }] }, streamSettings: stream },
  };
}

export function parseSocks(text, fallbackName = "SOCKS5") {
  const url = linkUrl(text, "socks5");
  const server = { address: host(url), port: Number(url.port) };
  if (url.username || url.password) server.users = [{ user: decode(url.username), pass: decode(url.password) }];
  return { name: fallbackName, outbound: { protocol: "socks", settings: { servers: [server] }, streamSettings: { sockopt: { domainStrategy: "UseIPv4" } } } };
}

export function parseSubscription(body, fallbackName = "订阅节点") {
  if (Buffer.byteLength(body) > MAX_BYTES) fail("订阅内容超过 8 MiB 限制");
  let text = body.trim().replace(/^\uFEFF/, "");
  if (!text.includes("://")) {
    const compact = text.replace(/\s/g, "");
    if (!compact || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) fail("Xray 订阅需为分享链接或 Base64 格式；Clash YAML 请使用 Mihomo");
    text = Buffer.from(compact, "base64").toString("utf8").trim();
  }
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  const supported = lines.filter((s) => s.startsWith("vless://") || s.startsWith("socks5://"));
  if (supported.length === 0) fail("订阅没有 Xray 可用的 VLESS / SOCKS5 分享链接；Clash YAML 请使用 Mihomo");
  if (supported.length > MAX_NODES) fail(`Xray 订阅最多支持 ${MAX_NODES} 个节点`);
  const nodes = supported.map((s, i) => s.startsWith("vless://") ? parseVless(s, `${fallbackName} ${i + 1}`) : parseSocks(s, `${fallbackName} ${i + 1}`));
  const warnings = supported.length < lines.length ? [`订阅中有 ${lines.length - supported.length} 条暂不支持的记录，已忽略`] : [];
  return { nodes, warnings };
}

function parseSource(source) {
  if (source?.kind === "vless") return parseVless(source.secret, source.name);
  if (source?.kind === "socks5") return parseSocks(source.secret, source.name);
  fail("Xray 节点类型不受支持");
}

/** 所有入站都经过完整链路，未匹配流量默认拒绝；没有 DIRECT 回退。 */
export function buildRuntime(base, nodes, password = randomBytes(24).toString("hex")) {
  if (!nodes.length || nodes.length > MAX_NODES) fail("Xray 节点数量无效");
  const spec = base["tdc-xray"];
  if (!spec?.node) fail("缺少 Xray 节点配置");
  const relay = spec.static ? parseSource(spec.static) : null;
  const exit = spec.exit ? parseSource(spec.exit) : null;
  const outbounds = [{ tag: "BLOCK", protocol: "blackhole", settings: {} }];
  if (relay) outbounds.push({ ...relay.outbound, tag: "STATIC" });
  const inbounds = [], rules = [], proxies = [], names = new Set();
  for (const [index, item] of nodes.entries()) {
    let name = item.name.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 180) || `节点 ${index + 1}`;
    if (RESERVED_NAMES.has(name.toUpperCase())) name = `${name} (节点)`;
    const original = name;
    for (let suffix = 2; names.has(name); suffix++) name = `${original} [${suffix}]`;
    names.add(name);
    const tag = `NODE_${index}`, inboundTag = `IN_${index}`, port = FIRST_PORT + index;
    const outbound = structuredClone(item.outbound);
    outbound.tag = tag;
    if (relay) outbound.streamSettings.sockopt.dialerProxy = "STATIC";
    outbounds.push(outbound);
    let target = tag;
    if (exit) {
      const hop = structuredClone(exit.outbound);
      hop.tag = `EXIT_${index}`;
      hop.streamSettings.sockopt.dialerProxy = tag;
      outbounds.push(hop);
      target = hop.tag;
    }
    inbounds.push({ tag: inboundTag, listen: "127.0.0.1", port, protocol: "socks", settings: { auth: "password", accounts: [{ user: "tdc", pass: password }], udp: !exit, ip: "127.0.0.1" } });
    rules.push({ type: "field", inboundTag: [inboundTag], outboundTag: target });
    proxies.push({ name, type: "socks5", server: "127.0.0.1", port, username: "tdc", password, udp: !exit });
  }
  const mihomo = structuredClone(base);
  delete mihomo["tdc-xray"];
  mihomo.proxies = proxies;
  mihomo["proxy-providers"] = {};
  mihomo["proxy-groups"] = [{ name: "NODE", type: "select", proxies: proxies.map((p) => p.name) }];
  mihomo.rules = ["MATCH,NODE"];
  mihomo.tun = { ...mihomo.tun, "exclude-uid": [0] };
  const xray = {
    log: { loglevel: "warning", access: "none" },
    dns: { servers: spec.bootstrapDns.map((s) => s.replace(/^https:/, "https+local:")), queryStrategy: "UseIPv4" },
    inbounds, outbounds, routing: { domainStrategy: "AsIs", rules },
  };
  return { mihomo, xray, names: proxies.map((p) => p.name) };
}

async function readJson(file) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; } }
async function writeJson(file, value) { await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 }); }

/** URL 通过 stdin 传给 curl，不进入进程参数或错误输出。 */
async function downloadSubscription(url) {
  let parsed;
  try { parsed = new URL(url); } catch { fail("订阅地址无效"); }
  if (!["http:", "https:"].includes(parsed.protocol)) fail("订阅地址只支持 HTTP 或 HTTPS");
  return new Promise((resolve, reject) => {
    const child = spawn("curl", ["--config", "-", "--silent", "--show-error", "--fail", "--location", "--max-redirs", "3", "--proto", "=http,https", "--proto-redir", "=http,https", "--noproxy", "*", "--connect-timeout", "6", "--max-time", "20", "--max-filesize", String(MAX_BYTES)], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = []; let size = 0, tooLarge = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), 22000);
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size > MAX_BYTES) { tooLarge = true; child.kill("SIGKILL"); } else chunks.push(chunk); });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => { clearTimeout(timer); reject(new Error("无法运行订阅下载工具")); });
    child.on("close", (code) => { clearTimeout(timer); if (code === 0 && !tooLarge) resolve(Buffer.concat(chunks).toString("utf8")); else reject(new Error(tooLarge ? "订阅超过 8 MiB 限制" : "Xray 订阅下载失败，请检查订阅地址和网络")); });
    child.stdin.end(`url = ${JSON.stringify(url)}\nuser-agent = "clash.meta"\n`);
  });
}

async function prepare(dir, force) {
  const base = await readJson(path.join(dir, "config.yaml"));
  const spec = base?.["tdc-xray"];
  if (!spec?.node) fail("缺少 Xray 代理配置");
  let nodes, cache = null, warnings = [], updatedAt = null;
  const now = Math.floor(Date.now() / 1000);
  if (spec.node.kind === "subscription") {
    const key = createHash("sha256").update(spec.node.secret).digest("hex");
    const previous = await readJson(path.join(dir, "xray-subscription.json"));
    if (previous?.key === key && typeof previous.body === "string") cache = previous;
    if (force || !cache || now - cache.updatedAt >= spec.subscriptionInterval) {
      try { cache = { key, body: await downloadSubscription(spec.node.secret), updatedAt: now }; }
      catch (error) {
        if (force || !cache) throw error;
        warnings.push("订阅暂时无法更新，继续使用上次验证通过的节点");
      }
    }
    const parsed = parseSubscription(cache.body, spec.node.name);
    nodes = parsed.nodes; warnings.push(...parsed.warnings); updatedAt = cache.updatedAt;
  } else nodes = [{ ...parseSource(spec.node), name: spec.node.name }];
  const runtime = buildRuntime(base, nodes);
  const generation = await fs.mkdtemp(path.join(dir, "xray-gen-"));
  await fs.chmod(generation, 0o700);
  let activated = false;
  try {
    await writeJson(path.join(generation, "xray.json"), runtime.xray);
    await writeJson(path.join(generation, "mihomo.json"), runtime.mihomo);
    await writeJson(path.join(generation, "meta.json"), {
      names: runtime.names, warnings, subscription: spec.node.kind === "subscription", updatedAt,
      refreshAt: updatedAt === null ? null : Math.max(now + 300, updatedAt + spec.subscriptionInterval),
    });
    try { await exec(process.env.TDC_XRAY_BIN || "/usr/local/bin/xray", ["run", "-test", "-config", path.join(generation, "xray.json")], { timeout: 15000, maxBuffer: MAX_BYTES }); }
    catch { fail("Xray 配置校验失败，请检查节点的协议、密钥和传输参数"); }
    try { await exec(process.env.TDC_MIHOMO_BIN || "/usr/local/bin/mihomo", ["-t", "-d", dir, "-f", path.join(generation, "mihomo.json")], { timeout: 15000, maxBuffer: MAX_BYTES }); }
    catch { fail("Xray 的 TUN 配置校验失败，请更新标准镜像"); }
    // 验证全部通过后一次切换配置目录；下载或解析失败不会覆盖正在使用的配置。
    const link = path.join(dir, `.xray-link-${randomBytes(6).toString("hex")}`);
    await fs.symlink(path.basename(generation), link);
    await fs.rename(link, path.join(dir, "xray-current"));
    activated = true;
    if (cache) {
      const next = path.join(dir, "xray-subscription.next.json");
      await writeJson(next, cache); await fs.rename(next, path.join(dir, "xray-subscription.json"));
    }
  } finally {
    if (!activated) await fs.rm(generation, { recursive: true, force: true });
  }
}

async function cleanup(dir) {
  const current = await fs.readlink(path.join(dir, "xray-current")).catch(() => "");
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && /^xray-gen-[A-Za-z0-9]+$/.test(entry.name) && entry.name !== current) {
      await fs.rm(path.join(dir, entry.name), { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.env.TDC_PROXY_DIR || "/var/lib/tdc/proxy";
  try {
    if (process.argv[2] === "prepare") await prepare(dir, process.argv.includes("--refresh"));
    else if (process.argv[2] === "cleanup") await cleanup(dir);
    else fail("用法：tdc-xray.mjs prepare [--refresh] | cleanup");
  } catch (error) {
    // 仅上面明确构造的错误可对外显示；文件系统错误只显示操作码，避免泄露配置内容。
    process.stderr.write((error?.code ? `Xray 配置文件操作失败（${error.code}）` : error.message) + "\n");
    process.exitCode = 1;
  }
}
