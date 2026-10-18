import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyHostConfig, prepareHostMcp } from "../rootfs/opt/tdc/tdc-host-config.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdc-host-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { configDir: path.join(root, "private"), sharedDir: path.join(root, "shared"), hostRoot: path.join(root, "host") };
  for (const dir of Object.values(options)) fs.mkdirSync(dir);
  const put = (base, item, text = "fixture") => {
    const file = path.join(base, item);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  return { root, options, put, apply: () => applyHostConfig(options), backup: (item) => path.join(options.configDir, "tdc", "host-config-backup", item) };
}

function symlink(t, target, file, kind = "dir") {
  try { fs.symlinkSync(target, file, kind === "dir" && process.platform === "win32" ? "junction" : kind); return true; }
  catch (error) { if (process.platform === "win32" && error.code === "EPERM") { t.skip("Windows 未启用文件符号链接权限；Linux 隔离测试覆盖此项"); return false; } throw error; }
}

test("宿主配置：未挂载时保留本地内容，只给空位链接原共享池", (t) => {
  const f = fixture(t), { configDir, sharedDir } = f.options;
  f.put(configDir, "skills/local.txt", "private");
  f.put(sharedDir, "skills/shared.txt", "shared");
  f.put(sharedDir, "commands/shared.txt", "command");
  assert.deepEqual(f.apply().issues, []);
  assert.equal(fs.readFileSync(path.join(configDir, "skills/local.txt"), "utf8"), "private");
  assert.equal(fs.lstatSync(path.join(configDir, "skills")).isSymbolicLink(), false);
  assert.equal(fs.realpathSync(path.join(configDir, "commands")), fs.realpathSync(path.join(sharedDir, "commands")));
});

test("宿主配置：目录覆盖幂等且实时读取宿主，关闭挂载还原原目录", (t) => {
  const f = fixture(t), { configDir, hostRoot } = f.options;
  f.put(configDir, "skills/native.txt", "original");
  f.put(hostRoot, "skills/host.txt", "host-one");
  assert.deepEqual(f.apply().applied, ["skills"]);
  assert.deepEqual(f.apply().issues, []);
  assert.equal(fs.readFileSync(f.backup("skills/native.txt"), "utf8"), "original");
  f.put(hostRoot, "skills/host.txt", "host-two");
  assert.equal(fs.readFileSync(path.join(configDir, "skills/host.txt"), "utf8"), "host-two");
  fs.renameSync(path.join(hostRoot, "skills"), path.join(f.root, "previous-host-skills"));
  f.put(hostRoot, "skills/new.txt", "new-mount-source");
  assert.deepEqual(f.apply().issues, []);
  assert.equal(fs.readFileSync(path.join(configDir, "skills/new.txt"), "utf8"), "new-mount-source");
  fs.renameSync(path.join(hostRoot, "skills"), path.join(f.root, "removed-host-skills"));
  assert.deepEqual(f.apply().restored, ["skills"]);
  assert.equal(fs.readFileSync(path.join(configDir, "skills/native.txt"), "utf8"), "original");
  assert.equal(fs.lstatSync(path.join(configDir, "skills")).isSymbolicLink(), false);
  assert.deepEqual(f.apply().issues, []);
});

test("宿主配置：覆盖共享链接后原样还原，共享池不发生写入", (t) => {
  const f = fixture(t), { configDir, sharedDir, hostRoot } = f.options;
  f.put(sharedDir, "skills/shared.txt", "shared-original");
  f.apply();
  const previous = fs.readlinkSync(path.join(configDir, "skills"));
  f.put(hostRoot, "skills/host.txt", "host");
  f.apply();
  assert.equal(fs.readlinkSync(f.backup("skills")), previous);
  assert.equal(fs.readFileSync(path.join(sharedDir, "skills/shared.txt"), "utf8"), "shared-original");
  fs.renameSync(path.join(hostRoot, "skills"), path.join(f.root, "removed"));
  f.apply();
  assert.equal(fs.readlinkSync(path.join(configDir, "skills")), previous);
  assert.deepEqual(fs.readdirSync(path.join(sharedDir, "skills")), ["shared.txt"]);
});

