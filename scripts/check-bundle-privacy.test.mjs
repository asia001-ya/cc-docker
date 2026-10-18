import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkBundlePrivacy, PrivacyCheckError, scanText, validatePricingCatalog, validateTauriConfig } from "./check-bundle-privacy.mjs";

const script = fileURLToPath(new URL("./check-bundle-privacy.mjs", import.meta.url));
const catalog = JSON.parse(await readFile(new URL("../src/data/claude-pricing.json", import.meta.url), "utf8"));
const config = { build: { frontendDist: "../dist" }, bundle: { windows: { nsis: {} } } };

async function fixture(t) {
  const temporaryParent = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryParent, "tdc-privacy-test-"));
  t.after(async () => {
    // Only delete this test's own temporary directory.
    assert.equal(path.dirname(path.resolve(root)), temporaryParent);
    assert.ok(path.basename(root).startsWith("tdc-privacy-test-"));
    await rm(root, { recursive: true, force: true });
  });
  async function write(relative, text) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  await write("src/data/claude-pricing.json", JSON.stringify(catalog));
  await write("src-tauri/tauri.conf.json", JSON.stringify(config));
  await write("docker/rootfs/etc/claude-code/managed-settings.json", '{"statusLine":{"type":"command","command":"node /opt/tdc/statusline.mjs"}}');
  return { root, write };
}

test("the complete public catalog and normal Tauri config pass", () => {
  assert.doesNotThrow(() => validatePricingCatalog(catalog));
  assert.doesNotThrow(() => validateTauriConfig(config));
});

test("unknown provider, proxy, and token fields are rejected at every catalog object level", () => {
  for (const [level, key] of [["catalog", "providers"], ["model", "proxy"], ["pricing", "token"], ["longContext", "account"], ["tierPricing", "accessToken"]]) {
    const value = structuredClone(catalog);
    const model = value.models.find((entry) => entry.longContext);
    const target = { catalog: value, model, pricing: model.pricing, longContext: model.longContext, tierPricing: model.longContext.pricing }[level];
    target[key] = "PRIVATE_VALUE_MUST_NOT_APPEAR";
    assert.throws(() => validatePricingCatalog(value), (error) => error instanceof PrivacyCheckError && !error.message.includes(target[key]));
  }
});

test("public source URLs reject credentials, parameters, fragments, and unrelated hosts", () => {
  for (const url of [
    "https://PRIVATE_VALUE_MUST_NOT_APPEAR@www.anthropic.com/news/model",
    "https://platform.claude.com/docs?token=PRIVATE_VALUE_MUST_NOT_APPEAR",
    "https://www.anthropic.com/news#PRIVATE_VALUE_MUST_NOT_APPEAR",
    "https://www.anthropic.com.example.net/news/model",
    "https://console.anthropic.com/account",
    "http://www.anthropic.com/news/model",
  ]) {
    const value = structuredClone(catalog);
    value.sourceUrl = url;
    assert.throws(() => validatePricingCatalog(value), (error) => error instanceof PrivacyCheckError && !error.message.includes("PRIVATE_VALUE_MUST_NOT_APPEAR"));
  }
});

test("prices must be finite nonnegative numbers", () => {
  for (const rate of [-1, Infinity, NaN, "5", null]) {
    const value = structuredClone(catalog);
    value.models[0].pricing.input = rate;
    assert.throws(() => validatePricingCatalog(value), PrivacyCheckError);
  }
});

test("unchecked frontend/resource paths and custom installers fail closed", () => {
  for (const change of [
    (value) => { value.build.frontendDist = "../private"; },
    (value) => { value.bundle.resources = ["../private/**"]; },
    (value) => { value.bundle.resources = { "../private": "data" }; },
    (value) => { value.bundle.externalBin = ["private-data"]; },
    (value) => { value.bundle.windows.nsis.installerHooks = "private.nsh"; },
    (value) => { value.bundle.windows.nsis.template = "private.nsi"; },
  ]) {
    const value = structuredClone(config);
    change(value);
    assert.throws(() => validateTauriConfig(value), PrivacyCheckError);
  }
});

