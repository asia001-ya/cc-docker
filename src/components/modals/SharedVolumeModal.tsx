/**
 * 弹框 5：共享会话卷设置。
 * 选择共享组与参与容器；Docker 无法修改已有容器的挂载，因此"应用"会按原配置重建容器（凭证卷保留）。
 */
import { useMemo, useState } from "react";
import { errorText, isTauri, sharedGroupApply } from "../../api/commands";
import { useFleetStore } from "../../store/fleetStore";
import { useTabStore } from "../../store/tabStore";
import { useUiStore } from "../../store/uiStore";
import { Modal } from "../ui/Modal";
import { Button, Callout, Checkbox, Field, Icon, Input, Section, StatusDot } from "../ui/controls";

/**
 * 共享卷弹框。
 * @returns JSX
 */
export function SharedVolumeModal() {
  const close = useUiStore((s) => s.closeModal);
  const toast = useUiStore((s) => s.toast);
  const entries = useFleetStore((s) => s.fleet.entries);
  const sessions = useTabStore((s) => s.sessions);
  const [group, setGroup] = useState("default");
  const initial = useMemo(() => new Set(entries.filter((e) => e.container.sharedGroup === group).map((e) => e.container.name)), [entries, group]);
  const [members, setMembers] = useState<Set<string>>(initial);
  const [shareMemory, setShareMemory] = useState(true);
  const [busy, setBusy] = useState(false);

  const joins = [...members].filter((m) => !initial.has(m) || entries.find((e) => e.container.name === m)?.container.sharedGroup !== group);
  const leaves = [...initial].filter((m) => !members.has(m));
  const affected = [...joins, ...leaves];
  const affectedSessions = Object.values(sessions).filter((s) => affected.includes(s.container)).length;
  const volSuffix = group && group !== "default" ? `_${group}` : "";

  /**
   * 切换成员。
   * @param name 容器名
   * @param v 是否加入
   * @returns 无
   */
  const toggle = (name: string, v: boolean) =>
    setMembers((s) => {
      const n = new Set(s);
      if (v) n.add(name);
      else n.delete(name);
      return n;
    });

  /**
   * 应用并重建。
   * @returns Promise
   */
  const apply = async () => {
    if (affected.length === 0) return close();
    if (!isTauri()) {
      toast("info", "演示模式：未连接后端");
      return close();
    }
    setBusy(true);
    try {
      const rebuilt = await sharedGroupApply({ group, members: joins, remove: leaves });
      toast("success", `已重建 ${rebuilt.length} 个容器：${rebuilt.join("、")}`);
      close();
    } catch (e) {
      toast("error", `应用失败：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="共享会话卷设置"
      icon="folder_shared"
      width={760}
      onClose={close}
      onSubmit={() => void apply()}
      footerLeft={
        affected.length > 0 ? (
          <span className="font-ui text-label-md text-st-warn">将重建 {affected.length} 个容器，断开 {affectedSessions} 个终端会话（tmux 会话随容器重建而结束）</span>
        ) : (
          <span className="font-ui text-label-md text-on-surface-variant">无变更</span>
        )
      }
      footer={
        <>
          <Button onClick={close}>取消</Button>
          <Button variant="primary" icon="autorenew" kbd="Ctrl+Enter" disabled={busy || affected.length === 0} onClick={() => void apply()}>
            {busy ? "正在重建…" : "应用并重建"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Callout tone="info">
          共享卷让多个容器读写同一份 <code className="font-mono">~/.claude/projects</code>（会话 JSONL），从而在额度耗尽时用 <code className="font-mono">claude --resume</code> 在另一个容器接着聊。凭证（
          <code className="font-mono">.credentials.json</code>）始终保存在各容器独立的 home 卷中，<strong>不会共享</strong>。
        </Callout>
        <div className="grid grid-cols-2 gap-4">
          <Section title="共享组" icon="hub">
            <Field label="组名" hint="不同组之间的会话互相隔离">
              <Input mono value={group} onChange={(e) => setGroup(e.target.value.replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "default")} />
            </Field>
            <div className="flex flex-col gap-1 rounded-lg bg-black/25 p-2.5 font-mono text-code-sm">
              <div className="flex items-center gap-1.5 text-on-surface-variant">
                <Icon name="database" size={14} className="text-teal" />
                <span className="text-teal">tdc_shared_projects{volSuffix}</span>
              </div>
              <div className="pl-5 text-outline">→ /home/node/.claude/projects（会话历史）</div>
              <div className={`mt-1 flex items-center gap-1.5 ${shareMemory ? "text-on-surface-variant" : "text-outline line-through"}`}>
                <Icon name="database" size={14} className="text-magenta" />
                <span className="text-magenta">tdc_shared_memory{volSuffix}</span>
              </div>
              <div className="pl-5 text-outline">→ /home/node/.claude-shared（CLAUDE.md / skills / commands / agents）</div>
            </div>
            <Checkbox checked={shareMemory} onChange={setShareMemory} label="同时共享 CLAUDE.md 与 skills" desc="容器启动时自动链接到 ~/.claude；容器内已有同名真实文件时不覆盖" />
          </Section>
          <Section title="参与容器" icon="deployed_code" aside={<span className="font-ui text-label-sm text-on-surface-variant">已选 {members.size}</span>}>
            <div className="flex max-h-[300px] flex-col gap-1 overflow-y-auto">
              {entries.map((e) => {
                const name = e.container.name;
                const on = members.has(name);
                const changed = on !== initial.has(name) || (on && e.container.sharedGroup !== group);
                return (
                  <div key={name} className={`flex items-center justify-between rounded-lg px-2 py-1.5 ${changed ? "bg-st-warn-bg/50" : "bg-white/[0.03]"}`}>
                    <Checkbox
                      checked={on}
                      onChange={(v) => toggle(name, v)}
                      label={
                        <span className="flex items-center gap-1.5">
                          <StatusDot health={e.health} size={6} />
                          {name}
                        </span>
                      }
                      desc={e.container.sharedGroup ? `当前组：${e.container.sharedGroup}` : "当前未共享"}
                    />
                    {changed && <span className="font-ui text-label-sm text-st-warn">需重建</span>}
                  </div>
                );
              })}
            </div>
          </Section>
        </div>
        <Callout tone="warning">
          热切换还要求各容器在<strong>相同容器路径</strong>挂载同一个项目目录（Claude 按工作目录归档会话）。重建会保留原镜像、端口、挂载与环境变量。
        </Callout>
      </div>
    </Modal>
  );
}
