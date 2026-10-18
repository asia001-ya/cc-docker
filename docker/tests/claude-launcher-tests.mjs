/** Claude 全局入口和 tdc-session 的行为回归测试；只使用 mock CLI 与假凭据。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOTFS = path.resolve(HERE, "../rootfs/opt/tdc");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const shellPath = (value) => process.platform === "win32"
  ? value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
  : value;

function findBash() {
  const candidates = [process.env.TDC_TEST_BASH];
  if (process.platform === "win32") {
    const gitPaths = spawnSync("where.exe", ["git"], { encoding: "utf8" }).stdout ?? "";
    candidates.push(...gitPaths.trim().split(/\r?\n/).filter(Boolean)
      .map((git) => path.resolve(path.dirname(git), "../bin/bash.exe")));
    candidates.push("C:/Program Files/Git/bin/bash.exe");
  }
  candidates.push("bash");
  for (const command of [...new Set(candidates.filter(Boolean))]) {
    const result = spawnSync(command, ["--noprofile", "--norc", "-c",
      '[[ -f "$1" ]] && printf "%s" "$BASH"', "tdc-test", shellPath(fileURLToPath(import.meta.url))],
    { encoding: "utf8", timeout: 5000 });
    if (result.status === 0 && result.stdout) return { command, executable: result.stdout };
  }
  return null;
}

const BASH = findBash();
const bashTest = (name, run) => test(name, { skip: !BASH && "需要可访问项目文件的 Bash（Windows 可设置 TDC_TEST_BASH 为 Git Bash）" }, run);
const apiSettings = (provider) => ({ env: {
  ANTHROPIC_AUTH_TOKEN: `fake-${provider}-token`,
  ANTHROPIC_BASE_URL: `https://${provider}.example.invalid`,
} });

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdc-claude-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  const config = path.join(dir, "config with spaces");
  const first = path.join(dir, "first project");
  const second = path.join(dir, "another project");
  for (const folder of [bin, path.join(config, "tdc"), first, second]) fs.mkdirSync(folder, { recursive: true });
  for (const [source, target] of [
    [path.join(ROOTFS, "tdc-claude.sh"), "claude"],
    [path.join(ROOTFS, "tdc-session.sh"), "tdc-session"],
    [path.join(HERE, "fixtures/mock-claude-real.sh"), "tdc-claude-real"],
    [path.join(HERE, "fixtures/isolated-bash.sh"), "bash"],
  ]) {
    const content = fs.readFileSync(source, "utf8").replaceAll("/var/lib/tdc/host-config/mcp.json", shellPath(path.join(dir, "runtime/mcp.json")));
    fs.writeFileSync(path.join(bin, target), content);
    fs.chmodSync(path.join(bin, target), 0o755);
  }
  const provider = path.join(config, "tdc/provider-settings.json");
  fs.writeFileSync(provider, JSON.stringify(apiSettings("first")));
  const log = path.join(dir, "calls.bin");
  const shellLog = path.join(dir, "shells.txt");
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(ANTHROPIC_|CLAUDE_|BASH_ENV$|ENV$|TDC_TEST_|TDC_SESSION_ID$)/i.test(key)));
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: shellPath(config),
    TDC_TEST_DIR: shellPath(dir),
    TDC_TEST_BIN: shellPath(bin),
    TDC_TEST_BASH: BASH.executable,
    TDC_TEST_SECOND: shellPath(second),
    TDC_TEST_LOG: shellPath(log),
    TDC_TEST_SHELL_LOG: shellPath(shellLog),
  });
  return {
    dir, env, provider: shellPath(provider), first: shellPath(first), second: shellPath(second),
    run(script, { input = "", status = 0 } = {}) {
      const result = spawnSync(BASH.command, ["--noprofile", "--norc", "-c",
        `export PATH="$TDC_TEST_BIN:/usr/bin:/bin:$PATH"\ncd -- ${quote(shellPath(first))}\n${script}`],
      { cwd: first, env, input, encoding: "utf8", timeout: 15000 });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, status, result.stderr);
      return result;
    },
    calls() {
      const fields = fs.readFileSync(log, "utf8").split("\0");
      assert.equal(fields.pop(), "", "每次调用记录以 NUL 结尾");
      const calls = [];
      while (fields.length) {
        const [cwd, configDir, sessionId, alternateScreen, apiKey, authToken, baseUrl, json] = fields.splice(0, 8);
        const argc = Number(fields.shift());
        assert.ok(Number.isInteger(argc) && argc >= 0 && argc <= fields.length);
        calls.push({ cwd, configDir, sessionId, alternateScreen, apiKey, authToken, baseUrl,
          settings: json ? JSON.parse(json) : null, args: fields.splice(0, argc) });
      }
      return calls;
    },
    shells: () => fs.readFileSync(shellLog, "utf8").trim().split("\n"),
  };
}

bashTest("Claude 入口：默认注入供应商配置，完整保留参数和配置目录", (t) => {
  const h = harness(t);
  const args = ["--resume", "conversation with spaces", "", "literal $HOME; *", "line one\nline two"];
  h.run(`claude ${args.map(quote).join(" ")}`);
  const [call] = h.calls();
  assert.deepEqual(call.args, ["--settings", h.provider, ...args]);
  assert.deepEqual(call.settings, apiSettings("first"));
  assert.equal(call.configDir, h.env.CLAUDE_CONFIG_DIR);
  assert.equal(call.cwd, h.first);
  assert.equal(call.alternateScreen, "0");
});

bashTest("Claude 界面：显式经典模式覆盖默认值，退出回到 shell 后仍保留", (t) => {
  const h = harness(t);
  h.run(`tdc-session -e CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 --no-tmux classic-session ${quote(h.first)} claude`, {
    input: 'claude --version\nexit 0\n',
  });
  assert.deepEqual(h.calls().map(call => call.alternateScreen), ["1", "1"]);
});

bashTest("YOLO：新建、继续和恢复的 bypassPermissions 参数完整传到 Claude", (t) => {
  const h = harness(t);
  const permission = ["--permission-mode", "bypassPermissions"];
  const launches = [permission, ["--continue", ...permission], ["--resume", "test-conversation", "--model", "opus", ...permission]];
  for (const [index, args] of launches.entries()) {
    h.run(`tdc-session --no-tmux yolo-test-${index} ${quote(h.first)} claude ${args.map(quote).join(" ")}`, { input: "exit 0\n" });
  }
  assert.deepEqual(h.calls().map(call => call.args), launches.map(args => ["--settings", h.provider, ...args]));
});

bashTest("Claude 入口：待定用量来源只在下一次进程启动时激活", (t) => {
  const h = harness(t);
  const active = path.join(h.dir, "config with spaces/tdc/usage-provider.json");
  const pending = path.join(h.dir, "config with spaces/tdc/usage-provider.pending.json");
  fs.writeFileSync(active, JSON.stringify({ providerId: "old", pricing: { input: 1 } }));
  fs.writeFileSync(pending, JSON.stringify({ providerId: "new", pricing: { input: 2 } }));
  h.run("claude --version");
  assert.deepEqual(JSON.parse(fs.readFileSync(active, "utf8")), { providerId: "new", pricing: { input: 2 } });
  assert.equal(fs.existsSync(pending), false);
});

bashTest("Claude 入口：CLI 退出码与标准输出、错误输出原样返回", (t) => {
  const h = harness(t);
  Object.assign(h.env, { TDC_TEST_EXIT_CODE: "23", TDC_TEST_STDOUT: "test output\n", TDC_TEST_STDERR: "test error\n" });
  const result = h.run("claude --version", { status: 23 });
  assert.equal(result.stdout, "test output\n");
  assert.equal(result.stderr, "test error\n");
});

bashTest("会话：首次 Claude 退出后进入 shell，换目录重启仍带供应商配置", (t) => {
  const h = harness(t);
  h.env.TDC_TEST_EXIT_CODE = "17";
  h.run(`tdc-session --no-tmux regression-session ${quote(h.first)} claude --resume 'first session'`, {
    input: 'cd -- "$TDC_TEST_SECOND"\nclaude --print "second invocation"\nexit 0\n',
  });
  const calls = h.calls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.cwd), [h.first, h.second]);
  assert.deepEqual(calls.map((call) => call.args), [
    ["--settings", h.provider, "--resume", "first session"],
    ["--settings", h.provider, "--print", "second invocation"],
  ]);
  for (const call of calls) {
    assert.deepEqual(call.settings, apiSettings("first"));
    assert.equal(call.configDir, h.env.CLAUDE_CONFIG_DIR);
    assert.equal(call.sessionId, "regression-session");
    assert.equal(call.alternateScreen, "0");
  }
  assert.deepEqual(h.shells(), ["shell"]);
});

for (const mode of ["bash", "cmd"]) {
  bashTest(`会话：${mode} 模式及其 shell 都使用全局 Claude 入口`, (t) => {
    const h = harness(t);
    const command = mode === "cmd" ? ` ${quote('cd -- "$TDC_TEST_SECOND"; claude --print "custom command"')}` : "";
    h.run(`tdc-session --no-tmux ${mode}-session ${quote(h.first)} ${mode}${command}`, {
      input: 'claude --print "from shell"\nexit 0\n',
    });
    const calls = h.calls();
    assert.equal(calls.length, mode === "cmd" ? 2 : 1);
    assert.deepEqual(calls.map((call) => call.cwd), mode === "cmd" ? [h.second, h.first] : [h.first]);
    for (const call of calls) {
      assert.deepEqual(call.args.slice(0, 2), ["--settings", h.provider]);
      assert.deepEqual(call.settings, apiSettings("first"));
      assert.equal(call.sessionId, `${mode}-session`);
    }
    assert.deepEqual(h.shells(), mode === "cmd" ? ["cmd", "shell"] : ["shell"]);
  });
}

bashTest("Claude 入口：同一 shell 切换供应商、订阅和移除配置后读取当前文件", (t) => {
  const h = harness(t);
  const next = path.join(h.dir, "next.json");
  const subscription = path.join(h.dir, "subscription.json");
  fs.writeFileSync(next, JSON.stringify(apiSettings("second")));
  fs.writeFileSync(subscription, JSON.stringify({ env: {} }));
  h.run(`claude
cp -- ${quote(shellPath(next))} ${quote(h.provider)}
cd -- "$TDC_TEST_SECOND"
claude
cp -- ${quote(shellPath(subscription))} ${quote(h.provider)}
claude
rm -- ${quote(h.provider)}
claude`);
  const calls = h.calls();
  assert.deepEqual(calls.map((call) => call.settings), [apiSettings("first"), apiSettings("second"), { env: {} }, null]);
  assert.deepEqual(calls.map((call) => call.args), [
    ["--settings", h.provider], ["--settings", h.provider], ["--settings", h.provider], [],
  ]);
  for (const call of calls) {
    assert.equal(call.apiKey, "");
    assert.equal(call.authToken, "");
    assert.equal(call.baseUrl, "");
  }
});

bashTest("Claude 入口：显式 --settings 与 --settings= 配置覆盖默认供应商", (t) => {
  const h = harness(t);
  const custom = path.join(h.dir, "custom settings.json");
  fs.writeFileSync(custom, JSON.stringify(apiSettings("custom")));
  const variants = [["--settings", shellPath(custom)], [`--settings=${shellPath(custom)}`], ["--settings", "{}"]];
  for (const args of variants) h.run(`claude ${args.map(quote).join(" ")} --print override`);
  const calls = h.calls();
  assert.deepEqual(calls.map((call) => call.args), variants.map((args) => [...args, "--print", "override"]));
  assert.deepEqual(calls.map((call) => call.settings), [apiSettings("custom"), apiSettings("custom"), {}]);
});

bashTest("Claude 入口：-- 后的 --settings 字样作为位置参数保留", (t) => {
  const h = harness(t);
  const args = ["--", "--settings", "literal prompt", "--settings=also literal"];
  h.run(`claude ${args.map(quote).join(" ")}`);
  assert.deepEqual(h.calls()[0].args, ["--settings", h.provider, ...args]);
});

bashTest("Claude 入口：没有供应商文件时参数不变，未设配置目录时导出容器默认目录", (t) => {
  const h = harness(t);
  fs.unlinkSync(path.join(h.dir, "config with spaces/tdc/provider-settings.json"));
  h.run("claude --resume 'subscription session'");
  delete h.env.CLAUDE_CONFIG_DIR;
  h.run("claude --version");
  const calls = h.calls();
  assert.deepEqual(calls[0].args, ["--resume", "subscription session"]);
  assert.equal(calls[0].configDir, shellPath(path.join(h.dir, "config with spaces")));
  assert.equal(calls[1].configDir, "/home/node/.claude");
});

function hostMcp(h) {
  const file = path.join(h.dir, "runtime/mcp.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { fixture: { type: "http", url: "https://fixture.invalid" } } }));
  return shellPath(file);
}

bashTest("Claude 入口：宿主 MCP 合并原配置，裸 prompt 和 -- 后的字面参数保持原位", (t) => {
  const h = harness(t), mcp = hostMcp(h);
  const variants = [["请检查项目", ""], ["--print", "检查含空格的 prompt"], ["--", "--mcp-config", "literal prompt"]];
  for (const args of variants) h.run(`claude ${args.map(quote).join(" ")}`);
  assert.deepEqual(h.calls().map((call) => call.args), [
    ["--settings", h.provider, ...variants[0], `--mcp-config=${mcp}`],
    ["--settings", h.provider, ...variants[1], `--mcp-config=${mcp}`],
    ["--settings", h.provider, `--mcp-config=${mcp}`, ...variants[2]],
  ]);
  for (const call of h.calls()) assert.equal(call.args.includes("--strict-mcp-config"), false);
});

bashTest("Claude 入口：显式 settings 仍加载宿主 MCP，显式 MCP/strict 配置优先", (t) => {
  const h = harness(t), mcp = hostMcp(h);
  const variants = [["--settings", "{}", "prompt"], ["--settings={}", "prompt"], ["--mcp-config", "custom.json", "--print", "prompt"], ["--mcp-config=custom.json", "prompt"], ["--strict-mcp-config", "prompt"]];
  for (const args of variants) h.run(`claude ${args.map(quote).join(" ")}`);
  assert.deepEqual(h.calls().map((call) => call.args), [
    [...variants[0], `--mcp-config=${mcp}`], [...variants[1], `--mcp-config=${mcp}`],
    ["--settings", h.provider, ...variants[2]], ["--settings", h.provider, ...variants[3]], ["--settings", h.provider, ...variants[4]],
  ]);
});

bashTest("Claude 入口：取消宿主 MCP 后立即恢复容器原有 MCP 读取行为", (t) => {
  const h = harness(t), mcp = hostMcp(h);
  h.run("claude --print first");
  fs.unlinkSync(path.join(h.dir, "runtime/mcp.json"));
  h.run("claude --print second");
  assert.deepEqual(h.calls().map((call) => call.args), [["--settings", h.provider, "--print", "first", `--mcp-config=${mcp}`], ["--settings", h.provider, "--print", "second"]]);
});

test("root 入口：旧镜像安装保留相对 CLI 链接，重复安装幂等，缺失真实入口不形成递归", { skip: process.platform === "win32" || !BASH ? "需 Linux 文件 symlink；隔离容器覆盖" : false }, (t) => {
  const h = harness(t);
  const installed = path.join(h.dir, "installed-bin"), library = path.join(h.dir, "lib");
  fs.mkdirSync(installed);
  fs.mkdirSync(library);
  fs.writeFileSync(path.join(library, "original-cli"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  const cli = path.join(installed, "claude"), real = path.join(installed, "tdc-claude-real");
  const wrapper = path.join(h.dir, "bin", "claude");
  const entrypoint = fs.readFileSync(path.join(ROOTFS, "entrypoint.sh"), "utf8");
  const functionBody = entrypoint.match(/install_claude_launcher\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(functionBody);
  const installer = functionBody.replace(/local cli=.*\n/, `local cli=${quote(cli)} real=${quote(real)} wrapper=${quote(wrapper)}\n`);
  h.run(`${installer}
ln -s ../lib/original-cli ${quote(cli)}
install_claude_launcher
install_claude_launcher
[[ "$(readlink ${quote(real)})" == ../lib/original-cli ]]
[[ "$(readlink ${quote(cli)})" == ${quote(wrapper)} ]]
rm -- ${quote(real)}
if install_claude_launcher; then exit 71; fi
[[ ! -e ${quote(real)} && ! -L ${quote(real)} ]]
[[ "$(readlink ${quote(cli)})" == ${quote(wrapper)} ]]`);
});

bashTest("会话进程识别：兼容包装后的原生 Claude，排除其他程序和其他会话", (t) => {
  const h = harness(t);
  const proc = path.join(h.dir, "proc");
  const processes = [
    [101, "node", ["node", "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"], "target-session"],
    [102, "claude", ["/home/node/.local/bin/claude"], "target-session"],
    [103, "tdc-claude-real", ["/usr/local/bin/tdc-claude-real", "--settings", h.provider], "target-session"],
    [104, "bash", ["bash", "-c", "claude; exec bash -l"], "target-session"],
    [105, "node", ["node", "/opt/tdc/statusline.mjs", "claude"], "target-session"],
    [106, "node", ["node", "/workspace/server.mjs"], "target-session"],
    [107, "tdc-claude-real", ["/usr/local/bin/tdc-claude-real"], "other-session"],
    [108, "claude", ["claude"], "target-session-longer"],
  ];
  for (const [pid, comm, args, session] of processes) {
    const dir = path.join(proc, String(pid));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "comm"), `${comm}\n`);
    fs.writeFileSync(path.join(dir, "cmdline"), `${args.join("\0")}\0`);
    fs.writeFileSync(path.join(dir, "environ"), `TDC_SESSION_ID=${session}\0`);
  }
  const tmux = path.join(h.dir, "bin/tmux");
  fs.writeFileSync(tmux, "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  h.env.PROC_ROOT = shellPath(proc);
  const result = h.run(`source ${quote(shellPath(path.join(ROOTFS, "tdc-ctl.sh")))} session-list >/dev/null
find_claude_pids target-session || true`);
  assert.deepEqual(result.stdout.trim().split("\n"), ["101", "102", "103"]);
});