test("宿主配置：原来没有配置，停用后恢复空位或沿用共享项", (t) => {
  const f = fixture(t), { configDir, sharedDir, hostRoot } = f.options;
  f.put(hostRoot, "agents/agent.md", "host-agent");
  f.apply();
  fs.renameSync(path.join(hostRoot, "agents"), path.join(f.root, "removed-agents"));
  f.apply();
  assert.equal(fs.existsSync(path.join(configDir, "agents")), false);
  f.put(sharedDir, "agents/shared.md", "shared-agent");
  f.apply();
  assert.equal(fs.realpathSync(path.join(configDir, "agents")), fs.realpathSync(path.join(sharedDir, "agents")));
});

test("宿主配置：CLAUDE.md 文件可逆覆盖，原文件内容和权限不变", (t) => {
  const f = fixture(t), { configDir, hostRoot } = f.options;
  const native = f.put(configDir, "CLAUDE.md", "private instructions");
  const source = f.put(hostRoot, "CLAUDE.md", "host instructions");
  const probe = path.join(f.root, "symlink-probe");
  if (!symlink(t, source, probe, "file")) return;
  fs.unlinkSync(probe);
  fs.chmodSync(native, 0o600);
  assert.deepEqual(f.apply().issues, []);
  assert.equal(fs.readFileSync(native, "utf8"), "host instructions");
  fs.renameSync(source, path.join(f.root, "removed-instructions"));
  assert.deepEqual(f.apply().issues, []);
  assert.equal(fs.readFileSync(native, "utf8"), "private instructions");
  if (process.platform !== "win32") assert.equal(fs.statSync(native).mode & 0o777, 0o600);
});

test("宿主配置：保留用户自建链接，共享池不会抢占恢复后的链接", (t) => {
  const f = fixture(t), { configDir, sharedDir, hostRoot } = f.options;
  const original = path.join(f.root, "custom-commands");
  fs.mkdirSync(original);
  f.put(original, "mine.txt", "user-owned");
  symlink(t, original, path.join(configDir, "commands"));
  f.put(sharedDir, "commands/shared.txt");
  f.put(hostRoot, "commands/host.txt");
  f.apply();
  fs.renameSync(path.join(hostRoot, "commands"), path.join(f.root, "removed-commands"));
  f.apply();
  f.apply();
  assert.equal(fs.realpathSync(path.join(configDir, "commands")), fs.realpathSync(original));
});

test("宿主配置：应用期间用户另建的本地内容不会被删除，原备份仍保留", (t) => {
  const f = fixture(t), { configDir, hostRoot } = f.options;
  f.put(configDir, "skills/original.txt", "original");
  f.put(hostRoot, "skills/host.txt");
  f.apply();
  fs.unlinkSync(path.join(configDir, "skills"));
  f.put(configDir, "skills/new-local.txt", "user change");
  assert.deepEqual(f.apply().issues, [{ item: "skills", code: "local-change-preserved" }]);
  fs.renameSync(path.join(hostRoot, "skills"), path.join(f.root, "removed"));
  assert.deepEqual(f.apply().issues, [{ item: "skills", code: "local-change-preserved" }]);
  assert.equal(fs.readFileSync(path.join(configDir, "skills/new-local.txt"), "utf8"), "user change");
  assert.equal(fs.readFileSync(f.backup("skills/original.txt"), "utf8"), "original");
});

