import { describe, expect, it } from "vitest";
import { hasHostConfig, hostConfigErrors, normalizeHostConfig, sameHostConfig } from "./hostConfig";

describe("宿主配置草稿", () => {
  it("全部关闭兼容旧请求，开启但没选路径不能静默变成关闭", () => {
    expect(hasHostConfig(undefined)).toBe(false);
    expect(hasHostConfig({ skills: null, mcpConfigs: [] })).toBe(false);
    expect(hasHostConfig({ skills: "" })).toBe(true);
    expect(hostConfigErrors({ skills: "" })).toEqual(["请选择Skills的宿主路径"]);
    expect(hostConfigErrors({ mcpConfigs: [""] })).toEqual(["请选择MCP 来源 1的宿主路径"]);
  });

  it("接受 Windows、UNC 与 Unix 绝对路径，拒绝相对路径和换行", () => {
    expect(hostConfigErrors({ skills: "C:\\Users\\me\\.claude\\skills", commands: "\\\\wsl$\\Ubuntu\\home\\me\\commands", agents: "/home/me/agents" })).toEqual([]);
    expect(hostConfigErrors({ skills: "../skills", mcpConfigs: ["C:\\config.json\n"] })).toHaveLength(2);
  });

  it("禁用不污染其他配置，MCP顺序影响同名项优先级", () => {
    const before = { skills: " C:\\skills ", commands: null, mcpConfigs: [" C:\\a.json ", "C:\\b.json"] };
    expect(normalizeHostConfig(before)).toMatchObject({ skills: "C:\\skills", mcpConfigs: ["C:\\a.json", "C:\\b.json"] });
    expect(before.skills).toBe(" C:\\skills ");
    expect(sameHostConfig({}, { skills: null, commands: null, mcpConfigs: [] })).toBe(true);
    expect(sameHostConfig(before, { skills: "C:\\skills", mcpConfigs: ["C:\\a.json", "C:\\b.json"] })).toBe(true);
    expect(sameHostConfig(before, { skills: "C:\\skills", mcpConfigs: ["C:\\b.json", "C:\\a.json"] })).toBe(false);
  });
});
