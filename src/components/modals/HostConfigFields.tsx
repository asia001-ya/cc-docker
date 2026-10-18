import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { HostClaudeConfig } from "../../api/types";
import { errorText, hostConfigDefaults, isTauri } from "../../api/commands";
import { HOST_CONFIG_ITEMS, type HostConfigPathKey } from "../../lib/hostConfig";
import { Button, Callout, Input, Switch } from "../ui/controls";

const DEMO_DEFAULTS: HostClaudeConfig = import.meta.env.DEV ? {
  skills: "C:\\Users\\you\\.claude\\skills",
  commands: "C:\\Users\\you\\.claude\\commands",
  claudeMd: "C:\\Users\\you\\.claude\\CLAUDE.md",
  mcpConfigs: ["C:\\Users\\you\\.claude\\plugins\\context7\\.mcp.json"],
} : {};

/** 开关只改草稿；实际挂载由创建或应用操作完成。 */
export function HostConfigFields({ value, onChange, disabled = false }: {
  value: HostClaudeConfig;
  onChange: (config: HostClaudeConfig) => void;
  disabled?: boolean;
}) {
  const [defaults, setDefaults] = useState<HostClaudeConfig>({});
  const [detecting, setDetecting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const previousPaths = useRef<HostClaudeConfig>({});
  const mcpEnabled = !!value.mcpConfigs?.length;

  useEffect(() => {
    let active = true;
    if (!isTauri()) {
      setDefaults(DEMO_DEFAULTS);
      setDetecting(false);
      return;
    }
    hostConfigDefaults().then((result) => { if (active) setDefaults(result.config); })
      .catch((cause) => { if (active) setError(`自动检测失败，可手动选择路径：${errorText(cause)}`); })
      .finally(() => { if (active) setDetecting(false); });
    return () => { active = false; };
  }, []);

  const togglePath = (key: HostConfigPathKey, enabled: boolean) => {
    if (!enabled) previousPaths.current[key] = value[key];
    onChange({ ...value, [key]: enabled ? previousPaths.current[key] ?? defaults[key] ?? "" : null });
  };

  const browsePath = async (key: HostConfigPathKey, directory: boolean) => {
    if (!isTauri()) return;
    try {
      const path = await openDialog({ directory, title: `选择宿主 ${key === "claudeMd" ? "CLAUDE.md" : key} ${directory ? "目录" : "文件"}` });
      if (typeof path === "string") onChange({ ...value, [key]: path });
    } catch (cause) { setError(errorText(cause)); }
  };

  const toggleMcp = (enabled: boolean) => {
    if (!enabled) previousPaths.current.mcpConfigs = value.mcpConfigs;
    const saved = previousPaths.current.mcpConfigs;
    const detected = defaults.mcpConfigs;
    onChange({ ...value, mcpConfigs: enabled ? saved?.length ? saved : detected?.length ? detected : [""] : [] });
  };

  const browseMcp = async (index: number) => {
    if (!isTauri()) return;
    try {
      const path = await openDialog({ directory: false, title: "选择宿主 MCP 配置文件", filters: [{ name: "JSON 配置", extensions: ["json"] }] });
      if (typeof path === "string") onChange({ ...value, mcpConfigs: value.mcpConfigs!.map((source, i) => i === index ? path : source) });
    } catch (cause) { setError(errorText(cause)); }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="font-ui text-body-sm text-on-surface-variant">按需启用。未启用的项沿用容器原配置；宿主目录只读挂载。</p>
      {error && <Callout tone="warning">{error}</Callout>}
      {detecting && <span className="font-ui text-body-sm text-outline">正在检测宿主 Claude 配置…</span>}
      <div className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.06] bg-black/10 px-3">
        {HOST_CONFIG_ITEMS.map(({ key, label, directory, description }) => {
          const enabled = value[key] != null;
          return (
            <div key={key} className="flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Switch checked={enabled} onChange={(on) => togglePath(key, on)} disabled={disabled || detecting} label={`使用宿主 ${label}`} />
                <span className="font-ui text-label-sm text-outline">{enabled ? description : "使用容器配置"}</span>
              </div>
              {enabled && <div className="flex gap-2">
                <Input mono aria-label={`宿主 ${label} 路径`} value={value[key] ?? ""} disabled={disabled} placeholder={`选择宿主${directory ? "目录" : "文件"}`}
                  onChange={(event) => onChange({ ...value, [key]: event.target.value })} />
                <Button className="shrink-0 whitespace-nowrap" disabled={disabled} onClick={() => void browsePath(key, directory)}>浏览</Button>
              </div>}
            </div>
          );
        })}
        <div className="flex flex-col gap-2 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Switch checked={mcpEnabled} onChange={toggleMcp} disabled={disabled || detecting} label="合并宿主 MCP" />
            <span className="font-ui text-label-sm text-outline">{mcpEnabled ? "同名 MCP 优先宿主" : "使用容器配置"}</span>
          </div>
          {mcpEnabled && <>
            <p className="font-ui text-body-sm text-on-surface-variant">保留容器 MCP。仅导出所选文件中的服务器配置，不共享 Claude 登录信息；多个来源按下方顺序合并，后面的同名项优先。</p>
            {value.mcpConfigs!.map((path, index) => <div key={index} className="flex items-center gap-2">
              <Input mono aria-label={`MCP 来源 ${index + 1}`} value={path} disabled={disabled} placeholder=".mcp.json / .claude.json"
                onChange={(event) => onChange({ ...value, mcpConfigs: value.mcpConfigs!.map((source, i) => i === index ? event.target.value : source) })} />
              <Button className="shrink-0 whitespace-nowrap" disabled={disabled} onClick={() => void browseMcp(index)}>浏览</Button>
              <Button variant="subtle" icon="close" className="shrink-0" aria-label={`移除 MCP 来源 ${index + 1}`} disabled={disabled}
                onClick={() => onChange({ ...value, mcpConfigs: value.mcpConfigs!.filter((_, i) => i !== index) })} />
            </div>)}
            <Button variant="subtle" icon="add" className="self-start" disabled={disabled}
              onClick={() => onChange({ ...value, mcpConfigs: [...value.mcpConfigs!, ""] })}>添加 MCP 来源</Button>
            <p className="font-ui text-label-sm text-outline">MCP 配置在应用时导入，源文件修改后可在容器配置中重新导入。stdio 服务在容器内运行，Windows 命令、浏览器和所需环境变量需适配容器。</p>
          </>}
        </div>
      </div>
    </div>
  );
}
