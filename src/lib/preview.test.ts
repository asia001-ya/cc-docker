/**
 * 预览窗格单元测试：终端链接转换、分屏树与 tabStore 中的预览行为。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { PortLink, SessionRecord } from "../api/types";
import { useTabStore } from "../store/tabStore";
import { isPreview, leaf, leaves, neighbor, split } from "./splitTree";
import { normalizePreviewUrl, resolveContainerLink } from "./preview";

/**
 * 构造端口链接（与后端 ports::build_links 一致：只含正在监听的端口）。
 * @param containerPort 容器端口
 * @param hostPort 宿主端口；null 表示未映射
 * @param loopbackOnly 服务是否只监听 127.0.0.1
 * @returns 端口链接
 */
function port(containerPort: number, hostPort: number | null, loopbackOnly = false): PortLink {
  const ok = hostPort !== null && !loopbackOnly;
  const hint = hostPort === null ? "未映射到宿主机" : loopbackOnly ? "服务仅监听 127.0.0.1" : null;
  return { containerPort, hostPort, url: ok ? `http://localhost:${hostPort}` : null, process: "node", hint };
}

const PORTS = [port(3000, 3010), port(5173, 5183), port(9000, null), port(8080, 8090, true)];

describe("resolveContainerLink", () => {
  it("本机地址按端口映射换成宿主地址，保留路径、查询与片段", () => {
    expect(resolveContainerLink("http://localhost:3000/a/b?x=1#h", PORTS)).toEqual({ kind: "mapped", url: "http://127.0.0.1:3010/a/b?x=1#h" });
    expect(resolveContainerLink("http://127.0.0.1:5173/", PORTS)).toEqual({ kind: "mapped", url: "http://127.0.0.1:5183/" });
    expect(resolveContainerLink("http://0.0.0.0:3000", PORTS)).toEqual({ kind: "mapped", url: "http://127.0.0.1:3010/" });
    expect(resolveContainerLink("http://[::1]:3000/x", PORTS)).toEqual({ kind: "mapped", url: "http://127.0.0.1:3010/x" });
  });

  it("不可访问时给出原因：未映射、仅监听回环、未在监听", () => {
    expect(resolveContainerLink("http://localhost:9000/", PORTS)).toEqual({ kind: "unavailable", port: 9000, reason: "未映射到宿主机" });
    expect(resolveContainerLink("http://localhost:8080/", PORTS)).toEqual({ kind: "unavailable", port: 8080, reason: "服务仅监听 127.0.0.1" });
    expect(resolveContainerLink("http://localhost:4321/", PORTS)).toMatchObject({ kind: "unavailable", port: 4321 });
    expect(resolveContainerLink("http://localhost/", PORTS)).toMatchObject({ kind: "unavailable", port: 80 });
  });

  it("外部链接与非 http 链接原样交给系统浏览器", () => {
    expect(resolveContainerLink("https://github.com/x", PORTS)).toEqual({ kind: "external" });
    expect(resolveContainerLink("https://claude.ai/oauth/authorize?code=1", PORTS)).toEqual({ kind: "external" });
    expect(resolveContainerLink("not a url", PORTS)).toEqual({ kind: "external" });
  });
});

describe("normalizePreviewUrl", () => {
  it("补全协议、只接受 http(s)", () => {
    expect(normalizePreviewUrl("127.0.0.1:3010/x")).toBe("http://127.0.0.1:3010/x");
    expect(normalizePreviewUrl(" https://a.example.com ")).toBe("https://a.example.com/");
    expect(normalizePreviewUrl("javascript:alert(1)")).toBeNull();
    expect(normalizePreviewUrl("file:///etc/passwd")).toBeNull();
    expect(normalizePreviewUrl("")).toBeNull();
  });
});