test("宿主配置：缺失或类型不符的挂载不覆盖本地，损坏状态不进行危险恢复", (t) => {
  const f = fixture(t), { configDir, hostRoot } = f.options;
  f.put(configDir, "skills/native.txt", "private");
  f.put(hostRoot, "skills", "not a directory");
  assert.deepEqual(f.apply().applied, []);
  f.put(configDir, "tdc/host-config-backup/state.json", "invalid state with fake secret");
  const result = f.apply();
  assert.deepEqual(result.issues, [{ item: "state", code: "invalid-backup-state" }]);
  assert.equal(JSON.stringify(result).includes("fake secret"), false);
  assert.equal(fs.readFileSync(path.join(configDir, "skills/native.txt"), "utf8"), "private");
});

test("宿主配置：node 无权读取宿主目录时报错并保留本地配置", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "需非 root Linux 权限；隔离容器覆盖" : false }, (t) => {
  const f = fixture(t), { configDir, hostRoot } = f.options;
  f.put(configDir, "skills/native.txt", "private");
  f.put(hostRoot, "skills/host.txt", "host");
  const source = path.join(hostRoot, "skills");
  fs.chmodSync(source, 0o000);
  try {
    assert.deepEqual(f.apply().issues, [{ item: "skills", code: "config-update-failed" }]);
    assert.equal(fs.lstatSync(path.join(configDir, "skills")).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(configDir, "skills/native.txt"), "utf8"), "private");
  } finally {
    fs.chmodSync(source, 0o755);
  }
});

test("宿主配置：备份后被中断可继续应用，再停用时恢复原件", (t) => {
  const f = fixture(t), { configDir, hostRoot } = f.options;
  f.put(configDir, "tdc/host-config-backup/skills/original.txt", "original");
  f.put(configDir, "tdc/host-config-backup/state.json", JSON.stringify({ version: 1, items: { skills: { original: "backup", phase: "preparing" } } }));
  f.put(hostRoot, "skills/host.txt");
  assert.deepEqual(f.apply().issues, []);
  fs.renameSync(path.join(hostRoot, "skills"), path.join(f.root, "removed"));
  assert.deepEqual(f.apply().restored, ["skills"]);
  assert.equal(fs.readFileSync(path.join(configDir, "skills/original.txt"), "utf8"), "original");
});

test("宿主配置：原件已指向挂载路径时也保留原链接，关闭后可恢复", (t) => {
  const f = fixture(t), { configDir, hostRoot } = f.options;
  f.put(hostRoot, "skills/host.txt", "host");
  const original = path.join(configDir, "skills"), target = path.join(hostRoot, "skills");
  if (!symlink(t, target, original)) return;
  const previous = fs.readlinkSync(original);
  assert.deepEqual(f.apply().issues, []);
  assert.equal(fs.readlinkSync(f.backup("skills")), previous);
  fs.renameSync(target, path.join(f.root, "removed-skills"));
  assert.deepEqual(f.apply().restored, ["skills"]);
  assert.equal(fs.readlinkSync(original), previous);
  assert.deepEqual(f.apply().issues, []);
});

test("宿主配置：备份目录为外部链接时拒绝恢复，不移动外部原件", (t) => {
  const f = fixture(t), { configDir, hostRoot } = f.options;
  const outside = path.join(f.root, "outside-backup");
  f.put(outside, "skills/original.txt", "outside-original");
  f.put(outside, "state.json", JSON.stringify({ version: 1, items: { skills: { original: "backup", phase: "active" } } }));
  fs.mkdirSync(path.join(configDir, "tdc"));
  if (!symlink(t, outside, f.backup(""))) return;
  if (!symlink(t, path.join(hostRoot, "skills"), path.join(configDir, "skills"))) return;
  assert.deepEqual(f.apply().issues, [{ item: "state", code: "invalid-backup-state" }]);
  assert.equal(fs.readFileSync(path.join(outside, "skills/original.txt"), "utf8"), "outside-original");
  assert.equal(fs.lstatSync(path.join(configDir, "skills")).isSymbolicLink(), true);
});

