import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { collectUsage } from "../rootfs/opt/tdc/tdc-usage.mjs";

const SESSION = "shared-session";
const START = 1750000000000;
const user = (uuid, timestamp = START + 5, parentUuid = null, content = "private prompt", extra = {}) => ({ type: "user", uuid, parentUuid, sessionId: SESSION, timestamp: new Date(timestamp).toISOString(), message: { role: "user", content }, ...extra });
const assistant = (uuid, parentUuid, timestamp = START + 100, extra = {}) => ({ type: "assistant", uuid, parentUuid, sessionId: SESSION, timestamp: new Date(timestamp).toISOString(), requestId: uuid, message: { role: "assistant", id: `msg-${uuid}`, model: "claude-test", content: "private response", usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } }, ...extra });
const history = (timestamp = START, extra = {}) => ({ sessionId: SESSION, timestamp, display: "private history display", ...extra });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdc-usage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, "private");
  fs.mkdirSync(path.join(configDir, "projects", "project"), { recursive: true });
  const writeHistory = (records) => fs.writeFileSync(path.join(configDir, "history.jsonl"), typeof records === "string" ? records : records.map(JSON.stringify).join("\n") + "\n");
  const writeTranscript = (records, filename = `${SESSION}.jsonl`) => {
    const file = path.join(configDir, "projects", "project", filename);
    fs.writeFileSync(file, records.map((record) => typeof record === "string" ? record : JSON.stringify(record)).join("\n") + "\n");
    return file;
  };
  const writeProvider = (timestamp = START - 10000) => {
    const file = path.join(configDir, "tdc", "usage-provider.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ authType: "api", providerId: "local-provider", providerName: "Local", pricing: { input: 3, output: 15 } }));
    fs.utimesSync(file, new Date(timestamp), new Date(timestamp));
  };
  return { root, configDir, writeHistory, writeTranscript, writeProvider, collect: () => collectUsage({ configDir }) };
}

test("用量归属：共享 projects 只由各容器独立 history 验证本地提交", (t) => {
  const a = fixture(t), b = fixture(t);
  const records = [user("a-user"), assistant("a-request", "a-user"), user("b-user", START + 10005, "a-request"), assistant("b-request", "b-user", START + 10100)];
  a.writeTranscript(records);
  // Separate private configuration directories see the exact same projects tree.
  fs.rmSync(path.join(b.configDir, "projects"), { recursive: true });
  fs.symlinkSync(path.join(a.configDir, "projects"), path.join(b.configDir, "projects"), process.platform === "win32" ? "junction" : "dir");
  a.writeHistory([history()]); b.writeHistory([history(START + 10000)]);
  a.writeProvider(); b.writeProvider();
  const rowsA = a.collect().records, rowsB = b.collect().records;
  assert.deepEqual(rowsA.map((row) => row.ownership), ["local-history", "unverified"]);
  assert.deepEqual(rowsB.map((row) => row.ownership), ["unverified", "local-history"]);
  assert.deepEqual(rowsA.map((row) => row.attribution), ["captured", "historical"]);
  assert.deepEqual(rowsA.map((row) => row.id), rowsB.map((row) => row.id));
});

test("用量归属：跨容器 resume 的每次新 user 都切断前一轮归属", (t) => {
  const f = fixture(t);
  f.writeHistory([history(), history(START + 20000)]);
  f.writeTranscript([
    user("u1"), assistant("r1", "u1"),
    user("u2", START + 10005, "r1"), assistant("r2", "u2", START + 10100),
    user("u3", START + 20009, "r2"), assistant("r3", "u3", START + 20100),
    user("u4", START + 30005, "r3", [{ type: "image", source: { data: "private image" } }]), assistant("r4", "u4", START + 30100),
  ]);
  assert.deepEqual(f.collect().records.map((row) => row.ownership), ["local-history", "unverified", "local-history", "unverified"]);
});

