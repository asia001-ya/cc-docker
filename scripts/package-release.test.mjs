import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { packageRelease, parseArguments } from "./package-release.mjs";

async function fixture(t) {
  const temporaryParent = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryParent, "tdc-release-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), temporaryParent);
    assert.ok(path.basename(root).startsWith("tdc-release-test-"));
    await rm(root, { recursive: true, force: true });
  });
  async function write(relative, value) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, value);
  }
  const version = "1.2.3";
  const portable = Buffer.from("MZsynthetic portable binary");
  const setup = Buffer.from("MZsynthetic installer binary");
  await write("package.json", JSON.stringify({ version }));
  await write("package-lock.json", JSON.stringify({ version, packages: { "": { version } } }));
  await write("src-tauri/tauri.conf.json", JSON.stringify({ version, productName: "Claude 多容器终端" }));
  await write("src-tauri/Cargo.toml", `[package]\nname = "tht-docker-claude"\nversion = "${version}"\n\n[lib]\nname = "tdc_lib"\n`);
  await write("src-tauri/Cargo.lock", `version = 4\n\n[[package]]\nname = "dependency"\nversion = "9.9.9"\n\n[[package]]\nname = "tht-docker-claude"\nversion = "${version}"\n`);
  await write("src-tauri/target/release/tht-docker-claude.exe", portable);
  await write(`src-tauri/target/release/bundle/nsis/Claude 多容器终端_${version}_x64-setup.exe`, setup);
  await write("src-tauri/target/release/nsis/x64/installer.nsi", `!define VERSION "${version}"\n`);
  await write("src-tauri/target/release/providers.json", '{"private":"must never be packaged"}');
  return { root, write, version, portable, setup };
}

test("packages exact canonical assets and checksums without copying other build files", async (t) => {
  const { root, version, portable, setup } = await fixture(t);
  const result = await packageRelease({ root });
  assert.equal(result.version, version);
  assert.equal(result.output, path.join(root, "src-tauri/target/release/release-assets", `v${version}`));
  const names = [`cc-docker-${version}-windows-x64.exe`, `cc-docker-${version}-windows-x64-setup.exe`];
  assert.deepEqual((await readdir(result.output)).sort(), [...names, "SHA256SUMS.txt"].sort());
  const sums = await readFile(path.join(result.output, "SHA256SUMS.txt"), "utf8");
  for (const [index, bytes] of [portable, setup].entries()) {
    assert.deepEqual(await readFile(path.join(result.output, names[index])), bytes);
    assert.equal(result.assets[index].sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(result.assets[index].size, bytes.length);
    assert.ok(sums.includes(`${result.assets[index].sha256}  ${names[index]}\n`));
  }
  assert.deepEqual(await readFile(path.join(root, "src-tauri/target/release/tht-docker-claude.exe")), portable);
});

test("rejects inconsistent project and lockfile versions before creating output", async (t) => {
  for (const [relative, text] of [
    ["src-tauri/tauri.conf.json", '{"version":"1.2.4","productName":"Claude 多容器终端"}'],
    ["src-tauri/Cargo.toml", '[package]\nname = "tht-docker-claude"\nversion = "1.2.4"\n'],
    ["package-lock.json", '{"version":"1.2.4","packages":{"":{"version":"1.2.3"}}}'],
    ["package-lock.json", '{"version":"1.2.3","packages":{"":{"version":"1.2.4"}}}'],
    ["src-tauri/Cargo.lock", '[[package]]\nname = "tht-docker-claude"\nversion = "1.2.4"\n'],
  ]) {
    const { root, write } = await fixture(t);
    await write(relative, text);
    const output = path.join(root, "output");
    await assert.rejects(packageRelease({ root, output }), /version must match/);
    await assert.rejects(readdir(output), { code: "ENOENT" });
  }
});

test("rejects missing, non-executable and stale installer outputs", async (t) => {
  for (const failure of ["missing", "invalid", "stale"]) {
    const { root, write } = await fixture(t);
    if (failure === "missing") await rm(path.join(root, "src-tauri/target/release/tht-docker-claude.exe"));
    if (failure === "invalid") await write("src-tauri/target/release/tht-docker-claude.exe", "private text");
    if (failure === "stale") await write("src-tauri/target/release/nsis/x64/installer.nsi", '!define VERSION "1.2.2"\n');
    await assert.rejects(packageRelease({ root }), /Missing build output|not a Windows executable|installer version is stale/);
    await assert.rejects(readdir(path.join(root, "src-tauri/target/release/release-assets")), { code: "ENOENT" });
  }
});

test("preserves existing output and supports a new explicit destination", async (t) => {
  const { root, write } = await fixture(t);
  const output = path.join(root, "existing");
  await write("existing/note.txt", "keep this file");
  await assert.rejects(packageRelease({ root, output }), /already exists/);
  assert.equal(await readFile(path.join(output, "note.txt"), "utf8"), "keep this file");
  assert.deepEqual(await readdir(output), ["note.txt"]);
  const destination = path.join(root, "new output", "release");
  assert.equal((await packageRelease({ root, output: destination })).output, destination);
});

test("rejects versions and metadata that cannot safely name release assets", async (t) => {
  for (const version of ["v1.2.3", "01.2.3", "1.2.3-beta.1", "1.2.3+build", "../other"]) {
    const { root, write } = await fixture(t);
    await write("package.json", JSON.stringify({ version }));
    await assert.rejects(packageRelease({ root }), /stable major.minor.patch/);
  }
  const { root, write } = await fixture(t);
  await write("src-tauri/tauri.conf.json", '{"version":"1.2.3","productName":"../other"}');
  await assert.rejects(packageRelease({ root }), /product name is invalid/);
});

test("CLI accepts only a single explicit output directory", () => {
  assert.deepEqual(parseArguments([]), {});
  assert.deepEqual(parseArguments(["--output", "D:/release/v1.2.3"]), { output: "D:/release/v1.2.3" });
  for (const args of [["--output"], ["--output", ""], ["--force"], ["--output", "new", "extra"]]) {
    assert.throws(() => parseArguments(args), /Usage:/);
  }
});
