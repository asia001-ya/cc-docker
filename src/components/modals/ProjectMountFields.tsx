import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ProjectMount } from "../../api/types";
import { errorText, isTauri } from "../../api/commands";
import { deriveContainerPath } from "../../lib/validators";
import { useUiStore } from "../../store/uiStore";
import { Button, Icon, Input, Section, Switch } from "../ui/controls";

export function ProjectMountFields({ mounts, onChange, disabled = false }: {
  mounts: ProjectMount[]; onChange: (mounts: ProjectMount[]) => void; disabled?: boolean;
}) {
  const setMount = (index: number, patch: Partial<ProjectMount>) =>
    onChange(mounts.map((mount, i) => i === index ? { ...mount, ...patch } : mount));
  const browse = async (index: number) => {
    if (!isTauri()) return useUiStore.getState().toast("info", "演示模式可使用手动添加");
    try {
      const selected = await openDialog({ directory: true, title: "选择要挂载到容器的项目目录" });
      if (typeof selected !== "string") return;
      if (index < 0) onChange([...mounts, { hostPath: selected, containerPath: deriveContainerPath(selected), readOnly: false }]);
      else setMount(index, { hostPath: selected, containerPath: mounts[index].containerPath || deriveContainerPath(selected) });
    } catch (error) { useUiStore.getState().toast("error", errorText(error)); }
  };
  return <Section title="项目目录挂载" icon="folder_open" aside={
    <Button variant="subtle" icon="add" disabled={disabled} onClick={() => void browse(-1)}>添加目录</Button>
  }>
    {mounts.length === 0 && <button type="button" disabled={disabled} onClick={() => void browse(-1)}
      className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-white/15 py-5 font-ui text-body-sm text-on-surface-variant hover:border-accent/50">
      <Icon name="create_new_folder" size={24} />选择宿主机项目目录
    </button>}
    {mounts.map((mount, index) => <div key={index} className="flex flex-col gap-2 rounded-lg bg-white/[0.03] p-2">
      <div className="flex items-center gap-2">
        <Input mono className="min-w-0 flex-1" aria-label={"宿主目录 " + (index + 1)} disabled={disabled} value={mount.hostPath}
          onChange={(event) => setMount(index, { hostPath: event.target.value })} placeholder="宿主机项目的绝对路径" />
        <Button className="shrink-0 whitespace-nowrap" disabled={disabled} icon="folder" onClick={() => void browse(index)}>浏览</Button>
        <Button className="shrink-0" disabled={disabled} variant="subtle" icon="delete" title={"移除挂载 " + (index + 1)}
          onClick={() => onChange(mounts.filter((_, i) => i !== index))} />
      </div>
      <div className="flex items-center gap-2 font-ui text-label-sm text-on-surface-variant">
        <span className="shrink-0">容器内</span>
        <Input mono className="min-w-0 flex-1" aria-label={"容器挂载路径 " + (index + 1)} disabled={disabled} value={mount.containerPath}
          onChange={(event) => setMount(index, { containerPath: event.target.value })} placeholder="/workspace/project" />
        <span className="shrink-0 whitespace-nowrap"><Switch disabled={disabled} checked={mount.readOnly} onChange={(readOnly) => setMount(index, { readOnly })} label="只读" /></span>
      </div>
    </div>)}
    <Button variant="subtle" disabled={disabled} className="self-start" onClick={() => onChange([...mounts, { hostPath: "", containerPath: "", readOnly: false }])}>手动添加路径</Button>
    <p className="font-ui text-body-sm text-on-surface-variant">跨容器继续同一会话时，请把项目挂载到相同的容器路径。移除挂载不会删除宿主目录。</p>
  </Section>;
}
