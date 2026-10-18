import assert from "node:assert/strict";
import test from "node:test";
import { buildRuntime, parseVless, parseSocks, parseSubscription } from "../rootfs/opt/tdc/tdc-xray.mjs";
import { buildStatus } from "../rootfs/opt/tdc/tdc-proxy-lib.mjs";

const UUID = "11111111-1111-4111-8111-111111111111";
const link = `vless://${UUID}@example.test:443?security=reality&type=tcp&fp=chrome&sni=example.net&pbk=public-key&sid=abcd&pqv=post-quantum-key&flow=xtls-rprx-vision#${encodeURIComponent("香港 01")}`;
const base = (changes = {}) => ({
  tun: { enable: true, "strict-route": true, "dns-hijack": ["any:53"] },
  "tdc-xray": { node: { name: "测试订阅", kind: "subscription", secret: "http://example.test/sub" }, bootstrapDns: ["https://1.1.1.1/dns-query"], ...changes },
});

test("Xray：REALITY 分享链接保留公钥、short ID、pqv 与 flow", () => {
  const node = parseVless(link);
  const reality = node.outbound.streamSettings.realitySettings;
  assert.equal(node.name, "香港 01");
  assert.equal(reality.publicKey, "public-key");
  assert.equal(reality.shortId, "abcd");
  assert.equal(reality.mldsa65Verify, "post-quantum-key");
  assert.equal(reality.fingerprint, "chrome");
  assert.equal(node.outbound.settings.vnext[0].users[0].flow, "xtls-rprx-vision");
});

test("Xray：分享列表与标准 / URL-safe Base64 支持中文名称", () => {
  for (const body of [link, Buffer.from(link).toString("base64"), Buffer.from(link).toString("base64url")]) {
    const parsed = parseSubscription(body);
    assert.equal(parsed.nodes.length, 1);
    assert.equal(parsed.nodes[0].name, "香港 01");
    assert.deepEqual(parsed.warnings, []);
  }
  assert.equal(parseSubscription(`${link}\nss://unsupported`).warnings.length, 1);
  for (const body of ["", "<html>expired subscription</html>", "proxies:\n  - name: invalid", "abc!!", "ss://unsupported"]) {
    assert.throws(() => parseSubscription(body), /订阅/);
  }
  assert.throws(() => parseSubscription(Array(257).fill(link).join("\n")), /最多支持/);
});

test("Xray：三跳链路在选节点后仍经过指定出口，默认拒绝未匹配流量", () => {
  const runtime = buildRuntime(base({
    static: { kind: "vless", name: "中转", secret: `vless://${UUID}@relay.test:443?security=tls&type=ws&path=%2Frelay` },
    exit: { kind: "socks5", name: "出口", secret: "socks5://u%40x:p%3A%2F%40@exit.test:1080" },
  }), [parseVless(link), parseVless(link)], "temporary-test-password");
  assert.equal(runtime.xray.outbounds[0].protocol, "blackhole");
  assert.deepEqual(runtime.names, ["香港 01", "香港 01 [2]"]);
  for (const index of [0, 1]) {
    assert.equal(runtime.xray.outbounds.find((o) => o.tag === `NODE_${index}`).streamSettings.sockopt.dialerProxy, "STATIC");
    const exit = runtime.xray.outbounds.find((o) => o.tag === `EXIT_${index}`);
    assert.equal(exit.streamSettings.sockopt.dialerProxy, `NODE_${index}`);
    assert.deepEqual(exit.settings.servers[0].users, [{ user: "u@x", pass: "p:/@" }]);
    assert.equal(runtime.xray.routing.rules[index].outboundTag, `EXIT_${index}`);
    assert.equal(runtime.xray.inbounds[index].listen, "127.0.0.1");
    assert.equal(runtime.mihomo.proxies[index].udp, false);
  }
  assert.deepEqual(runtime.mihomo.rules, ["MATCH,NODE"]);
  assert.deepEqual(runtime.mihomo.tun["exclude-uid"], [0]);
  assert.equal(runtime.mihomo.tun["strict-route"], true);
  assert.equal(runtime.mihomo["tdc-xray"], undefined);
  assert.deepEqual(runtime.xray.dns.servers, ["https+local://1.1.1.1/dns-query"]);
});

test("Xray：直接节点保留 UDP，名称避开内核保留字", () => {
  const runtime = buildRuntime(base(), [{ ...parseVless(link), name: "DIRECT" }]);
  assert.equal(runtime.names[0], "DIRECT (节点)");
  assert.equal(runtime.mihomo.proxies[0].udp, true);
  assert.equal(runtime.xray.routing.rules[0].outboundTag, "NODE_0");
  assert.throws(() => buildRuntime(base(), []), /节点数量/);
});

test("Xray：TLS、WS、gRPC、XHTTP 与 IPv6 字段不丢失", () => {
  const ws = parseVless(`vless://${UUID}@[2001:db8::1]:443?security=tls&type=ws&host=ws.test&path=%2Fchat&alpn=h2%2Chttp%2F1.1`).outbound;
  assert.equal(ws.settings.vnext[0].address, "2001:db8::1");
  assert.deepEqual(ws.streamSettings.wsSettings, { path: "/chat", headers: { Host: "ws.test" } });
  assert.deepEqual(ws.streamSettings.tlsSettings.alpn, ["h2", "http/1.1"]);
  const grpc = parseVless(`vless://${UUID}@example.test:443?security=tls&type=grpc&serviceName=svc&authority=grpc.test&mode=multi`).outbound;
  assert.deepEqual(grpc.streamSettings.grpcSettings, { serviceName: "svc", authority: "grpc.test", multiMode: true });
  const xhttp = parseVless(`vless://${UUID}@example.test:443?security=tls&type=xhttp&path=%2Fapi&mode=packet-up`).outbound;
  assert.equal(xhttp.streamSettings.xhttpSettings.mode, "packet-up");
  assert.throws(() => parseVless(`vless://${UUID}@example.test:443?type=xhttp&extra=%7B%7D`), /extra/);
});

test("Xray：畸形地址错误不会包含节点凭据", () => {
  for (const input of ["vless://private-value", "vless://secret-user@example.test:443?security=unsupported", "vless://secret-user@example.test:443?security=reality"]) {
    assert.throws(() => parseVless(input), (e) => !e.message.includes("private-value") && !e.message.includes("secret-user"));
  }
  assert.equal(parseSocks("socks5://user:p%40ss@[::1]:1080").outbound.settings.servers[0].address, "::1");
});

test("Xray：任一内核失效的事实触发断网状态，并向前端传递 Xray 信息", () => {
  const status = buildStatus({ intent: { enabled: true, engine: "xray" }, core: { alive: false, pid: 10, age: 20 }, guard: true, tun: true, xray: { pid: null, warnings: ["订阅暂不可更新"] } });
  assert.equal(status.state, "blackhole");
  assert.equal(status.engine, "xray");
  assert.equal(status.xray_pid, null);
  assert.deepEqual(status.warnings, ["订阅暂不可更新"]);
  assert.equal(buildStatus({}).engine, "mihomo");
});
