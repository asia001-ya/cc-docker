import { useMemoryStore } from "../../store/memoryStore";
import { useUiStore } from "../../store/uiStore";
import { Icon } from "../ui/controls";

/** 内存管理入口；操作状态保存在 store，关闭面板后仍可重新查看。 */
export function MemoryReclaimButton() {
  const openModal = useUiStore((state) => state.openModal);
  const pending = useMemoryStore((state) => state.pending);
  const running = useMemoryStore((state) => state.analysis?.running ?? false);
  const busy = Boolean(pending) || running;

  return (
    <button
      type="button"
      aria-label="释放内存，打开内存管理"
      aria-busy={busy}
      title={busy ? "内存操作进行中，打开面板查看" : "分析电脑内存占用，选择进程或回收 WSL 缓存"}
      onClick={() => openModal({ kind: "memory" })}
      className="flex h-7 min-w-[88px] shrink-0 items-center justify-center gap-1 rounded px-2 font-ui text-label-md text-on-surface-variant transition-colors hover:bg-white/[0.08] hover:text-on-surface"
    >
      <Icon name={busy ? "progress_activity" : "memory"} size={16} />
      <span>{pending === "analysis" ? "分析中…" : busy ? "清理中…" : "释放内存"}</span>
    </button>
  );
}
