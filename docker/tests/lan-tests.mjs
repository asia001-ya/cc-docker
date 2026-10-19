import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { LAN_POLICY, normalizeLanCidrs, lanCidrsFromIntent } from "../rootfs/opt/tdc/tdc-lan.mjs";
import { buildStatus } from "../rootfs/opt/tdc/tdc-proxy-lib.mjs";

const cases = JSON.parse(fs.readFileSync(new URL("./fixtures/lan-cidrs.json", import.meta.url), "utf8"));

test("LAN: shared IPv4/CIDR boundary cases and normalization", () => {
  for (const { input, expected } of cases.valid) assert.deepEqual(normalizeLanCidrs(input), expected);
  for (const input of cases.invalid) assert.throws(() => normalizeLanCidrs(input), input.join(","));
  for (const invalid of [null, "10.0.0.1", [null], [42], Array(LAN_POLICY.maxEntries + 1).fill("10.0.0.1")]) {
    assert.throws(() => normalizeLanCidrs(invalid));
  }
});

test("LAN: only a missing legacy list receives defaults; empty and invalid lists never do", () => {
  assert.deepEqual(lanCidrsFromIntent({}), LAN_POLICY.privateCidrs);
  assert.deepEqual(lanCidrsFromIntent({ lan_cidrs: ["192.168.1.20"] }), ["192.168.1.20/32"]);
  for (const lan_cidrs of [[], null, ["0.0.0.0/0"]]) assert.throws(() => lanCidrsFromIntent({ lan_cidrs }));
});

test("LAN: runtime status reports configured ranges and cannot report an invalid list as healthy", () => {
  const facts = { intent: { enabled: true, allow_lan: true, lan_cidrs: ["10.20.3.4/16"] }, core: { alive: true, age: 100 }, guard: true, tun: true };
  const status = buildStatus(facts);
  assert.equal(status.state, "ok");
  assert.deepEqual(status.lan_cidrs, ["10.20.0.0/16"]);
  const invalid = buildStatus({ ...facts, intent: { ...facts.intent, lan_cidrs: [] } });
  assert.notEqual(invalid.state, "ok");
  assert.equal(invalid.guard, false);
  assert.deepEqual(invalid.lan_cidrs, []);
  assert.ok(invalid.warnings.length);
  assert.deepEqual(buildStatus({ ...facts, intent: { enabled: true, allow_lan: true } }).lan_cidrs, LAN_POLICY.privateCidrs);
  assert.deepEqual(buildStatus({ ...facts, intent: { enabled: true, allow_lan: false } }).lan_cidrs, []);
});
