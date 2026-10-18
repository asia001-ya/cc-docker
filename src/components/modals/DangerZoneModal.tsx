/**
 * 弹框 6：删除 / 强制停止容器危险区。
 * 警告图标、影响范围、操作模式、卷处理；必须输入容器名才能确认。
 */
import { useState } from "react";
import { containerAction, containerRemove, errorText, isTauri } from "../../api/commands";
import { useShallow } from "zustand/react/shallow";
import { useEntry } from "../../store/fleetStore";
import { useTabStore } from "../../store/tabStore";
import { useUiStore } from "../../store/uiStore";
import { dispose } from "../terminal/xtermPool";
import { Modal } from "../ui/Modal";
import { Button, CardRadio, Checkbox, Field, Icon, Input } from "../ui/controls";

/**
 * 危险操作弹框。
 * @param props container 容器名、action 默认动作
 * @returns JSX
 */
export function DangerZoneModal({ container, action }: { container: string; action: "stop" | "remove" }) {
  const close = useUiStore((s) => s.closeModal);
  const toast = useUiStore((s) => s.toast);
  const entry = useEntry(container);
  const sessions = useTabStore(useShallow((s) => Object.values(s.sessions).filter((r) => r.container === container)));
  const removeSession = useTabStore((s) => s.removeSession);
  const [mode, setMode] = useState<"stop" | "kill" | "remove">(action === "remove" ? "remove" : "stop");
  const [removeHome, setRemoveHome] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const needConfirm = mode !== "stop";
  const ok = !needConfirm || confirmName === container;

  /**
   * 执行。
   * @returns Promise
   */
  const run = async () => {
    if (!ok || busy) return;
    if (!isTauri()) {
      toast("info", "演示模式：未连接后端");
      return close();
    }
    setBusy(true);
    try {
      if (mode === "remove") await containerRemove(container, confirmName, removeHome);
      else await containerAction(container, mode);
      for (const s of sessions) {
        dispose(s.id);
        removeSession(s.id);
      }
      toast("success", `${container} 已${mode === "remove" ? "删除" : mode === "kill" ? "强制停止" : "停止"}`);
      close();
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const ports = entry?.container.ports ?? [];
  return (
    <Modal
      title={mode === "remove" ? "删除容器" : "停止容器"}
      icon="warning"
      danger
      width={620}
      onClose={close}
      onSubmit={() => void run()}
      footer={
        <>
          <Button onClick={close} data-autofocus>
            取消
          </Button>
          <Button variant="danger" icon={mode === "remove" ? "delete_forever" : "stop_circle"} disabled={!ok || busy} onClick={() => void run()}>
            {busy ? "执行中…" : mode === "remove" ? "我已了解，删除容器" : mode === "kill" ? "强制停止" : "停止容器"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-st-bad/15 text-st-bad">
            <Icon name="report" size={26} fill />
          </span>
          <div className="flex flex-col gap-1">
            <span className="font-ui text-headline-md text-on-surface">
              即将{mode === "remove" ? "删除" : "停止"} <span className="font-mono text-st-bad">{container}</span>
            </span>
            <span className="font-ui text-body-md text-on-surface-variant">此操作会立即中断该容器内正在运行的一切任务。</span>
          </div>
        </div>

        <div className="rounded-lg border border-st-bad/25 bg-st-bad-bg/50 p-3 font-ui text-body-md">
          <div className="mb-1.5 font-ui text-label-md text-st-bad">影响范围</div>
          <ul className="flex flex-col gap-1 text-on-surface">
            <li className="flex items-center gap-2">
              <Icon name="terminal" size={15} className="text-outline" /> {sessions.length} 个终端会话将断开{mode !== "stop" ? "，tmux 会话与其中的 claude 进程将被终止" : "（tmux 会话随容器停止而结束）"}
            </li>
            <li className="flex items-center gap-2">
              <Icon name="lan" size={15} className="text-outline" /> {ports.length ? `端口 ${ports.map((p) => p[1]).join("、")} 将不可访问` : "无端口映射"}
            </li>
            {mode === "remove" && (
              <li className="flex items-center gap-2">
                <Icon name="key" size={15} className="text-outline" />
                {removeHome ? <span className="text-st-bad">凭证卷 tdc_home_{container} 将被删除，需要重新登录</span> : <>凭证卷 tdc_home_{container} 将保留，可用于同名重建</>}
              </li>
            )}
            <li className="flex items-center gap-2">
              <Icon name="folder" size={15} className="text-outline" /> 项目源码（bind mount）与共享会话卷不受影响
            </li>
          </ul>
        </div>

        <CardRadio
          columns={3}
          value={mode}
          onChange={setMode}
          options={[
            { value: "stop", icon: "stop_circle", title: "停止", desc: "发送 SIGTERM，10 秒后强制结束" },
            { value: "kill", icon: "dangerous", title: "强制停止", desc: "立即 SIGKILL，可能丢失未保存数据" },
            { value: "remove", icon: "delete", title: "删除容器", desc: "移除容器，可选是否删除凭证卷" },
          ]}
        />

        {mode === "remove" && <Checkbox checked={removeHome} onChange={setRemoveHome} label="同时删除凭证卷（不可恢复）" desc="包含登录凭证、.claude.json、settings、todos 等容器私有数据" />}

        {needConfirm && (
          <Field label={<>请输入容器名 <span className="font-mono text-st-bad">{container}</span> 以确认</>} error={confirmName && !ok ? "名称不一致" : null}>
            <Input mono value={confirmName} invalid={!!confirmName && !ok} onChange={(e) => setConfirmName(e.target.value)} placeholder={container} autoComplete="off" />
          </Field>
        )}
      </div>
    </Modal>
  );
}
