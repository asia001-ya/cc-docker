import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createSessionTitleReader, getSessionTitle, normalizeSessionTitle, titleFromRecords, userMessageTitle } from "../rootfs/opt/tdc/tdc-session-history.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ID = "35b90aa9-77da-4a45-a6a7-2d606fded549";
const user = (content, extra = {}) => ({ type: "user", sessionId: ID, message: { role: "user", content }, ...extra });
const ai = (aiTitle) => ({ type: "ai-title", aiTitle, sessionId: ID });
const custom = (customTitle) => ({ type: "custom-title", customTitle, sessionId: ID });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdc-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectsDir = path.join(root, "projects");
  const project = path.join(projectsDir, "-workspace-app");
  fs.mkdirSync(project, { recursive: true });
  const transcript = path.join(project, `${ID}.jsonl`);
  const write = (records) => fs.writeFileSync(transcript, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return { root, projectsDir, project, transcript, write };
}

test("历史标题：读取真实 Claude ai-title 字段，自定义标题优先并取最后一次重命名", () => {
  const records = [user("请做一个页面"), ai("HTML 页面启动与监控"), custom("旧名称"), ai("自动标题"), custom("  中文\n 重命名\t🙂 ")];
  assert.equal(titleFromRecords(records, { sessionId: ID }), "中文 重命名 🙂");
  assert.equal(titleFromRecords([user("请做一个页面"), ai("HTML 页面启动与监控")]), "HTML 页面启动与监控");
});

test("历史标题：Unicode 截断不拆代理对，空值不产生占位标题", () => {
  const result = normalizeSessionTitle("🛠".repeat(60));
  assert.equal(Array.from(result).length, 48);
  assert.equal(result, "🛠".repeat(47) + "…");
  assert.equal(normalizeSessionTitle("\u001b[31m中文\u001b[0m\u0000\n标题"), "中文 标题");
  for (const value of [null, undefined, {}, 42, "\t\n"]) assert.equal(normalizeSessionTitle(value), null);
});

test("历史标题：通用自动名称使用中文后备，明确自定义名称和具体英文任务保持原文", () => {
  assert.equal(titleFromRecords([user("帮我修复登录"), ai("Claude Code")]), "帮我修复登录");
  assert.equal(titleFromRecords([ai("Claude Code")]), null);
  assert.equal(titleFromRecords([user("分析这张截图"), ai("Shared screenshot")]), "分析这张截图");
  assert.equal(titleFromRecords([ai("Shared screenshot")]), "截图会话");
  assert.equal(titleFromRecords([], { sessionId: ID, indexEntry: { sessionId: ID, aiTitle: "Claude Code", summary: "登录问题排查" } }), "登录问题排查");
  assert.equal(titleFromRecords([], { sessionId: ID, indexEntry: { sessionId: ID, aiTitle: "Shared screenshot", firstPrompt: "说明截图中的报错" } }), "说明截图中的报错");
  for (const name of ["Claude Code", "Shared screenshot"]) {
    assert.equal(titleFromRecords([user("中文问题"), custom(name)]), name);
    assert.equal(titleFromRecords([user("中文问题")], { sessionId: ID, indexEntry: { sessionId: ID, customTitle: name } }), name);
  }
  assert.equal(titleFromRecords([user("中文问题"), ai("Fix session authentication")]), "Fix session authentication");
});

test("历史标题：过滤工具、系统、命令及压缩消息，保留首条真实用户提问", () => {
  const ignored = [
    { type: "assistant", message: { content: "助手内容" } },
    user("工具结果", { isMeta: true }),
    user("子代理任务", { isSidechain: true }),
    user("压缩摘要", { isCompactSummary: true }),
    user("<command-name>/login</command-name><command-message>login</command-message>"),
    user("<local-command-stdout>Logged in</local-command-stdout>"),
    user("<bash-input>pwd</bash-input><bash-stdout>/workspace</bash-stdout>"),
    user("/resume"),
    user("[Request interrupted by user]"),
    user("This session is being continued from a previous conversation that ran out of context."),
    user([{ type: "tool_result", content: "工具结果" }, { type: "text", text: "工具附言" }]),
    user([{ type: "image", source: { type: "base64", data: "ignored" } }]),
    user("<system-reminder>只是一条环境说明</system-reminder>"),
    user("<task-notification>任务完成</task-notification>"),
  ];
  for (const record of ignored) assert.equal(userMessageTitle(record), null);
  const question = user([{ type: "text", text: "<ide_opened_file>some/file.ts</ide_opened_file>\n帮我修复" }, { type: "text", text: "恢复会话列表" }]);
  assert.equal(titleFromRecords([...ignored, question, user("后来的问题")]), "帮我修复 恢复会话列表");
});