test("用量归属：parentUuid 穿过多轮工具结果、attachment 与合成系统消息", (t) => {
  const f = fixture(t);
  f.writeHistory([history()]);
  f.writeTranscript([
    user("u"), assistant("r1", "u"),
    user("tool1", START + 2000, "r1", [{ type: "tool_result", content: "private tool output" }]),
    { type: "attachment", uuid: "attached", parentUuid: "tool1", sessionId: SESSION, attachment: { content: "private attachment" } },
    { type: "system", uuid: "system", parentUuid: "attached", sessionId: SESSION },
    assistant("r2", "system", START + 3000),
    user("tool2", START + 4000, "r2", [{ type: "tool_result", content: "private output" }]),
    user("synthetic", START + 5000, "tool2", "<task-notification>private task result</task-notification>"),
    assistant("r3", "synthetic", START + 6000),
    user("summary", START + 7000, "r3", "private compact summary", { isCompactSummary: true }),
    assistant("r4", "summary", START + 8000),
  ]);
  assert.deepEqual(f.collect().records.map((row) => row.ownership), Array(4).fill("local-history"));
});

test("用量归属：未匹配的文字提交和带系统前缀的新提问不可继承", (t) => {
  const f = fixture(t);
  f.writeHistory([history()]);
  f.writeTranscript([
    user("u"), assistant("r1", "u"),
    user("new", START + 5000, "r1", "<system-reminder>metadata</system-reminder>New question"),
    assistant("r2", "new", START + 6000),
    user("result", START + 7000, "r2", [{ type: "tool_result", content: "result" }]),
    assistant("r3", "result", START + 8000),
  ]);
  assert.deepEqual(f.collect().records.map((row) => row.ownership), ["local-history", "unverified", "unverified"]);
});

test("用量归属：缺失、损坏或截断 history 不使用 session 文件或 transcript mtime 代替", (t) => {
  const f = fixture(t);
  f.writeTranscript([user("u"), assistant("r", "u")]); f.writeProvider();
  const stateDir = path.join(f.root, "state");
  fs.mkdirSync(path.join(stateDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "sessions", "running.json"), JSON.stringify({ session_id: SESSION }));
  for (const content of [null, "{truncated", `${JSON.stringify(history())}\n{truncated`, `${JSON.stringify(history())}\nnull`]) {
    if (content !== null) f.writeHistory(content);
    const snapshot = collectUsage({ configDir: f.configDir, stateDir });
    assert.equal(snapshot.records[0].ownership, "unverified");
    assert.equal(snapshot.records[0].attribution, "historical");
    assert.ok(snapshot.warnings.length);
  }
});

test("用量归属：时间窗只接受 1000ms 以内且双向唯一的匹配", (t) => {
  const f = fixture(t);
  for (const [entries, users, expected] of [
    [[history()], [user("u", START + 1000)], ["local-history"]],
    [[history()], [user("u", START + 1001)], ["unverified"]],
    [[history(), history(START + 100)], [user("u", START + 5)], ["unverified"]],
    [[history()], [user("u", START + 5), user("v", START + 600)], ["unverified", "unverified"]],
    [[history(START, { sessionId: "other-session" })], [user("u")], ["unverified"]],
  ]) {
    f.writeHistory(entries);
    f.writeTranscript(users.flatMap((record) => [record, assistant(`r-${record.uuid}`, record.uuid)]));
    assert.deepEqual(f.collect().records.map((row) => row.ownership), expected);
  }
});

test("用量归属：按 UUID 图回溯而不是行顺序，缺链、循环及冲突 UUID 均不归属", (t) => {
  const f = fixture(t);
  f.writeHistory([history()]);
  f.writeTranscript([
    assistant("valid", "u"), user("u"),
    assistant("missing", "missing-parent"),
    assistant("cycle1", "cycle2"), assistant("cycle2", "cycle1"),
    { type: "attachment", uuid: "conflict", parentUuid: "u", sessionId: SESSION },
    { type: "attachment", uuid: "conflict", parentUuid: "foreign", sessionId: SESSION },
    assistant("conflicting", "conflict"),
  ]);
  assert.deepEqual(f.collect().records.map((row) => row.ownership), ["local-history", "unverified", "unverified", "unverified", "unverified"]);
});

