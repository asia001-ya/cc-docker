/** 可选真实 Docker 验证：无用户挂载、无宿主端口；只使用本机合成节点，不读取节点库。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IMAGE = process.env.TDC_XRAY_TEST_IMAGE || "tdc/claude-dev:xray-test";
const DIR = "/var/lib/tdc/proxy";
const UUID = "11111111-1111-4111-8111-111111111111";
const PROBE = "http://probe.tdc.test/generate_204";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(args, { input, timeout = 30000, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn("docker", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => process.kill(), timeout);
    process.stdout.on("data", (chunk) => { stdout += chunk; });
    process.stderr.on("data", (chunk) => { stderr += chunk; });
    process.stdin.on("error", () => {});
    process.on("error", reject);
    process.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !allowFailure) reject(new Error(`Docker ${args[0]} failed: ${stderr.slice(-1000)} ${stdout.slice(-500)}`));
      else resolve({ code, stdout, stderr });
    });
    process.stdin.end(input);
  });
}

const vless = (port, name, network = "tcp") => `vless://${UUID}@127.0.0.1:${port}?security=none&type=${network}${network === "ws" ? "&path=%2Fws" : ""}#${name}`;
const source = { name: "测试订阅", kind: "subscription", secret: "http://127.0.0.1:18080/sub" };
function config() {
  return {
    mode: "rule", "log-level": "warning", ipv6: false, "allow-lan": false,
    "find-process-mode": "off", "geo-auto-update": false,
    "external-controller-unix": `${DIR}/mihomo.sock`, profile: { "store-selected": true },
    dns: { enable: true, ipv6: false, "enhanced-mode": "fake-ip", "fake-ip-range": "198.18.0.1/16", "respect-rules": true,
      "default-nameserver": ["https://1.1.1.1/dns-query"], "proxy-server-nameserver": ["https://1.1.1.1/dns-query"], nameserver: ["https://1.1.1.1/dns-query"] },
    tun: { enable: true, device: "tdc0", stack: "mixed", "auto-route": true, "strict-route": true, "auto-detect-interface": true,
      "dns-hijack": ["any:53", "tcp://any:53"], "route-exclude-address": ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"] },
    proxies: [], "proxy-providers": {}, "proxy-groups": [{ name: "NODE", type: "select", proxies: ["REJECT"] }], rules: ["MATCH,NODE"],
    "tdc-xray": { node: source, static: null, exit: null, bootstrapDns: ["https://1.1.1.1/dns-query"], subscriptionInterval: 86400 },
  };
}

let id;
try {
  id = (await run(["create", "--name", `tdc-xray-test-${randomUUID().slice(0, 8)}`, "--rm", "--label", "tdc.managed=false", "--label", "tdc.proxy_check=true",
    "--user", "root", "--cap-add", "NET_ADMIN", "--device", "/dev/net/tun", "--sysctl", "net.ipv6.conf.all.disable_ipv6=1", "--sysctl", "net.ipv6.conf.default.disable_ipv6=1",
    "--env", `TDC_PROXY_PROBE_URL=${PROBE}`, "--entrypoint", "/bin/sleep", "--no-healthcheck", IMAGE, "600"])).stdout.trim();
  const exec = (args, options) => run(["exec", "-i", "--user", "root", id, ...args], options);
  const write = (file, text) => exec(["node", "-e", "require('fs').writeFileSync(process.argv[1],require('fs').readFileSync(0),{mode:0o600})", file], { input: text });
  const read = async (file) => (await exec(["cat", file])).stdout.trim();
  const ctl = async (command, ...args) => JSON.parse((await exec(["/opt/tdc/tdc-ctl.sh", `proxy-${command}`, ...args], { timeout: 170000 })).stdout);
  await run(["start", id]);
  // 先启动镜像原有守护，再更新脚本，覆盖旧容器在线升级的路径。
  await run(["exec", "-d", "--user", "root", id, "/opt/tdc/tdc-proxy.sh", "daemon"]);
  await sleep(400);
  for (const file of ["tdc-proxy-lib.mjs", "tdc-xray.mjs", "tdc-proxy.sh"]) {
    await run(["cp", path.join(ROOT, "docker/rootfs/opt/tdc", file), `${id}:/opt/tdc/${file}`]);
  }
  // Xray 由镜像构建时内置，运行时不下载
  await exec(["sh", "-c", "chmod 0755 /opt/tdc/*.sh /opt/tdc/*.mjs; bash -n /opt/tdc/tdc-proxy.sh; test -x /usr/local/bin/xray"]);
  await write("/tmp/subscription.txt", Buffer.from([vless(31001, "A"), vless(31002, "B", "ws")].join("\n")).toString("base64"));
  await write("/tmp/probe.cjs", `const http=require('http'),fs=require('fs');http.createServer((q,r)=>{if(q.url==='/sub'){r.end(fs.readFileSync('/tmp/subscription.txt'));}else{r.writeHead(204);r.end();}}).listen(18080,'127.0.0.1');`);
  await run(["exec", "-d", id, "node", "/tmp/probe.cjs"]);
  const inbound = (port, tag, network = "tcp") => ({ port, listen: "127.0.0.1", tag, protocol: "vless", settings: { clients: [{ id: UUID }], decryption: "none" }, streamSettings: { network, ...(network === "ws" ? { wsSettings: { path: "/ws" } } : {}) } });
  await write("/tmp/test-server.json", JSON.stringify({
    log: { loglevel: "debug", access: "/tmp/test-server.access", error: "/tmp/test-server.log" },
    inbounds: [inbound(31001, "node-a"), inbound(31002, "node-b", "ws"), inbound(31003, "relay"),
      { port: 31004, listen: "127.0.0.1", tag: "exit", protocol: "socks", settings: { auth: "password", accounts: [{ user: "test@user", pass: "test:/pass" }] } }],
    // 合成服务端的目标都在本测试容器的 loopback；仅这里显式允许本地测试端口。
    outbounds: [{ tag: "DIRECT", protocol: "freedom", settings: { finalRules: [{ action: "allow", ip: ["127.0.0.1/32"], port: "18080,31001-31004" }] } },
      { tag: "PROBE", protocol: "freedom", settings: { redirect: "127.0.0.1:18080", finalRules: [{ action: "allow", ip: ["127.0.0.1/32"], port: "18080" }] } }],
    routing: { rules: [{ type: "field", domain: ["full:probe.tdc.test"], outboundTag: "PROBE" }] },
  }));
  await run(["exec", "-d", id, "xray", "run", "-config", "/tmp/test-server.json"]);
  await sleep(400);
  const intent = { enabled: true, engine: "xray", allow_lan: false, selected: null };
  const base = config();
  await write(`${DIR}/config.yaml`, JSON.stringify(base));
  await write(`${DIR}/intent.json`, JSON.stringify(intent));
  let applied = await ctl("apply");
  if (!applied.ok) {
    const probe = await run(["exec", "--user", "node", id, "curl", "-v", "--max-time", "3", PROBE], { allowFailure: true });
    console.error(probe.stderr);
  }
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.ok(Object.values(applied.checks).every((value) => value === true));
  console.log("PASS Xray subscription: all seven TUN/DNS/network checks");
  assert.deepEqual((await ctl("nodes")).all, ["A", "B"]);
  assert.equal((await ctl("select", "B")).now, "B");
  assert.ok(Number.isFinite((await ctl("delay")).delays.B));
  let status = await ctl("status");
  assert.equal(status.engine, "xray");
  assert.ok(status.xray_pid > 0);
  assert.equal(status.providers[0].count, 2);
  console.log("PASS subscription node selection, latency and status metadata");

  base["tdc-xray"].static = { name: "中转", kind: "vless", secret: vless(31003, "Relay") };
  base["tdc-xray"].exit = { name: "出口", kind: "socks5", secret: "socks5://test%40user:test%3A%2Fpass@127.0.0.1:31004" };
  await write(`${DIR}/config.yaml`, JSON.stringify(base));
  applied = await ctl("apply");
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const access = await read("/tmp/test-server.access");
  for (const tag of ["relay", "node-b", "exit"]) assert.match(access, new RegExp(`\\[${tag} (?:->|>>) `), `traffic must traverse ${tag}`);
  console.log("PASS relay -> selected node -> authenticated SOCKS5 exit (server logs verified)");

  await write("/tmp/subscription.txt", Buffer.from([vless(31001, "A"), vless(31002, "B", "ws"), vless(31001, "C")].join("\n")).toString("base64"));
  assert.equal((await ctl("refresh")).ok, true);
  assert.deepEqual((await ctl("nodes")).all, ["A", "B", "C"]);
  assert.equal((await ctl("nodes")).now, "B");
  const previousPid = await read(`${DIR}/xray.pid`);
  const previousGeneration = (await exec(["readlink", `${DIR}/xray-current`])).stdout;
  await write("/tmp/subscription.txt", "<html>expired</html>");
  assert.equal((await ctl("refresh")).ok, false);
  assert.equal(await read(`${DIR}/xray.pid`), previousPid);
  assert.equal((await exec(["readlink", `${DIR}/xray-current`])).stdout, previousGeneration);
  assert.equal((await ctl("nodes")).now, "B");
  console.log("PASS refresh preserves selection; invalid subscription keeps the working core");

  // 暂停守护时持有操作锁，确保它不会停在持锁区；模拟内核崩溃并验证无直连回退。
  await exec(["bash", "-c", `exec 9>${DIR}/.lock; flock -w 15 9; kill -STOP "$(cat ${DIR}/daemon.pid)"; kill -KILL "$(cat ${DIR}/xray.pid)"`]);
  const failedProbe = await run(["exec", "--user", "node", id, "curl", "--noproxy", "*", "--silent", "--max-time", "3", PROBE], { allowFailure: true });
  assert.notEqual(failedProbe.code, 0);
  await exec(["/opt/tdc/proxy-guard.sh", "check"]);
  assert.equal((await ctl("nodes")).ok, false);
  await exec(["bash", "-c", `kill -CONT "$(cat ${DIR}/daemon.pid)"`]);
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    status = await ctl("status");
    if (status.state === "ok" && status.restarts >= 1) break;
    await sleep(500);
  }
  assert.equal(status.state, "ok");
  assert.ok(status.restarts >= 1);
  assert.equal((await ctl("nodes")).now, "B");
  console.log("PASS core crash blocks traffic; daemon recovers with cached subscription and selected node");

  const normal = config();
  delete normal["tdc-xray"];
  normal.proxies = [{ name: "A", type: "vless", server: "127.0.0.1", port: 31001, uuid: UUID, network: "tcp", udp: true }];
  normal["proxy-groups"][0].proxies = ["A"];
  await write(`${DIR}/config.yaml`, JSON.stringify(normal));
  await write(`${DIR}/intent.json`, JSON.stringify({ ...intent, engine: "mihomo" }));
  applied = await ctl("apply");
  assert.equal(applied.ok, true, JSON.stringify(applied));
  status = await ctl("status");
  assert.equal(status.engine, "mihomo");
  assert.equal(status.xray_pid, null);
  assert.equal((await ctl("off")).ok, true);
  assert.equal((await ctl("status")).state, "off");
  console.log("PASS switch back to Mihomo and explicit proxy off");
} catch (error) {
  if (id) {
    const diagnostics = await run(["exec", id, "sh", "-c", "tail -n 12 /var/lib/tdc/proxy/mihomo.log /var/lib/tdc/proxy/xray.log /tmp/test-server.access /tmp/test-server.log 2>/dev/null; ip -4 rule"], { allowFailure: true });
    console.error(diagnostics.stdout);
  }
  throw error;
} finally {
  if (id) {
    await run(["rm", "-f", "-v", id]);
    console.log("PASS disposable container removed");
  }
}
