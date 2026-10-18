#!/usr/bin/env node
/** 宿主配置只读覆盖：保留容器原件，撤掉挂载时还原；不修改宿主或共享池。 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const ITEMS = ["skills", "commands", "agents", "CLAUDE.md"];
const DEFAULT_HOST_ROOT = "/opt/tdc/host-config";
const DEFAULT_RUNTIME_DIR = "/var/lib/tdc/host-config";
const stat = (file) => { try { return fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
const linkTo = (file, target) => {
  try { return fs.lstatSync(file).isSymbolicLink() && path.resolve(path.dirname(file), fs.readlinkSync(file)) === path.resolve(target); } catch { return false; }
};
const makeLink = (target, file, item) => fs.symlinkSync(target, file, item === "CLAUDE.md" ? "file" : process.platform === "win32" ? "junction" : "dir");

function hostItemPresent(hostRoot, item, requireReadable = false) {
  const source = path.join(hostRoot, item);
  let value;
  try {
    value = fs.statSync(source);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return false;
    throw error;
  }
  const present = item === "CLAUDE.md" ? value.isFile() : value.isDirectory();
  if (present && requireReadable) fs.accessSync(source, fs.constants.R_OK | (item === "CLAUDE.md" ? 0 : fs.constants.X_OK));
  return present;
}

/** 应用四类宿主挂载，并处理原有共享目录链接；任何冲突保留原文件并返回固定错误码。 */
export function applyHostConfig({ configDir, sharedDir, hostRoot = DEFAULT_HOST_ROOT, restoreOnly = false }) {
  const result = { applied: [], restored: [], shared: [], issues: [] };
  const backupDir = path.join(configDir, "tdc", "host-config-backup");
  const stateFile = path.join(backupDir, "state.json");
  let state = { version: 1, items: {} };
  try {
    if (stat(backupDir)?.isSymbolicLink() || stat(stateFile)?.isSymbolicLink()) throw new Error("invalid-state");
    if (stat(stateFile)) {
      state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (state?.version !== 1 || !state.items || Array.isArray(state.items) || typeof state.items !== "object") throw new Error("invalid-state");
      for (const [item, value] of Object.entries(state.items)) {
        if (!ITEMS.includes(item) || !["backup", "absent"].includes(value?.original) || !["preparing", "active"].includes(value?.phase)) throw new Error("invalid-state");
      }
    }
  } catch {
    result.issues.push({ item: "state", code: "invalid-backup-state" });
    return result;
  }
  const save = () => {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(backupDir).isSymbolicLink()) throw new Error("unsafe-backup-directory");
    const temporary = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temporary, stateFile);
  };
  for (const item of ITEMS) {
    const destination = path.join(configDir, item);
    const host = path.join(hostRoot, item);
    const backup = path.join(backupDir, item);
    try {
      const enabled = !restoreOnly && hostItemPresent(hostRoot, item, true);
      let saved = state.items[item];
      if (enabled) {
        if (!saved) {
          // 备份存在时不覆盖；可能是上次保存状态后的中断。
          if (stat(backup) && stat(destination) && !linkTo(destination, host)) {
            result.issues.push({ item, code: "backup-conflict" });
            continue;
          }
          saved = state.items[item] = { original: stat(backup) || stat(destination) ? "backup" : "absent", phase: "preparing" };
          save();
        }
        // 原件本身也可能指向相同挂载位置，仍须保留该链接供停用时恢复。
        const originalLinkNeedsBackup = saved.phase === "preparing" && saved.original === "backup" && stat(destination) && !stat(backup);
        if (!linkTo(destination, host) || originalLinkNeedsBackup) {
          if (stat(destination)) {
            if (saved.phase !== "preparing" || stat(backup)) {
              result.issues.push({ item, code: "local-change-preserved" });
              continue;
            }
            fs.renameSync(destination, backup);
          }
          makeLink(host, destination, item);
        }
        saved.phase = "active";
        save();
        result.applied.push(item);
        continue;
      }
      if (saved) {
        if (stat(destination) && !linkTo(destination, host)) {
          // preparing 阶段还未移动原件，或恢复 rename 已完成，均保留现有原件。
          if (stat(backup)) {
            result.issues.push({ item, code: "local-change-preserved" });
            continue;
          }
          delete state.items[item];
          save();
          result.restored.push(item);
          continue;
        }
        if (saved.original === "backup" && !stat(backup)) {
          result.issues.push({ item, code: "original-backup-missing" });
          continue;
        }
        if (linkTo(destination, host)) fs.unlinkSync(destination);
        if (stat(backup)) fs.renameSync(backup, destination);
        delete state.items[item];
        save();
        result.restored.push(item);
      }
      // 回滚只还原已记录的覆盖，不读取挂载状态，也不引入新的共享链接。
      if (restoreOnly) continue;
      const shared = path.join(sharedDir, item);
      // 本地真实文件和用户自建链接均优先；仅补齐空位，不修改共享池本身。
      if (hostItemPresent(sharedDir, item) && !stat(destination)) {
        makeLink(shared, destination, item);
        result.shared.push(item);
      }
    } catch {
      result.issues.push({ item, code: "config-update-failed" });
    }
  }
  return result;
}

