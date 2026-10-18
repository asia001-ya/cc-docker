import type { HostClaudeConfig } from "../api/types";

export const HOST_CONFIG_ITEMS = [
  { key: "skills", label: "Skills", directory: true, description: "复用宿主技能目录" },
  { key: "commands", label: "Commands", directory: true, description: "复用宿主自定义命令" },
  { key: "agents", label: "Agents", directory: true, description: "复用宿主子代理定义" },
  { key: "claudeMd", label: "CLAUDE.md", directory: false, description: "复用宿主全局指令文件" },
] as const;

export type HostConfigPathKey = typeof HOST_CONFIG_ITEMS[number]["key"];

export function hasHostConfig(config: HostClaudeConfig | null | undefined): boolean {
  return !!config && (HOST_CONFIG_ITEMS.some(({ key }) => config[key] != null) || !!config.mcpConfigs?.length);
}

/** 只规范路径和空项，不排序 MCP 来源（后面的同名服务器优先）。 */
export function normalizeHostConfig(config: HostClaudeConfig | null | undefined): HostClaudeConfig {
  return {
    skills: config?.skills?.trim() || null,
    commands: config?.commands?.trim() || null,
    agents: config?.agents?.trim() || null,
    claudeMd: config?.claudeMd?.trim() || null,
    mcpConfigs: config?.mcpConfigs?.map((path) => path.trim()).filter(Boolean) ?? [],
  };
}

export function hostConfigErrors(config: HostClaudeConfig | null | undefined): string[] {
  if (!config) return [];
  const paths = [
    ...HOST_CONFIG_ITEMS.filter(({ key }) => config[key] != null).map(({ key, label }) => ({ path: config[key]!, label })),
    ...(config.mcpConfigs ?? []).map((path, index) => ({ path, label: `MCP 来源 ${index + 1}` })),
  ];
  return paths.flatMap(({ path, label }) => {
    if (!path.trim()) return [`请选择${label}的宿主路径`];
    if (/[\0\r\n]/.test(path) || !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\|\/)/i.test(path.trim())) return [`${label}需要使用绝对路径`];
    return [];
  });
}

export function sameHostConfig(a: HostClaudeConfig | null | undefined, b: HostClaudeConfig | null | undefined): boolean {
  return JSON.stringify(normalizeHostConfig(a)) === JSON.stringify(normalizeHostConfig(b));
}