test("宿主配置：失败回滚即使挂载仍存在也恢复原件，不生成额外共享链接", (t) => {
  const f = fixture(t), { configDir, sharedDir, hostRoot } = f.options;
  f.put(configDir, "skills/native.txt", "native-original");
  f.put(hostRoot, "skills/host.txt", "host-unchanged");
  f.put(hostRoot, "agents/host.txt", "agent-unchanged");
  assert.deepEqual(f.apply().issues, []);
  f.put(sharedDir, "commands/shared.txt", "must-not-link-on-rollback");
  const result = applyHostConfig({ ...f.options, restoreOnly: true });
  assert.deepEqual(result, { applied: [], restored: ["skills", "agents"], shared: [], issues: [] });
  assert.equal(fs.readFileSync(path.join(configDir, "skills/native.txt"), "utf8"), "native-original");
  assert.equal(fs.existsSync(path.join(configDir, "agents")), false);
  assert.equal(fs.existsSync(path.join(configDir, "commands")), false);
  assert.equal(fs.readFileSync(path.join(hostRoot, "skills/host.txt"), "utf8"), "host-unchanged");
  assert.deepEqual(applyHostConfig({ ...f.options, restoreOnly: true }).restored, []);
});

test("宿主配置：回滚遇到新建本地内容报告冲突，保留新内容与旧备份", (t) => {
  const f = fixture(t), { configDir, hostRoot } = f.options;
  f.put(configDir, "skills/native.txt", "native-original");
  f.put(hostRoot, "skills/host.txt", "host");
  f.apply();
  fs.unlinkSync(path.join(configDir, "skills"));
  f.put(configDir, "skills/new.txt", "user-created");
  assert.deepEqual(applyHostConfig({ ...f.options, restoreOnly: true }).issues, [{ item: "skills", code: "local-change-preserved" }]);
  assert.equal(fs.readFileSync(path.join(configDir, "skills/new.txt"), "utf8"), "user-created");
  assert.equal(fs.readFileSync(f.backup("skills/native.txt"), "utf8"), "native-original");
});

test("宿主配置：restore-only CLI 返回可核验 JSON 和失败退出码", (t) => {
  const f = fixture(t), { configDir, sharedDir } = f.options;
  const state = JSON.stringify({ version: 1, items: { skills: { original: "backup", phase: "active" } } });
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL("../rootfs/opt/tdc/tdc-host-config.mjs", import.meta.url)), "restore-only"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, TDC_SHARED_DIR: sharedDir }, encoding: "utf8", timeout: 10000,
  });
  f.put(configDir, "tdc/host-config-backup/skills/native.txt", "original");
  f.put(configDir, "tdc/host-config-backup/state.json", state);
  const restored = run();
  assert.equal(restored.status, 0, restored.stderr);
  assert.deepEqual(JSON.parse(restored.stdout).restored, ["skills"]);
  assert.equal(fs.readFileSync(path.join(configDir, "skills/native.txt"), "utf8"), "original");
  f.put(configDir, "tdc/host-config-backup/skills/older.txt", "older");
  f.put(configDir, "tdc/host-config-backup/state.json", state);
  const conflict = run();
  assert.equal(conflict.status, 1, conflict.stderr);
  assert.deepEqual(JSON.parse(conflict.stdout).issues, [{ item: "skills", code: "local-change-preserved" }]);
});