test("用量归属：重复 stream ID 保留稳定 ID 与各次 token 元数据，尾部时长仍附到最后一行", (t) => {
  const f = fixture(t);
  f.writeHistory([history()]); f.writeProvider();
  const first = assistant("stream", "u");
  const second = assistant("stream", "u", START + 200, { message: { ...first.message, usage: { input_tokens: "12", output_tokens: 19, cache_read_tokens: 4, cache_write_tokens: 5 } } });
  f.writeTranscript([user("u"), user("u"), first, second, { type: "system", subtype: "turn_duration", durationMs: 3210 }]);
  const snapshot = f.collect();
  assert.equal(snapshot.protocol, 2);
  assert.equal(snapshot.records.length, 2);
  assert.deepEqual(snapshot.records.map((row) => row.id), [`${SESSION}:stream`, `${SESSION}:stream`]);
  assert.deepEqual(snapshot.records.map((row) => row.ownership), ["local-history", "local-history"]);
  assert.deepEqual(snapshot.records.map((row) => row.outputTokens), [7, 19]);
  assert.equal(snapshot.records[1].cacheReadTokens, 4);
  assert.equal(snapshot.records[1].cacheWriteTokens, 5);
  assert.equal(snapshot.records[0].durationMs, null);
  assert.equal(snapshot.records[1].durationMs, 3210);
});

test("用量归属：冲突的 user UUID 不能让相邻提交虚假成为唯一匹配", (t) => {
  const f = fixture(t);
  f.writeHistory([history()]);
  f.writeTranscript([
    user("u"), assistant("r", "u"),
    user("conflict", START + 500), user("conflict", START + 600),
    assistant("ambiguous", "conflict"),
  ]);
  assert.deepEqual(f.collect().records.map((row) => row.ownership), ["unverified", "unverified"]);
});

test("用量归属：供应商快照时间只控制 captured，归属时间不能由文件 mtime 补齐", (t) => {
  const f = fixture(t);
  f.writeHistory([history()]);
  const file = f.writeTranscript([user("u"), assistant("r", "u")]);
  assert.equal(f.collect().records[0].ownership, "local-history");
  assert.equal(f.collect().records[0].attribution, "historical");
  f.writeProvider(START + 10000);
  assert.equal(f.collect().records[0].attribution, "historical");
  f.writeProvider(START - 10000);
  assert.equal(f.collect().records[0].attribution, "captured");
  f.writeTranscript([user("u", START, null, "prompt", { timestamp: undefined }), assistant("r", "u", START, { timestamp: undefined })]);
  fs.utimesSync(file, new Date(START), new Date(START));
  const row = f.collect().records[0];
  assert.equal(row.timestamp, START / 1000); // Legacy timestamp fallback for display.
  assert.equal(row.ownership, "unverified");
  assert.equal(row.attribution, "historical");
});

test("用量归属：兼容旧 ID/token/duration 字段并忽略坏行及空用量", (t) => {
  const f = fixture(t);
  f.writeHistory([history()]);
  f.writeTranscript([
    user("u"), "{bad-json", { type: "assistant", uuid: "empty", parentUuid: "u", sessionId: SESSION, usage: {} },
    { type: "assistant", uuid: "r", parent_uuid: "u", session_id: SESSION, request_ref: "reference", created_at: START / 1000 + 1, model: "legacy-model", usage: { inputTokens: "2.9", outputTokens: -1, cacheReadTokens: "3", cacheWriteTokens: 4, duration_ms: "12.5" } },
  ]);
  const [row] = f.collect().records;
  assert.deepEqual(row, { id: `${SESSION}:reference`, timestamp: START / 1000 + 1, sessionId: SESSION, model: "legacy-model", inputTokens: 2, outputTokens: 0, cacheReadTokens: 3, cacheWriteTokens: 4, durationMs: 12.5, attribution: "historical", ownership: "local-history" });
});

test("用量归属：CLI 只输出元数据，不泄露正文、工具结果或 history display", (t) => {
  const f = fixture(t);
  f.writeHistory([history(START, { display: "SECRET_HISTORY_DISPLAY" })]);
  f.writeTranscript([
    user("u", START + 5, null, "SECRET_USER_PROMPT"),
    assistant("r1", "u", START + 100, { message: { ...assistant("r1", "u").message, content: "SECRET_ASSISTANT_RESPONSE" } }),
    user("tool", START + 2000, "r1", [{ type: "tool_result", content: "SECRET_TOOL_OUTPUT" }]),
    assistant("r2", "tool", START + 3000),
  ]);
  const executable = fileURLToPath(new URL("../rootfs/opt/tdc/tdc-usage.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [executable], { encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: f.configDir } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.equal(result.stdout.includes("SECRET_"), false);
  assert.equal(result.stdout.includes('"display"'), false);
  assert.equal(result.stdout.includes('"content"'), false);
  assert.deepEqual(JSON.parse(result.stdout), f.collect());
});