/** root 阶段把只读宿主 MCP 导出复制到容器私有运行文件，避免宿主 UID 与 node 不同。 */
export function prepareHostMcp({ hostRoot = DEFAULT_HOST_ROOT, runtimeDir = DEFAULT_RUNTIME_DIR, uid = 0, gid = 1000, preserveOnError = false } = {}) {
  const destination = path.join(runtimeDir, "mcp.json");
  const source = path.join(hostRoot, "mcp", "mcp.json");
  let fd;
  let temporary;
  const clear = () => {
    if (stat(runtimeDir)?.isSymbolicLink()) throw new Error("unsafe-runtime-directory");
    if (stat(destination)) fs.unlinkSync(destination);
  };
  try {
    const input = stat(source);
    if (!input) {
      if (preserveOnError) throw new Error("missing-input");
      clear();
      return { prepared: false };
    }
    if (!input.isFile() || input.isSymbolicLink()) throw new Error("invalid-input");
    fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const size = fs.fstatSync(fd).size;
    if (size > 4 * 1024 * 1024) throw new Error("input-too-large");
    const bytes = Buffer.alloc(size);
    const count = fs.readSync(fd, bytes, 0, size, 0);
    const data = JSON.parse(bytes.subarray(0, count).toString("utf8"));
    if (!data?.mcpServers || typeof data.mcpServers !== "object" || Array.isArray(data.mcpServers)) throw new Error("invalid-config");
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o750 });
    if (fs.lstatSync(runtimeDir).isSymbolicLink()) throw new Error("unsafe-runtime-directory");
    fs.chmodSync(runtimeDir, 0o750);
    if (process.platform !== "win32") fs.chownSync(runtimeDir, uid, gid);
    temporary = path.join(runtimeDir, `.mcp.${process.pid}.${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify({ mcpServers: data.mcpServers }), { flag: "wx", mode: 0o640 });
    if (process.platform !== "win32") fs.chownSync(temporary, uid, gid);
    fs.renameSync(temporary, destination);
    temporary = undefined;
    return { prepared: true };
  } catch {
    // 启动时清除失效副本；运行中显式刷新失败时保留上一次成功配置。
    if (!preserveOnError) {
      try { clear(); } catch { /* 无法清除时仍报告失败，不跟随任何链接。 */ }
    }
    return { prepared: false, error: "host-mcp-unavailable" };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (temporary) { try { fs.unlinkSync(temporary); } catch { /* 仅清理本次固定生成文件。 */ } }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = ["prepare-mcp", "refresh-mcp"].includes(process.argv[2])
      ? prepareHostMcp({ gid: /^\d+$/.test(process.argv[3] ?? "") ? Number(process.argv[3]) : 1000, preserveOnError: process.argv[2] === "refresh-mcp" })
      : applyHostConfig({ configDir: process.env.CLAUDE_CONFIG_DIR || "/home/node/.claude", sharedDir: process.env.TDC_SHARED_DIR || "/home/node/.claude-shared", restoreOnly: process.argv[2] === "restore-only" });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.error || result.issues?.length) process.exitCode = 1;
  } catch {
    process.stderr.write("tdc-host-config: 配置处理失败\n");
    process.exitCode = 1;
  }
}
