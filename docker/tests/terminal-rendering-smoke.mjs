/** Opt-in real Claude/tmux rendering check. No prompts are submitted to a model. */
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const container = process.env.TDC_TEST_CONTAINER;
if (!container) throw new Error("Set TDC_TEST_CONTAINER to a running development container");
const sources = Object.fromEntries(["tdc-claude.sh", "tdc-session.sh"].map(name => [name,
  fs.readFileSync(new URL(`../rootfs/opt/tdc/${name}`, import.meta.url), "utf8"),
]));
const fixture = fs.readFileSync(new URL("./fixtures/terminal-rendering-smoke.cjs", import.meta.url), "utf8");
const reattachSource = fs.readFileSync(new URL("../../src-tauri/src/terminal/reattach.sh", import.meta.url), "utf8");
const result = spawnSync("docker", ["exec", "-i", "--user", "node", "--workdir", "/workspace", container, "node", "-"], {
  input: `const sources = ${JSON.stringify(sources)};\nconst reattachSource = ${JSON.stringify(reattachSource)};\n${fixture}`,
  encoding: "utf8", timeout: 60000,
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
