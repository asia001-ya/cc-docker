import { describe, expect, it } from "vitest";
import { buildSessionLaunchArgs } from "./sessionLaunch";

describe("YOLO 会话启动", () => {
  it("关闭时保留普通参数，不主动改变权限配置", () => {
    expect(buildSessionLaunchArgs("claude", [], false)).toEqual([]);
    expect(buildSessionLaunchArgs("claude", ["--model", "opus", "--permission-mode", "plan"], false))
      .toEqual(["--model", "opus", "--permission-mode", "plan"]);
  });

  it("新建、继续、恢复都以 bypassPermissions 启动，并保留恢复 ID", () => {
    const permission = ["--permission-mode", "bypassPermissions"];
    expect(buildSessionLaunchArgs("claude", [], true)).toEqual(permission);
    expect(buildSessionLaunchArgs("continue", ["--model", "opus"], true)).toEqual(["--continue", "--model", "opus", ...permission]);
    expect(buildSessionLaunchArgs("resume", [], true, "conversation-123")).toEqual(["--resume", "conversation-123", ...permission]);
  });

  it("开关覆盖冲突或重复的权限参数，不改变其他参数和原数组", () => {
    const extra = ["--permission-mode", "plan", "--model", "opus", "--permission-mode=acceptEdits", "--dangerously-skip-permissions"];
    const original = [...extra];
    expect(buildSessionLaunchArgs("claude", extra, true)).toEqual(["--model", "opus", "--permission-mode", "bypassPermissions"]);
    expect(extra).toEqual(original);
    expect(buildSessionLaunchArgs("claude", ["--permission-mode", "--model", "opus"], true)).toEqual(["--model", "opus", "--permission-mode", "bypassPermissions"]);
  });

  it("权限参数放在 -- 前，不把后面的提示文本识别成选项", () => {
    expect(buildSessionLaunchArgs("claude", ["--model", "opus", "--", "--permission-mode", "plan"], true))
      .toEqual(["--model", "opus", "--permission-mode", "bypassPermissions", "--", "--permission-mode", "plan"]);
  });

  it("切换为 bash 或自定义命令时不注入 Claude 参数", () => {
    expect(buildSessionLaunchArgs("bash", ["--model", "opus"], true)).toEqual([]);
    expect(buildSessionLaunchArgs("cmd", [], true, "", "npm run dev")).toEqual(["npm run dev"]);
  });
});