test("历史标题：隔离其他会话与 sidechain 的标题", () => {
  assert.equal(titleFromRecords([user("当前会话"), { ...custom("其他会话"), sessionId: "another" }, { ...custom("子代理"), isSidechain: true }], { sessionId: ID }), "当前会话");
  assert.equal(titleFromRecords([custom("有效名称"), { type: "custom-title", customTitle: {} }]), "有效名称");
  assert.equal(titleFromRecords([null, 1, {}, { type: "system" }]), null);
});

test("历史标题：支持旧版 index 摘要和首条提问，显式清空标题可回退", () => {
  const indexEntry = { sessionId: ID, summary: "索引中的项目摘要", firstPrompt: "首条提问" };
  assert.equal(titleFromRecords([user("较长的原始问题")], { sessionId: ID, indexEntry }), "索引中的项目摘要");
  assert.equal(titleFromRecords([], { sessionId: ID, indexEntry: { sessionId: ID, firstPrompt: "  首条\n 提问 " } }), "首条 提问");
  assert.equal(titleFromRecords([custom("") , ai("回退自动标题")], { sessionId: ID, indexEntry: { ...indexEntry, customTitle: "已清空的旧名称" } }), "回退自动标题");
  assert.equal(titleFromRecords([], { sessionId: ID, indexEntry: { ...indexEntry, sessionId: "other" } }), null);
});

test("历史标题：已有 JSONL 可立即按 transcript_path 或会话 ID 查找", (t) => {
  const f = fixture(t);
  f.write([user("请帮我启动项目"), ai("中文项目启动")]);
  const reader = createSessionTitleReader(f.projectsDir);
  assert.equal(reader({ session_id: ID, transcript_path: f.transcript }), "中文项目启动");
  assert.equal(getSessionTitle({ session_id: ID, cwd: "/different/path" }, f), "中文项目启动");
  assert.equal(getSessionTitle({ session_id: "../escape" }, f), null);
  assert.equal(getSessionTitle({ session_id: ID }), null);
});

test("历史标题：读取 projects 内旧版 sessions-index，不覆盖最新自定义标题", (t) => {
  const f = fixture(t);
  f.write([user("原始问题")]);
  fs.writeFileSync(path.join(f.project, "sessions-index.json"), JSON.stringify({ entries: [{ sessionId: ID, customTitle: "索引中的自定义标题" }] }));
  assert.equal(getSessionTitle({ session_id: ID }, f), "索引中的自定义标题");
  f.write([custom("最新重命名")]);
  assert.equal(getSessionTitle({ session_id: ID }, f), "最新重命名");
});

test("历史标题：不读取 projects 之外的 transcript_path，错误文件名也不冒充该会话", (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, `${ID}.jsonl`);
  fs.writeFileSync(outside, JSON.stringify(custom("目录外的内容")));
  assert.equal(getSessionTitle({ session_id: ID, transcript_path: outside }, f), null);
  const wrongFile = path.join(f.project, "different-session.jsonl");
  fs.writeFileSync(wrongFile, JSON.stringify(custom("错误文件")));
  assert.equal(getSessionTitle({ session_id: ID, transcript_path: wrongFile }, f), null);
});

test("历史标题：拒绝通过目录内符号链接读取目录外文件", (t) => {
  const f = fixture(t);
  const outsideDir = path.join(f.root, "outside");
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, `${ID}.jsonl`), JSON.stringify(custom("目录外内容")));
  const linkDir = path.join(f.projectsDir, "linked-project");
  fs.symlinkSync(outsideDir, linkDir, process.platform === "win32" ? "junction" : "dir");
  assert.equal(getSessionTitle({ session_id: ID, transcript_path: path.join(linkDir, `${ID}.jsonl`) }, f), null);
});

test("历史标题：损坏 JSON、空文件、缺失文件不会导致读取失败", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, "broken json\n" + JSON.stringify(ai("有效中文标题")) + "\n{unfinished");
  fs.writeFileSync(path.join(f.project, "sessions-index.json"), "broken");
  assert.equal(getSessionTitle({ session_id: ID }, f), "有效中文标题");
  fs.writeFileSync(f.transcript, "");
  assert.equal(getSessionTitle({ session_id: ID }, f), null);
  assert.equal(getSessionTitle({ session_id: "missing" }, f), null);
  assert.equal(createSessionTitleReader(path.join(f.root, "missing"))({ session_id: ID }), null);
});

