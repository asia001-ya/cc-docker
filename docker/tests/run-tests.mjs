/**
 * 容器侧脚本单元测试（node:test，无第三方依赖）
 *
 * 运行：node --test docker/tests/run-tests.mjs
 * 覆盖：statusline.mjs（额度快照合并、会话映射、原子写入）、tdc-lib.mjs（健康度、候选排序）、
 *       tdc-proxy-lib.mjs（代理状态分类）、proxy-guard.sh（兜底规则序列，需要 bash）、
 *       portwatch.sh（/proc/net/tcp 解析，需要 bash）、脚本 LF 换行检查。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { run, buildQuotaSnapshot, sessionKey, normalizePercent, normalizeEpochSeconds } from "../rootfs/opt/tdc/statusline.mjs";
import { healthOf, remainingOf, rankCandidates, blockedUntil, normalizeContainer } from "../rootfs/opt/tdc/tdc-lib.mjs";
import { classify, buildStatus, summarizeProviders, isoToEpoch } from "../rootfs/opt/tdc/tdc-proxy-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures");
const ROOTFS = path.join(HERE, "..", "rootfs", "opt", "tdc");

/**
 * 读取 fixture 文本。
 * @param {string} name 文件名
 * @returns {string} 文件内容
 */
function fixture(name) {
  return fs.readFileSync(path.join(FIX, name), "utf8");
}

/**
 * 创建临时状态目录。
 * @returns {string} 目录路径
 */
function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tdc-state-"));
}

test("statusline：订阅模式写入 quota.json 与会话映射", () => {
  const dir = tmpStateDir();
  const env = { TDC_STATE_DIR: dir, TDC_CONTAINER_NAME: "claude-dev-01", TDC_SESSION_ID: "a1b2c3d4" };
  const line = run(fixture("statusline-subscription.json"), env, 1792120000);

  const quota = JSON.parse(fs.readFileSync(path.join(dir, "quota.json"), "utf8"));
  assert.equal(quota.protocol, 1);
  assert.equal(quota.container, "claude-dev-01");
  assert.equal(quota.auth_hint, "subscription");
  assert.deepEqual(quota.five_hour, { used_percentage: 15.3, resets_at: 1792130400 });
  assert.deepEqual(quota.seven_day, { used_percentage: 40, resets_at: 1792562400 });
  assert.equal(quota.rate_limits_updated_at, 1792120000);
  assert.equal(quota.model.display_name, "Opus 5.5");
  assert.equal(quota.last_session.cwd, "/workspace/app/src");

  const sess = JSON.parse(fs.readFileSync(path.join(dir, "sessions", "a1b2c3d4.json"), "utf8"));
  assert.equal(sess.session_id, "7d1f3c2a-1111-4c2b-9a77-0123456789ab");
  assert.equal(sess.tdc_session_id, "a1b2c3d4");
  assert.equal(sess.context_used_percentage, 12.3);

  assert.match(line, /Opus 5.5/);
  const rendered = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  assert.match(rendered, /200K/);
  assert.match(rendered, /ctx \[.*\] 12%/);
  assert.match(line, /\x1b\[38;2;/, "状态行应包含 24-bit 真彩转义");
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0, "不应残留临时文件");
});

test("statusline：缺少 rate_limits 时保留上次额度，API 环境标记为 api", () => {
  const dir = tmpStateDir();
  run(fixture("statusline-subscription.json"), { TDC_STATE_DIR: dir }, 1792120000);
  const line = run(fixture("statusline-api.json"), { TDC_STATE_DIR: dir, ANTHROPIC_BASE_URL: "https://example.invalid" }, 1792120100);
  const quota = JSON.parse(fs.readFileSync(path.join(dir, "quota.json"), "utf8"));
  assert.equal(quota.updated_at, 1792120100);
  assert.equal(quota.rate_limits_updated_at, 1792120000, "额度时间戳不应被无数据的刷新覆盖");
  assert.equal(quota.five_hour.used_percentage, 15.3);
  assert.equal(quota.auth_hint, "api");
  assert.equal(quota.model.display_name, "Sonnet 5");
  assert.ok(fs.existsSync(path.join(dir, "sessions", "claude-9a9a9a9a-2222-4c2b-9a77-0123456789ab.json")));
  assert.match(line, /Sonnet 5/);
});

test("statusline：非法输入不抛异常", () => {
  const dir = tmpStateDir();
  assert.doesNotThrow(() => run("{坏 json", { TDC_STATE_DIR: dir }, 1));
  assert.doesNotThrow(() => run("", { TDC_STATE_DIR: path.join(dir, "a", "b") }, 1));
  const q = buildQuotaSnapshot({ protocol: 999, five_hour: { used_percentage: 1 } }, {}, {}, 1);
  assert.equal(q.five_hour, null, "协议版本不符的旧快照应被丢弃");
});

