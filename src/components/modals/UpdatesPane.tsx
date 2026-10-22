import { openUrl } from "@tauri-apps/plugin-opener";
import type { UpdateSettings, UpdateStatus } from "../../api/types";
import { errorText, isTauri } from "../../api/commands";
import { useUiStore } from "../../store/uiStore";
import { canDownloadUpdate, isUpdateBusy, useUpdateStore } from "../../store/updateStore";
import { Button, Callout, Icon, Section, Switch } from "../ui/controls";

const PHASE_LABEL: Record<UpdateStatus["phase"], string> = {
  idle: "当前已是最新版本",
  checking: "正在检查更新…",
  available: "发现新版本",
  downloading: "正在下载更新…",
  ready: "更新已下载，可以安装",
  installing: "正在安装更新，应用即将重启…",
  error: "更新失败",
};

function bytes(value: number): string {
  return `${(Math.max(0, value) / (1024 * 1024)).toFixed(1)} MB`;
}

function checkedTime(value: number): string {
  return new Date(value * 1000).toLocaleString("zh-CN");
}

function releaseDetailsUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && !url.port ? url.href : null;
  } catch {
    return null;
  }
}

export function UpdatesPane({ value, onChange, disabled = false }: {
  value: UpdateSettings;
  onChange: (value: UpdateSettings) => void;
  disabled?: boolean;
}) {
  const status = useUpdateStore((state) => state.status);
  const pending = useUpdateStore((state) => state.pending);
  const commandError = useUpdateStore((state) => state.commandError);
  const check = useUpdateStore((state) => state.check);
  const download = useUpdateStore((state) => state.download);
  const install = useUpdateStore((state) => state.install);
  const busy = Boolean(pending) || isUpdateBusy(status);
  const connected = isTauri();
  const error = commandError ?? status?.error;
  const installable = status?.installKind === "installer" || status?.installKind === "portable";
  const total = status?.totalBytes;
  const percent = total && total > 0 ? Math.min(100, Math.max(0, (status?.downloadedBytes ?? 0) / total * 100)) : null;
  const label = error ? "更新失败" : pending === "install" ? PHASE_LABEL.installing
    : !status ? "正在读取更新状态…" : status.phase === "idle" && !status.checkedAt ? "尚未检查更新" : PHASE_LABEL[status.phase];
  const releaseUrl = releaseDetailsUrl(status?.release?.url);
  return (
    <>
      <Section title="应用更新" icon="system_update">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1" role="status" aria-live="polite">
            <span className="font-ui text-headline-sm">当前版本 {status ? `v${status.currentVersion}` : "—"}</span>
            <span className={`flex items-center gap-1.5 font-ui text-body-md ${error ? "text-st-bad" : status?.phase === "ready" ? "text-st-ok" : "text-on-surface-variant"}`}>
              <Icon name={busy ? "progress_activity" : status?.phase === "ready" ? "check_circle" : error ? "error" : "info"} />
              {label}{status?.release && status.phase !== "idle" ? ` · v${status.release.version}` : ""}
            </span>
            {status?.checkedAt && <span className="font-ui text-body-sm text-outline">上次检查：{checkedTime(status.checkedAt)}</span>}
          </div>
          <Button icon={pending === "check" || status?.phase === "checking" ? "progress_activity" : "refresh"}
            disabled={disabled || busy || !connected} onClick={() => void check()}>
            {pending === "check" || status?.phase === "checking" ? "检查中…" : error ? "重新检查" : "检查更新"}
          </Button>
        </div>
        {status?.phase === "downloading" && (
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between font-ui text-body-sm text-on-surface-variant">
              <span>{bytes(status.downloadedBytes)}{total ? ` / ${bytes(total)}` : " 已下载"}</span>
              {percent !== null && <span>{Math.floor(percent)}%</span>}
            </div>
            <div role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={percent ?? undefined} className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
              <div className={`h-full rounded-full bg-accent transition-[width] ${percent === null ? "w-1/3 motion-safe:animate-pulse" : ""}`}
                style={percent !== null ? { width: `${percent}%` } : undefined} />
            </div>
          </div>
        )}
        {error && <Callout tone="danger">{error}</Callout>}
        {!connected ? <Callout>浏览器预览无法检查或安装更新，请在桌面应用中操作。</Callout>
          : status?.installKind === "development" ? <Callout>开发版本可手动检查更新。自动下载和安装请使用正式发行版。</Callout>
          : status?.installKind === "unsupported" ? <Callout tone="warning">当前安装方式不支持自动安装，请下载正式发行版。</Callout>
          : null}
        {(canDownloadUpdate(status) || status?.phase === "ready") && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {canDownloadUpdate(status) && <Button variant="primary" icon="download" disabled={disabled || busy || !connected}
                onClick={() => void download()}>{error ? "重试下载" : "下载更新"}</Button>}
              {status?.phase === "ready" && <Button variant="primary" icon="restart_alt" disabled={disabled || busy || !connected || !installable}
                onClick={() => void install()}>更新并重启</Button>}
            </div>
            {status?.phase === "ready" && <span className="font-ui text-body-sm text-on-surface-variant">
              更新会关闭并重启应用；打开的会话将在启动时恢复。
            </span>}
          </div>
        )}
      </Section>
      <Section title="自动更新" icon="autorenew">
        <span className="font-ui text-body-sm text-on-surface-variant">默认在启动时及每 6 小时检查 GitHub 最新发行版，自动下载并在退出应用时安装。下列偏好点击底部「保存」后生效。</span>
        <Switch label="自动检查更新" checked={value.autoCheck} disabled={disabled}
          onChange={(autoCheck) => onChange({ ...value, autoCheck })} />
        <Switch label="发现更新时自动下载" checked={value.autoDownload} disabled={disabled}
          onChange={(autoDownload) => onChange({ ...value, autoDownload })} />
        <Switch label="退出应用时自动安装已下载的更新" checked={value.installOnExit} disabled={disabled}
          onChange={(installOnExit) => onChange({ ...value, installOnExit })} />
      </Section>
      {status?.release && <Section title={`v${status.release.version} 更新说明`} icon="description">
        {status.release.publishedAt && <span className="font-ui text-body-sm text-outline">
          发布时间：{new Date(status.release.publishedAt).toLocaleString("zh-CN")}
        </span>}
        <div className="whitespace-pre-wrap break-words font-ui text-body-md text-on-surface-variant">
          {status.release.notes || "此版本未提供更新说明。"}
        </div>
        {releaseUrl && <a href={releaseUrl} target="_blank" rel="noopener noreferrer"
          className="self-start font-ui text-body-sm text-accent underline underline-offset-2"
          onClick={(event) => {
            if (!connected) return;
            event.preventDefault();
            void openUrl(releaseUrl).catch((error) => useUiStore.getState().toast("error", errorText(error)));
          }}>在 GitHub 查看发行版</a>}
      </Section>}
    </>
  );
}
