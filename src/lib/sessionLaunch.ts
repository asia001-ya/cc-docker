export type SessionLaunch = "claude" | "resume" | "continue" | "bash" | "cmd";

/** Keep the UI choice authoritative while leaving positional prompt text intact. */
function withYolo(extra: string[]): string[] {
  const separator = extra.indexOf("--");
  const options = separator < 0 ? extra : extra.slice(0, separator);
  const positional = separator < 0 ? [] : extra.slice(separator);
  const retained: string[] = [];
  for (let i = 0; i < options.length; i++) {
    const arg = options[i];
    if (arg === "--permission-mode") {
      if (options[i + 1] && !options[i + 1].startsWith("-")) i++;
    } else if (!arg.startsWith("--permission-mode=") && arg !== "--dangerously-skip-permissions") {
      retained.push(arg);
    }
  }
  return [...retained, "--permission-mode", "bypassPermissions", ...positional];
}

export function buildSessionLaunchArgs(launch: SessionLaunch, extra: string[], yolo: boolean, resumeId = "", custom = ""): string[] {
  if (launch === "bash") return [];
  if (launch === "cmd") return [custom];
  const args = yolo ? withYolo(extra) : [...extra];
  if (launch === "resume") return ["--resume", resumeId, ...args];
  if (launch === "continue") return ["--continue", ...args];
  return args;
}