describe("splitTree 预览叶子", () => {
  it("焦点循环跳过预览叶子", () => {
    let t = split(leaf("a"), "a", "pv:1", "row");
    t = split(t, "pv:1", "b", "column");
    expect(isPreview("pv:1")).toBe(true);
    expect(isPreview("a")).toBe(false);
    expect(leaves(t).map((l) => l.sessionId)).toEqual(["a", "pv:1", "b"]);
    expect(neighbor(t, "a", 1)).toBe("b");
    expect(neighbor(t, "b", 1)).toBe("a");
    expect(neighbor(t, "a", -1)).toBe("b");
  });
});

/**
 * 构造会话记录。
 * @param id 会话 ID
 * @param container 容器名
 * @returns 会话记录
 */
function rec(id: string, container: string): SessionRecord {
  return { id, container } as SessionRecord;
}

describe("tabStore 预览", () => {
  beforeEach(() => useTabStore.setState({ tabs: [], activeTabId: null, sessions: {}, exited: {}, migrated: {}, previews: {} }));

  it("在聚焦终端右侧打开预览，不改变当前会话；同容器复用", () => {
    const st = useTabStore.getState();
    st.openTab(rec("s1", "c1"));
    const id = useTabStore.getState().openPreview("c1", "http://127.0.0.1:3010/");
    expect(id).toMatch(/^pv:/);
    let s = useTabStore.getState();
    const tab = s.tabs[0];
    expect(leaves(tab.root).map((l) => l.sessionId)).toEqual(["s1", id]);
    expect(tab.root.type === "split" && tab.root.direction).toBe("row");
    expect(tab.activeSessionId).toBe("s1");
    expect(s.previews[id!]).toMatchObject({ container: "c1", url: "http://127.0.0.1:3010/" });

    const again = s.openPreview("c1", "http://127.0.0.1:5183/");
    s = useTabStore.getState();
    expect(again).toBe(id);
    expect(leaves(s.tabs[0].root)).toHaveLength(2);
    expect(s.previews[id!].url).toBe("http://127.0.0.1:5183/");
  });

  it("没有标签页时无法打开预览", () => {
    expect(useTabStore.getState().openPreview("c1", "http://127.0.0.1:3010/")).toBeNull();
  });

  it("刷新递增 nonce、导航改地址、关闭移除叶子与记录", () => {
    const st = useTabStore.getState();
    st.openTab(rec("s1", "c1"));
    const id = useTabStore.getState().openPreview("c1", "http://127.0.0.1:3010/")!;
    const n0 = useTabStore.getState().previews[id].nonce;
    useTabStore.getState().reloadPreview(id);
    expect(useTabStore.getState().previews[id].nonce).toBe(n0 + 1);
    useTabStore.getState().navigatePreview(id, "http://127.0.0.1:3010/about");
    expect(useTabStore.getState().previews[id].url).toBe("http://127.0.0.1:3010/about");
    useTabStore.getState().closePreview(id);
    const s = useTabStore.getState();
    expect(leaves(s.tabs[0].root).map((l) => l.sessionId)).toEqual(["s1"]);
    expect(s.previews[id]).toBeUndefined();
  });

  it("终端全部移除后，剩余预览随 Tab 一起清理", () => {
    const st = useTabStore.getState();
    st.openTab(rec("s1", "c1"));
    const id = useTabStore.getState().openPreview("c1", "http://127.0.0.1:3010/")!;
    useTabStore.getState().removeSession("s1");
    const s = useTabStore.getState();
    expect(s.tabs).toHaveLength(0);
    expect(s.activeTabId).toBeNull();
    expect(s.previews[id]).toBeUndefined();
  });

  it("移除其中一个终端时保留预览，聚焦落到剩余终端", () => {
    const st = useTabStore.getState();
    st.openTab(rec("s1", "c1"));
    useTabStore.getState().splitActive(rec("s2", "c1"), "column");
    const id = useTabStore.getState().openPreview("c1", "http://127.0.0.1:3010/")!;
    useTabStore.getState().removeSession("s2");
    const s = useTabStore.getState();
    expect(leaves(s.tabs[0].root).map((l) => l.sessionId)).toEqual(["s1", id]);
    expect(s.tabs[0].activeSessionId).toBe("s1");
  });
});
