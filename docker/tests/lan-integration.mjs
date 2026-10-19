/** Real LAN allowlist / fail-closed tests. No user containers, credentials, host ports, or Internet endpoints. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IMAGE = process.env.TDC_LAN_TEST_IMAGE || "tdc/claude-dev:latest";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tdc-lan-integration-"));
const tag = randomUUID().slice(0, 8);
const containers = [], networks = [];
const DIR = "/var/lib/tdc/proxy";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function command(binary, args, { input, allowFailure = false, timeout = 60000, cwd = ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill(), timeout);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = { code, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code !== 0 && !allowFailure) reject(new Error(`${binary} ${args[0]}: ${stderr.slice(-1800)} ${stdout.slice(-1000)}`));
      else resolve(result);
    });
    child.stdin.end(input);
  });
}
const docker = (args, options) => command("docker", args, options);
const exec = (id, user, args, options) => docker(["exec", "-i", "--user", user, id, ...args], options);
const write = (id, file, value) => exec(id, "root", ["node", "-e", "require('fs').writeFileSync(process.argv[1],require('fs').readFileSync(0),{mode:0o600})", file], { input: value });
const curl = (id, user, url, extras = []) => exec(id, user, ["curl", "--noproxy", "*", "-fsS", "--connect-timeout", "2", "--max-time", "4", ...extras, url], { allowFailure: true });
const ipOf = async (id, network) => JSON.parse((await docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", id])).stdout)[network].IPAddress;
const tcp = (id, user, host) => exec(id, user, ["node", "-e", "const s=require('net').connect(53,process.argv[1]);s.setTimeout(1500);s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));s.on('timeout',()=>process.exit(1));", host], { allowFailure: true });
const udp = (id, user, host) => exec(id, user, ["node", "-e", "const s=require('dgram').createSocket('udp4');s.on('message',()=>process.exit(0));s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1500);s.send(Buffer.from('test'),53,process.argv[1]);", host], { allowFailure: true });
let client, allowed, denied, privateNet, publicNet, publicIp;

try {
  await command("cargo", ["build", "--quiet", "--example", "render_proxy"], { cwd: path.join(ROOT, "src-tauri"), timeout: 180000 });
  privateNet = `tdc-lan-private-${tag}`;
  await docker(["network", "create", "--internal", "--label", "tdc.lan_check=true", privateNet]);
  networks.push(privateNet);
  publicNet = `tdc-lan-public-${tag}`;
  for (const prefix of ["203.0.113", "198.51.100", "192.0.2"]) {
    const created = await docker(["network", "create", "--internal", "--subnet", `${prefix}.0/24`, "--label", "tdc.lan_check=true", publicNet], { allowFailure: true });
    if (created.code === 0) { publicIp = `${prefix}.10`; networks.push(publicNet); break; }
  }
  assert.ok(publicIp, "a documentation-only synthetic public subnet must be available");
  async function create(name, args = [], cmd = []) {
    const id = (await docker(["create", "--name", `tdc-lan-${name}-${tag}`, "--network", privateNet,
      "--label", "tdc.managed=false", "--label", "tdc.lan_check=true", "--no-healthcheck", ...args, IMAGE, ...cmd])).stdout;
    containers.push(id);
    return id;
  }
  allowed = await create("allowed", ["--entrypoint", "node"], ["/tmp/lan-server.mjs"]);
  denied = await create("denied", ["--entrypoint", "node"], ["/tmp/lan-server.mjs"]);
  for (const id of [allowed, denied]) {
    await docker(["cp", path.join(ROOT, "docker/tests/fixtures/lan-server.mjs"), `${id}:/tmp/lan-server.mjs`]);
  }
  for (const id of [allowed, denied]) await docker(["start", id]);
  await docker(["network", "connect", "--ip", publicIp, publicNet, allowed]);
  client = await create("client", ["--cap-add", "NET_ADMIN", "--device", "/dev/net/tun", "--sysctl", "net.ipv6.conf.all.disable_ipv6=1",
    "--sysctl", "net.ipv6.conf.default.disable_ipv6=1", "--env", "TDC_PROXY_PROBE_URL=http://probe.tdc.test:18080/generate_204"]);
  await docker(["network", "connect", "--ip", publicIp.replace(/\.10$/, ".20"), publicNet, client]);
  await docker(["start", client]);
  const allowedIp = await ipOf(allowed, privateNet), deniedIp = await ipOf(denied, privateNet);
  await exec(client, "root", ["ip", "route", "replace", "default", "via", allowedIp, "dev", "eth0"]);
  for (const file of ["lan-policy.json", "tdc-lan.mjs", "proxy-guard.sh", "tdc-proxy-lib.mjs", "tdc-xray.mjs", "tdc-proxy.sh"]) {
    await docker(["cp", path.join(ROOT, "docker/rootfs/opt/tdc", file), `${client}:/opt/tdc/${file}`]);
  }
  await exec(client, "root", ["bash", "-c", "chmod 0755 /opt/tdc/*.sh /opt/tdc/*.mjs; bash -n /opt/tdc/proxy-guard.sh"]);
  await sleep(300);
  assert.equal((await curl(client, "root", `http://${publicIp}:18080/info`)).code, 0, "synthetic public destination must be reachable before testing firewall blocks");
  assert.equal((await tcp(client, "root", allowedIp)).code, 0);
  assert.equal((await udp(client, "root", allowedIp)).code, 0);
  const renderer = path.join(ROOT, "src-tauri/target/debug/examples", process.platform === "win32" ? "render_proxy.exe" : "render_proxy");
  const ctl = async (action) => JSON.parse((await exec(client, "root", ["/opt/tdc/tdc-ctl.sh", `proxy-${action}`], { timeout: 120000 })).stdout);
  const guard = (action) => exec(client, "root", ["/opt/tdc/proxy-guard.sh", action, "--allow-lan"], { allowFailure: true });
  for (const engine of ["mihomo", "xray"]) {
    await command(renderer, [temp, "socks5", `socks5://${allowedIp}:1080`, "--allow-lan", `--lan-cidr=${allowedIp}`, `--engine=${engine}`]);
    const config = fs.readFileSync(path.join(temp, "config.yaml"), "utf8");
    const intent = JSON.parse(fs.readFileSync(path.join(temp, "intent.json"), "utf8"));
    await write(client, `${DIR}/config.yaml`, config);
    await write(client, `${DIR}/intent.json`, JSON.stringify(intent));
    const applied = await ctl("apply");
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.ok(Object.values(applied.checks).every(Boolean));
    assert.equal((await guard("check")).code, 0);
    assert.equal((await curl(client, "node", `http://${allowedIp}:18080/info`)).code, 0);
    assert.notEqual((await curl(client, "node", `http://${deniedIp}:18080/info`)).code, 0);
    assert.notEqual((await tcp(client, "node", allowedIp)).code, 0);
    assert.notEqual((await udp(client, "node", allowedIp)).code, 0);
    const proxied = await curl(client, "node", "http://probe.tdc.test:18080/info");
    assert.equal(proxied.code, 0, proxied.stderr);
    assert.equal(JSON.parse(proxied.stdout).viaProxy, true);
    assert.notEqual((await curl(client, "node", `http://${publicIp}:18080/info`, ["--interface", "eth1"])).code, 0);
    assert.deepEqual((await ctl("status")).lan_cidrs, [`${allowedIp}/32`]);
    console.log(`PASS ${engine}: selected LAN reachable, other LAN and TCP/UDP DNS blocked, public hostname proxied and forced public direct blocked`);

    // Pause the daemon under its lock to check an unapplied same-length policy change.
    await exec(client, "root", ["bash", "-c", `exec 9>${DIR}/.lock; flock -w 15 9; kill -STOP "$(cat ${DIR}/daemon.pid)"`]);
    await write(client, `${DIR}/intent.json`, JSON.stringify({ ...intent, lan_cidrs: [`${deniedIp}/32`] }));
    assert.notEqual((await guard("check")).code, 0, "same rule count with a changed destination must not be considered current");
    assert.equal((await guard("apply")).code, 0);
    assert.equal((await guard("check")).code, 0);
    assert.notEqual((await curl(client, "node", `http://${allowedIp}:18080/info`)).code, 0);
    assert.equal((await curl(client, "node", `http://${deniedIp}:18080/info`)).code, 0);
    console.log(`PASS ${engine}: editing to another single IP revokes the previous IP`);

    for (const invalid of [[], ["0.0.0.0/0"]]) {
      await write(client, `${DIR}/intent.json`, JSON.stringify({ ...intent, lan_cidrs: invalid }));
      assert.notEqual((await guard("apply")).code, 0);
      assert.notEqual((await curl(client, "node", `http://${publicIp}:18080/info`)).code, 0);
    }
    await write(client, `${DIR}/intent.json`, JSON.stringify(intent));
    assert.equal((await guard("apply")).code, 0);
    assert.equal((await guard("check")).code, 0, "a valid policy repairs a retained barrier");

    await exec(client, "root", ["bash", "-c", `kill -KILL "$(cat ${DIR}/core.pid)"; if [ -s ${DIR}/xray.pid ]; then kill -KILL "$(cat ${DIR}/xray.pid)"; fi; ip link delete tdc0 2>/dev/null || true`]);
    assert.notEqual((await curl(client, "node", `http://${publicIp}:18080/info`)).code, 0);
    assert.equal((await curl(client, "node", `http://${allowedIp}:18080/info`)).code, 0);
    console.log(`PASS ${engine}: invalid policies fail closed; after both TUN/core stop public traffic stays blocked while explicitly allowed LAN stays reachable`);
    await exec(client, "root", ["bash", "-c", `kill -CONT "$(cat ${DIR}/daemon.pid)"`]);
    assert.equal((await ctl("off")).ok, true);
  }
} catch (error) {
  if (client) {
    const details = await exec(client, "root", ["bash", "-c", `iptables -S TDC_GUARD; ip -4 rule; tail -n 10 ${DIR}/mihomo.log ${DIR}/xray.log 2>/dev/null`], { allowFailure: true });
    console.error(details.stdout);
  }
  throw error;
} finally {
  for (const id of containers.reverse()) await docker(["rm", "-f", "-v", id], { allowFailure: true });
  for (const network of networks.reverse()) await docker(["network", "rm", network], { allowFailure: true });
  const cleanupPath = fs.realpathSync(temp);
  assert.equal(path.dirname(cleanupPath), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(cleanupPath).startsWith("tdc-lan-integration-"));
  fs.rmSync(cleanupPath, { recursive: true, force: true });
  console.log("Disposable LAN test containers, networks, and temporary configuration cleaned up");
}