test("statusline：数值规整与会话键过滤", () => {
  assert.equal(normalizePercent(120), 100);
  assert.equal(normalizePercent(-3), 0);
  assert.equal(normalizePercent("50"), null);
  assert.equal(normalizeEpochSeconds(1792120000123), 1792120000);
  assert.equal(normalizeEpochSeconds(0), null);
  assert.equal(sessionKey({}, { TDC_SESSION_ID: "../../etc/x" }), "etcx");
  assert.equal(sessionKey({}, {}), null);
});

test("tdc-lib：健康度、剩余额度、候选排序与共享用例一致", () => {
  const cases = JSON.parse(fixture("ranking-cases.json"));
  const list = cases.containers.map(normalizeContainer);
  for (const c of list) {
    assert.equal(healthOf(c, cases.now, cases.settings), cases.expect.health[c.name], `health ${c.name}`);
  }
  for (const [name, expected] of Object.entries(cases.expect.remaining)) {
    const r = remainingOf(list.find((c) => c.name === name).quota, cases.now);
    assert.equal(r === null ? null : r.remaining, expected, `remaining ${name}`);
  }
  assert.deepEqual(rankCandidates(list, "claude-dev-01", cases.now, cases.settings).map((c) => c.name), cases.expect.rank_default);
  assert.deepEqual(
    rankCandidates(list, "claude-dev-01", cases.now, { ...cases.settings, include_stopped: true, allow_api_fallback: true }).map((c) => c.name),
    cases.expect.rank_with_stopped_and_api,
  );
  assert.equal(blockedUntil(list[0].quota, cases.now, 100), cases.expect.blocked_until_01);
});

test("tdc-lib：snapshot 形态的输入可被规范化", () => {
  const c = normalizeContainer({ name: "x", running: true, snapshot: { provider: { mode: "api" }, quota: { five_hour: null } } });
  assert.equal(c.auth_mode, "api");
  assert.deepEqual(c.quota, { five_hour: null });
});

/**
 * 查找可用的 bash（Windows 上优先 Git Bash）。
 * @returns {string|null} bash 路径，找不到返回 null
 */