test("历史标题：文件无读取权限时返回 null", (t) => {
  const f = fixture(t);
  f.write([ai("不可读标题")]);
  const originalOpen = fs.openSync;
  t.mock.method(fs, "openSync", function (file, ...args) {
    if (file === f.transcript) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return originalOpen.call(this, file, ...args);
  });
  assert.equal(getSessionTitle({ session_id: ID }, f), null);
});

test("历史标题：大日志只读头尾 128 KiB，且一次 snapshot 不重复读取同一日志", (t) => {
  const f = fixture(t);
  f.write([user("首条中文问题"), { type: "assistant", message: { content: "x".repeat(2 * 1024 * 1024) } }, custom("尾部最新中文标题")]);
  const originalRead = fs.readSync;
  let bytes = 0;
  t.mock.method(fs, "readSync", function (...args) {
    const count = originalRead.apply(this, args);
    bytes += count;
    return count;
  });
  const reader = createSessionTitleReader(f.projectsDir);
  assert.equal(reader({ session_id: ID }), "尾部最新中文标题");
  assert.ok(bytes <= 128 * 1024, `读取了 ${bytes} 字节`);
  const once = bytes;
  assert.equal(reader({ session_id: ID }), "尾部最新中文标题");
  assert.equal(bytes, once);
});

test("历史标题：头部无用户消息时，不把尾部的中途提问当作首条", (t) => {
  const f = fixture(t);
  f.write([{ type: "file-history-snapshot", payload: "x".repeat(256 * 1024) }, user("中途的问题")]);
  assert.equal(getSessionTitle({ session_id: ID }, f), null);
});

test("历史标题：标题仅在长日志中部时有界回退，不为标题全量扫描", (t) => {
  const f = fixture(t);
  const large = { type: "assistant", message: { content: "x".repeat(128 * 1024) } };
  f.write([user("首条提问作为后备名称"), large, custom("只存在于中间的旧标题"), large]);
  assert.equal(getSessionTitle({ session_id: ID }, f), "首条提问作为后备名称");
});

test("历史标题：新一轮 snapshot 读取更新后的标题", (t) => {
  const f = fixture(t);
  f.write([ai("旧名称")]);
  assert.equal(getSessionTitle({ session_id: ID }, f), "旧名称");
  fs.appendFileSync(f.transcript, JSON.stringify(custom("刚刚改好的中文名")) + "\n");
  assert.equal(getSessionTitle({ session_id: ID }, f), "刚刚改好的中文名");
});

test("snapshot：为既有 sessions 注入 title，保留其他字段与无标题条目", (t) => {
  const f = fixture(t);
  f.write([ai("恢复会话中文标题")]);
  const state = path.join(f.root, "state");
  fs.mkdirSync(path.join(state, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(state, "sessions", "known.json"), JSON.stringify({ session_id: ID, cwd: "/workspace/app", updated_at: 42, transcript_path: f.transcript }));
  fs.writeFileSync(path.join(state, "sessions", "unknown.json"), JSON.stringify({ session_id: "missing", cwd: "/workspace" }));
  const ctl = fs.readFileSync(path.join(HERE, "../rootfs/opt/tdc/tdc-ctl.sh"), "utf8");
  const inline = ctl.match(/TDC_TMUX_JSON=.*node --input-type=module -e '([\s\S]*?)\n  '/)?.[1];
  assert.ok(inline, "snapshot 应运行 ES module 标题读取器");
  const moduleUrl = pathToFileURL(path.join(HERE, "../rootfs/opt/tdc/tdc-session-history.mjs")).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", inline.replace("/opt/tdc/tdc-session-history.mjs", moduleUrl)], {
    env: { ...process.env, TDC_STATE_DIR: state, CLAUDE_CONFIG_DIR: f.root, TDC_TMUX_JSON: "[]", TDC_PROXY_STATUS: path.join(state, "proxy.json") },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.sessions.length, 2);
  const known = snapshot.sessions.find((session) => session.session_id === ID);
  assert.equal(known.title, "恢复会话中文标题");
  assert.equal(known.cwd, "/workspace/app");
  assert.equal(known.updated_at, 42);
  assert.equal(snapshot.sessions.find((session) => session.session_id === "missing").title, null);
});
