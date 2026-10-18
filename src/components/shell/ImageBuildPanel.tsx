/**
 * 标准镜像构建面板：在应用内构建默认镜像并实时展示输出。
 * 首次启动引导与新建容器弹框共用；构建在后端独立任务中进行，面板重新挂载后从后端恢复进度与日志。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageStatus } from "../../api/types";
import { errorText, imageBuild, imageStatus, isTauri, onImageBuildDone, onImageBuildLine } from "../../api/commands";
import { appendBuildLog, buildProgress } from "../../lib/imageBuild";
import { Button, Callout } from "../ui/controls";

/**
 * 镜像构建面板。
 * @param props onReady 镜像已存在或构建成功时回调（可能重复调用，调用方需幂等）
 * @returns JSX
 */
export function ImageBuildPanel({ onReady }: { onReady?: () => void }) {
  const [status, setStatus] = useState<ImageStatus | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  /**
   * 从后端读取镜像状态与最近的构建输出。
   * @returns Promise
   */
  const refresh = useCallback(async () => {
    try {
      const s = await imageStatus();
      setStatus(s);
      setBuilding(s.building);
      setLog(s.log);
      setError(s.error);
      if (s.exists && !s.building) onReadyRef.current?.();
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void refresh();
    const unsubs = [onImageBuildLine((line) => setLog((l) => appendBuildLog(l, line))), onImageBuildDone(() => void refresh())];
    return () => {
      for (const u of unsubs) void u.then((f) => f());
    };
  }, [refresh]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  /**
   * 开始构建；结束后以后端状态为准刷新。
   * @returns Promise
   */
  const start = async () => {
    setError(null);
    setLog([]);
    setBuilding(true);
    try {
      await imageBuild();
    } catch (e) {
      setError(errorText(e));
    } finally {
      await refresh();
    }
  };

  if (!isTauri()) return <Callout tone="info">演示模式未连接 Docker，无法构建镜像。</Callout>;
  const progress = buildProgress(log);
  return (
    <div className="flex w-full min-w-0 flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <Button variant="primary" icon={building ? "progress_activity" : "build"} aria-busy={building} disabled={building || !status} onClick={() => void start()}>
          {building ? "构建中…" : error ? "重新构建" : "构建镜像"}
        </Button>
        <span className="min-w-0 truncate font-mono text-code-sm text-on-surface-variant">{status?.image ?? "检测中…"}</span>
        {progress && <span className="ml-auto shrink-0 font-ui text-label-sm text-on-surface-variant">步骤 {progress.step}/{progress.total}</span>}
      </div>
      {building && (
        <div
          className="h-1 overflow-hidden rounded bg-white/10"
          role="progressbar"
          aria-label="镜像构建进度"
          aria-valuemin={0}
          aria-valuemax={progress?.total}
          aria-valuenow={progress?.step}
        >
          {progress ? (
            <div className="relative h-full overflow-hidden rounded bg-accent transition-[width]" style={{ width: `${(progress.step / progress.total) * 100}%` }}>
              <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-transparent via-white/60 to-transparent motion-safe:animate-[buildProgressShimmer_1.6s_linear_infinite]" />
            </div>
          ) : (
            <div aria-hidden className="h-full w-1/3 rounded bg-accent motion-safe:animate-[buildProgressSweep_1.6s_ease-in-out_infinite]" />
          )}
        </div>
      )}
      {error && <Callout tone="danger">{error}</Callout>}
      {(building || log.length > 0) && (
        <pre ref={logRef} className="max-h-56 select-text overflow-auto whitespace-pre-wrap break-all rounded border border-white/10 bg-black/30 p-2 text-left font-mono text-code-sm text-on-surface-variant">
          {log.length ? log.join("\n") : "正在发送构建上下文…"}
        </pre>
      )}
    </div>
  );
}
