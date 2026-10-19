/** Real interactive Claude against a local API fixture; no accounts or external network required. */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = process.env.TDC_TEST_CLAUDE || "/usr/local/bin/tdc-claude-real";
const available = process.platform === "linux" && fs.existsSync(cli)
  && spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test("API 恢复：首轮避开不支持的进度字段，签名重试后显示回复且保留对话", {
  skip: !available && "需要容器镜像中的真实 Claude CLI 与 tmux",
  timeout: 30000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdc-provider-resume-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "config"), cwd = path.join(root, "project");
  const project = path.join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(cwd);
  const sessionId = randomUUID(), userId = randomUUID(), model = "claude-opus-5-5";
  const prompt = "Previous synthetic question", answer = "Previous synthetic answer";
  const records = [
    { type: "user", uuid: userId, parentUuid: null, sessionId, cwd, timestamp: "2026-10-18T00:00:00Z", version: "2.1.300", message: { role: "user", content: prompt } },
    { type: "assistant", uuid: randomUUID(), parentUuid: userId, sessionId, cwd, timestamp: "2026-10-18T00:00:01Z", version: "2.1.300",
      message: { id: "msg_foreign_history", role: "assistant", type: "message", model,
        content: [{ type: "thinking", thinking: "Synthetic thought", signature: "foreign-signature" }, { type: "text", text: answer }],
        stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } } },
  ];
  fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), records.map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(path.join(config, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true, theme: "dark", autoUpdaterStatus: "disabled",
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }));
  const requests = [], failures = [], reply = "PROVIDER_RESUME_OK";
  const server = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}");
      if (!req.url.startsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      requests.push(body);
      const blocks = (body.messages || []).flatMap(m => Array.isArray(m.content) ? m.content : []);
      const error = body.thinking?.display === "updates"
        ? "thinking.display: Input should be 'summarized', 'omitted'"
        : blocks.some(b => b.type === "thinking" || b.type === "redacted_thinking")
          ? "messages.1.content.0: Invalid `signature` in `thinking` block"
          : null;
      if (error) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: error } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "request-id": "tdc-test" });
      for (const event of [
        { type: "message_start", message: { id: "msg_test_reply", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    } catch (error) {
      failures.push(error);
      res.destroy();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const settings = path.join(config, "provider-settings.json");
  fs.writeFileSync(settings, JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: "fake-test-token", ANTHROPIC_MODEL: model,
    CLAUDE_CODE_THINKING_DISPLAY_UPDATES: "0",
  } }), { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(ANTHROPIC_|CLAUDE_|TDC_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|BASH_ENV$|ENV$)/i.test(key)));
  Object.assign(env, {
    HOME: root, CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: "fake-test-token",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", API_TIMEOUT_MS: "5000",
  });
  const socket = `tdc-resume-test-${randomUUID()}`;
  const tmux = (...args) => spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { env, encoding: "utf8", timeout: 5000 });
  t.after(() => tmux("kill-server"));
  const start = tmux("new-session", "-d", "-s", "test", "-x", "140", "-y", "45", "-c", cwd,
    cli, "--settings", settings, "--resume", sessionId, "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "");
  assert.equal(start.status, 0, start.stderr);
  let screen = "";
  for (let tries = 0; tries < 100; tries++) {
    screen = tmux("capture-pane", "-p", "-t", "test").stdout || "";
    if (screen.includes(answer)) break;
    await pause(100);
  }
  assert.ok(screen.includes(answer), "Claude 应先显示恢复的历史");
  tmux("send-keys", "-t", "test", "-l", "Next synthetic question");
  tmux("send-keys", "-t", "test", "Enter");
  for (let tries = 0; tries < 150; tries++) {
    screen = tmux("capture-pane", "-p", "-t", "test").stdout || "";
    if (screen.includes(reply)) break;
    await pause(100);
  }
  assert.deepEqual(failures, []);
  assert.ok(requests.length >= 2, "应先尝试历史签名，再由 Claude 重试兼容请求");
  assert.ok(requests.every(r => r.thinking?.display !== "updates"), "第一轮就应避开中转不支持的进度字段");
  assert.ok(requests.every(r => r.thinking?.type === "adaptive"), "兼容设置不能禁用思考能力");
  const finalMessages = requests.at(-1).messages;
  const text = finalMessages.map(m => typeof m.content === "string" ? m.content : m.content.map(b => b.text || "").join("\n")).join("\n");
  assert.ok(text.includes(prompt) && text.includes(answer) && text.includes("Next synthetic question"));
  assert.ok(screen.includes(reply), "恢复后首轮回复应显示在终端");
});