test("宿主 MCP：只复制 mcpServers 到私有文件，源与无关运行文件保持不变", (t) => {
  const f = fixture(t), runtimeDir = path.join(f.root, "runtime");
  const mcpServers = { example: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "fake-secret" } } };
  const body = JSON.stringify({ mcpServers, unrelated: "must-not-copy" });
  const source = f.put(f.options.hostRoot, "mcp/mcp.json", body);
  const options = { hostRoot: f.options.hostRoot, runtimeDir, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 1000 };
  assert.deepEqual(prepareHostMcp(options), { prepared: true });
  const destination = path.join(runtimeDir, "mcp.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(destination, "utf8")), { mcpServers });
  assert.equal(fs.readFileSync(source, "utf8"), body);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(runtimeDir).mode & 0o777, 0o750);
    assert.equal(fs.statSync(destination).mode & 0o777, 0o640);
  }
  f.put(runtimeDir, "keep.txt", "untouched");
  fs.renameSync(source, path.join(f.root, "removed-mcp.json"));
  assert.deepEqual(prepareHostMcp(options), { prepared: false });
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.readFileSync(path.join(runtimeDir, "keep.txt"), "utf8"), "untouched");
});

test("宿主 MCP：无效导出清除旧副本，错误不包含配置值", (t) => {
  const f = fixture(t), runtimeDir = path.join(f.root, "runtime");
  const source = f.put(f.options.hostRoot, "mcp/mcp.json", JSON.stringify({ mcpServers: {} }));
  const options = { hostRoot: f.options.hostRoot, runtimeDir, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 1000 };
  prepareHostMcp(options);
  fs.writeFileSync(source, "invalid fake-secret");
  assert.deepEqual(prepareHostMcp(options), { prepared: false, error: "host-mcp-unavailable" });
  assert.equal(fs.existsSync(path.join(runtimeDir, "mcp.json")), false);
  assert.equal(fs.readFileSync(source, "utf8"), "invalid fake-secret");
});

test("宿主 MCP：拒绝读取符号链接导出，避免 root 跟随任意目标", (t) => {
  const f = fixture(t), runtimeDir = path.join(f.root, "runtime");
  const outside = f.put(f.root, "private-input.json", JSON.stringify({ mcpServers: { private: {} } }));
  fs.mkdirSync(path.join(f.options.hostRoot, "mcp"));
  if (!symlink(t, outside, path.join(f.options.hostRoot, "mcp/mcp.json"), "file")) return;
  assert.deepEqual(prepareHostMcp({ hostRoot: f.options.hostRoot, runtimeDir }), { prepared: false, error: "host-mcp-unavailable" });
  assert.equal(fs.existsSync(path.join(runtimeDir, "mcp.json")), false);
});

test("宿主 MCP：运行中刷新原子更新，无效或缺失输入保留上次成功副本", (t) => {
  const f = fixture(t), runtimeDir = path.join(f.root, "runtime");
  const first = { mcpServers: { first: { type: "http", url: "https://first.invalid/mcp" } } };
  const second = { mcpServers: { second: { type: "http", url: "https://second.invalid/mcp" } } };
  const source = f.put(f.options.hostRoot, "mcp/mcp.json", JSON.stringify(first));
  const options = { hostRoot: f.options.hostRoot, runtimeDir, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 1000, preserveOnError: true };
  const destination = path.join(runtimeDir, "mcp.json");
  assert.deepEqual(prepareHostMcp(options), { prepared: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(destination, "utf8")), first);
  f.put(runtimeDir, `.mcp.${process.pid}.tmp`, "stale-interrupted-copy");
  fs.writeFileSync(source, JSON.stringify(second));
  assert.deepEqual(prepareHostMcp(options), { prepared: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(destination, "utf8")), second);
  fs.writeFileSync(source, "invalid fake-secret");
  assert.deepEqual(prepareHostMcp(options), { prepared: false, error: "host-mcp-unavailable" });
  assert.deepEqual(JSON.parse(fs.readFileSync(destination, "utf8")), second);
  fs.renameSync(source, path.join(f.root, "removed-mcp.json"));
  assert.deepEqual(prepareHostMcp(options), { prepared: false, error: "host-mcp-unavailable" });
  assert.deepEqual(JSON.parse(fs.readFileSync(destination, "utf8")), second);
  assert.deepEqual(fs.readdirSync(runtimeDir).sort(), [`.mcp.${process.pid}.tmp`, "mcp.json"].sort());
});