test("partial Tauri platform and environment overrides cannot bypass resource checks", async (t) => {
  const { root, write } = await fixture(t);
  await write("src-tauri/tauri.windows.conf.json", '{"bundle":{"windows":{"nsis":{"languages":["SimpChinese"]}}}}');
  await assert.doesNotReject(checkBundlePrivacy({ root, platform: "win32", tauriConfig: '{"version":"0.2.0"}' }));
  await assert.rejects(checkBundlePrivacy({ root, platform: "win32", tauriConfig: '{"bundle":{"resources":["PRIVATE_VALUE_MUST_NOT_APPEAR"]}}' }), (error) => error instanceof PrivacyCheckError && !error.message.includes("PRIVATE_VALUE_MUST_NOT_APPEAR"));
  await write("src-tauri/tauri.windows.conf.json", '{"bundle":{"resources":["PRIVATE_VALUE_MUST_NOT_APPEAR"]}}');
  await assert.rejects(checkBundlePrivacy({ root, platform: "win32", tauriConfig: undefined }), (error) => error instanceof PrivacyCheckError && !error.message.includes("PRIVATE_VALUE_MUST_NOT_APPEAR"));
});

test("private runtime filenames are blocked in every public asset root", async (t) => {
  const { root, write } = await fixture(t);
  await assert.doesNotReject(checkBundlePrivacy({ root }));
  for (const relative of ["src/data/providers.json", "src/data/misc.json", "public/nested/proxies.json", "docker/rootfs/home/node/.credentials.json", "public/.env.local", "public/requests.jsonl", "public/.claude.json", "public/sessions.json", "public/proxy.yaml", "public/proxies.yaml", "public/config.yaml", "public/providers.json.bak", "public/proxies.json.tmp", "public/git-sharing.json", "public/.gitconfig", "public/.git-credentials"]) {
    await write(relative, "{}");
    await assert.rejects(checkBundlePrivacy({ root }), PrivacyCheckError);
    await rm(path.join(root, relative));
  }
});

test("directory symlinks cannot bring private files into public assets", async (t) => {
  const { root, write } = await fixture(t);
  await write("outside/private.txt", "synthetic test fixture");
  await symlink(path.join(root, "outside"), path.join(root, "public"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(checkBundlePrivacy({ root }), /symbolic links/);
});

test("production checks reject demo identities and literal credentials without printing them", () => {
  for (const content of [
    'const account="dev1@example.com";',
    'const provider="https://api.example.com";',
    'const proxy="203.0.113.9:1080";',
    `const secret="sk-ant-api03-${"x".repeat(24)}";`,
    'const saved={accessToken:"PRIVATE_VALUE_MUST_NOT_APPEAR"};',
  ]) {
    assert.throws(() => scanText(content, "dist/assets/app.js", { production: true }), (error) => error instanceof PrivacyCheckError && !error.message.includes(content) && !error.message.includes("PRIVATE_VALUE_MUST_NOT_APPEAR"));
  }
  assert.doesNotThrow(() => scanText('const env="ANTHROPIC_API_KEY"; const saved={token:input.value};', "dist/assets/app.js", { production: true }));
  assert.doesNotThrow(() => scanText('供应商 Token: "请填入供应商提供的令牌，仅保存在本机"', "dist/assets/app.js", { production: true }));
  assert.doesNotThrow(() => scanText('API Token: "Enter your provider token"', "dist/assets/app.js", { production: true }));
});

test("pre-build skips stale dist, post-build inspects it and requires it to exist", async (t) => {
  const { root, write } = await fixture(t);
  await assert.rejects(checkBundlePrivacy({ root, dist: true }), /required build input/);
  await write("dist/assets/app.js", 'const sample="dev1@example.com";');
  await assert.doesNotReject(checkBundlePrivacy({ root }));
  await assert.rejects(checkBundlePrivacy({ root, dist: true }), /production assets/);
  await write("dist/assets/app.js", 'const app="Claude pricing";');
  await assert.doesNotReject(checkBundlePrivacy({ root, dist: true }));
});

test("CLI exits nonzero on invalid JSON and never forwards parser excerpts", async (t) => {
  const { root, write } = await fixture(t);
  await write("src/data/claude-pricing.json", "PRIVATE_VALUE_MUST_NOT_APPEAR");
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid JSON/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes("PRIVATE_VALUE_MUST_NOT_APPEAR"));
});
