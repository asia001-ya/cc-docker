import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ContainerDirectories } from "../../api/types";
import { containerDirectories, errorText, isTauri } from "../../api/commands";
import { Modal } from "../ui/Modal";
import { Button, Callout, Icon, Input } from "../ui/controls";

export function ContainerDirectoryPicker({ container, initialPath, shortcuts, onSelect, onClose }: {
  container: string; initialPath: string; shortcuts: string[]; onSelect: (path: string) => void; onClose: () => void;
}) {
  const [location, setLocation] = useState(initialPath || "/workspace");
  const [listing, setListing] = useState<ContainerDirectories | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(async (path: string) => {
    const request = ++sequence.current;
    setLocation(path);
    setLoading(true);
    setError(null);
    try {
      if (!isTauri()) throw new Error("目录浏览需要连接运行中的容器；演示模式可在表单中手动输入路径");
      const next = await containerDirectories(container, path);
      if (sequence.current !== request) return;
      setListing(next);
      setLocation(next.path);
    } catch (cause) {
      if (sequence.current === request) setError(errorText(cause));
    } finally {
      if (sequence.current === request) setLoading(false);
    }
  }, [container]);
  useEffect(() => {
    void load(initialPath || "/workspace");
    return () => { sequence.current += 1; };
  }, [initialPath, load]);
  const canSelect = !!listing && !loading && !error && location === listing.path;
  const choose = () => { if (canSelect) onSelect(listing.path); };
  return createPortal(<Modal title="选择容器工作目录" icon="folder_open" badge={container} width={620}
    onClose={onClose} onSubmit={choose}
    footerLeft={<span className="truncate font-mono text-code-sm text-outline">{listing?.path}</span>}
    footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!canSelect} onClick={choose}>选择此目录</Button></>}
  >
    <div className="flex flex-col gap-3">
      <p className="font-ui text-body-sm text-on-surface-variant">浏览目标容器中的目录，选择后作为新会话的初始工作目录。</p>
      <div className="flex gap-2">
        <Button icon="arrow_upward" title="上级目录" disabled={loading || !listing || listing.path === listing.parent} onClick={() => listing && void load(listing.parent)} />
        <Input mono className="min-w-0 flex-1" data-autofocus aria-label="容器目录路径" value={location} onChange={(event) => setLocation(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void load(location); } }} />
        <Button disabled={loading} onClick={() => void load(location)}>前往</Button>
      </div>
      <div className="flex flex-wrap gap-1">
        {[...new Set([...shortcuts, "/workspace", "/home/node", "/"])].map((path) =>
          <Button key={path} variant="subtle" className="max-w-full truncate !text-body-sm" onClick={() => void load(path)}>{path}</Button>,
        )}
      </div>
      {error && <div role="alert"><Callout tone="danger">{error}</Callout></div>}
      <div className="h-64 overflow-y-auto rounded-lg border border-white/10 p-1" aria-busy={loading}>
        {loading ? <p className="p-3 font-ui text-body-sm text-outline">正在读取目录…</p> : !error && listing && <>
          {listing.directories.length === 0 && <p className="p-3 font-ui text-body-sm text-outline">没有子目录，可选择当前目录</p>}
          {listing.directories.map((directory) => <button key={directory.path} type="button"
            className="flex w-full items-center gap-2 rounded px-3 py-2 text-left font-ui text-body-md text-on-surface hover:bg-white/10"
            onClick={() => void load(directory.path)}>
            <Icon name="folder" size={18} className="text-accent" /><span className="break-all">{directory.name}</span>
          </button>)}
          {listing.truncated && <p className="p-2 font-ui text-body-sm text-outline">目录较多，仅显示部分；可在上方输入完整路径。</p>}
        </>}
      </div>
    </div>
  </Modal>, document.body);
}