function findBash() {
  for (const cand of ["bash", "C:\\Program Files\\Git\\bin\\bash.exe"]) {
    const r = spawnSync(cand, ["-c", "echo ok"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "ok") return cand;
  }
  return null;
}

test("portwatch：解析 LISTEN 端口、合并 IPv4/IPv6、识别仅环回绑定", { skip: findBash() === null && "未找到 bash" }, () => {
  const bash = findBash();
  const r = spawnSync(bash, [path.join(ROOTFS, "portwatch.sh"), "--once"], {
    encoding: "utf8",
    env: { ...process.env, PROC_NET_DIR: path.join(FIX, "proc", "net"), PROC_ROOT: path.join(FIX, "proc") },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const byPort = Object.fromEntries(out.ports.map((p) => [p.port, p]));
  assert.deepEqual(Object.keys(byPort).map(Number).sort((a, b) => a - b), [3000, 5173, 8080]);
  assert.equal(byPort[3000].family, "dual");
  assert.equal(byPort[3000].loopback_only, false);
  assert.deepEqual(byPort[3000].binds.sort(), ["0.0.0.0", "::"]);
  assert.equal(byPort[5173].loopback_only, true, "127.0.0.1 绑定应标记为仅环回");
  assert.equal(byPort[5173].binds.length, 1, "ESTABLISHED 连接不应计入");
  assert.equal(byPort[8080].family, "ipv6");
  assert.equal(byPort[8080].loopback_only, true);
});

test("tdc-proxy-lib：状态分类覆盖 off / starting / ok / blackhole / leak", () => {
  const f = (o) => ({ enabled: true, guard: true, core_alive: true, tun: true, core_age: 100, ...o });
  assert.equal(classify(f({ enabled: false, guard: false })), "off");
  assert.equal(classify(f({ enabled: false, guard: true })), "blackhole", "关闭后兜底残留也算断网");
  assert.equal(classify(f({})), "ok");
  assert.equal(classify(f({ guard: false })), "leak", "启用但兜底缺失必须判为泄露");
  assert.equal(classify(f({ guard: false, core_alive: false })), "leak");
  assert.equal(classify(f({ tun: false, core_age: 3 })), "starting");
  assert.equal(classify(f({ tun: false, core_age: 60 })), "blackhole", "超过宽限期 TUN 仍未就绪");
  assert.equal(classify(f({ core_alive: false, tun: false, core_age: null })), "blackhole");
});

test("tdc-proxy-lib：provider 摘要与状态文件字段", () => {
  assert.equal(isoToEpoch("0001-01-01T00:00:00Z"), null, "mihomo 未更新过的 provider 返回零值时间");
  assert.equal(isoToEpoch("2026-10-17T04:00:00Z"), 1792209600);
  const providers = summarizeProviders({
    providers: {
      default: { name: "default", vehicleType: "Compatible", proxies: [{}] },
      sub: { name: "sub", vehicleType: "HTTP", proxies: [{}, {}], updatedAt: "2026-10-17T04:00:00Z" },
    },
  });
  assert.deepEqual(providers, [{ name: "sub", count: 2, updated_at: 1792209600 }]);

  const st = buildStatus({
    now: 1792123300,
    intent: { enabled: true, allow_lan: true, selected: "香港 01" },
    core: { pid: 42, alive: true, age: 30 },
    tun: true,
    guard: true,
    restarts: 2,
    last_error: "",
    controller: { now: "日本 02", providers: { providers: { sub: { name: "sub", vehicleType: "HTTP", proxies: [] } } } },
  });
  assert.equal(st.protocol, 1);
  assert.equal(st.state, "ok");
  assert.equal(st.core_pid, 42);
  assert.equal(st.allow_lan, true);
  assert.equal(st.selected, "日本 02");
  assert.equal(st.last_error, null);
  assert.equal(st.restarts, 2);
  assert.ok(st.warnings.some((w) => w.includes("没有拉到任何节点")));
  assert.ok(st.warnings.some((w) => w.includes("香港 01")));
  assert.equal(buildStatus(null).state, "off", "非法输入不抛异常");
});

test("proxy-guard：兜底规则序列（默认禁止局域网 / 放行局域网但仍拒绝 53）", { skip: findBash() === null && "未找到 bash" }, () => {
  const bash = findBash();
  const run = (...args) => {
    const r = spawnSync(bash, [path.join(ROOTFS, "proxy-guard.sh"), "--print", ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().split(/\r?\n/);
  };
  const strict = run();
  const v4 = strict.filter((l) => l.startsWith("iptables "));
  assert.equal(v4[0], "iptables -A TDC_GUARD -d 127.0.0.11/32 -o lo -m owner ! --uid-owner 0 -j REJECT --reject-with icmp-port-unreachable", "Docker 内嵌 DNS 必须先于 lo 放行被拒绝");
  assert.ok(v4.includes("iptables -A TDC_GUARD -m conntrack --ctstate RELATED,ESTABLISHED --ctdir REPLY -j RETURN"), "只放行回包方向");
  assert.ok(v4.includes("iptables -A TDC_GUARD -o tdc0 -j RETURN"));
  assert.ok(v4.includes("iptables -A TDC_GUARD -m owner --uid-owner 0 -j RETURN"));
  assert.equal(v4.at(-1), "iptables -A TDC_GUARD -j REJECT --reject-with icmp-port-unreachable", "末条必须是拒绝");
  assert.ok(!v4.some((l) => l.includes("192.168.0.0/16")), "默认不放行局域网");
  assert.ok(strict.some((l) => l.startsWith("ip6tables ")), "IPv6 也有兜底");

  const lan = run("--allow-lan").filter((l) => l.startsWith("iptables "));
  const idx = (needle) => lan.findIndex((l) => l.includes(needle));
  assert.ok(idx("-d 192.168.0.0/16 -p udp -m udp --dport 53 -j REJECT") >= 0);
  assert.ok(idx("-d 192.168.0.0/16 -j RETURN") > idx("-d 192.168.0.0/16 -p udp -m udp --dport 53 -j REJECT"), "53 端口拒绝必须在网段放行之前");
  assert.equal(lan.at(-1), "iptables -A TDC_GUARD -j REJECT --reject-with icmp-port-unreachable");
});

test("tdc-proxy：非 root 执行时拒绝并输出 JSON", { skip: (findBash() === null || process.platform === "win32") && "需要 Linux bash" }, () => {
  const r = spawnSync(findBash(), [path.join(ROOTFS, "tdc-proxy.sh"), "status"], { encoding: "utf8" });
  if (process.getuid && process.getuid() === 0) return;
  assert.equal(r.status, 2);
  assert.match(r.stdout, /"stage":"auth"/);
});

test("容器脚本均为 LF 换行且带 shebang", () => {
  const files = [
    ...fs.readdirSync(ROOTFS).map((f) => path.join(ROOTFS, f)),
    path.join(HERE, "..", "scripts", "tdc-quota.sh"),
    path.join(HERE, "..", "scripts", "tdc-switch.sh"),
    path.join(HERE, "..", "tmux.conf"),
  ];
  for (const f of files) {
    const body = fs.readFileSync(f, "utf8");
    assert.ok(!body.includes("\r\n"), `${path.basename(f)} 含 CRLF`);
    if (/\.(sh|mjs)$/.test(f)) assert.ok(body.startsWith("#!/usr/bin/env "), `${path.basename(f)} 缺少 shebang`);
  }
});
