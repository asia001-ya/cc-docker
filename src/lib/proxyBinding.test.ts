import { describe, expect, it } from "vitest";
import { EMPTY_PROXY_BINDING, patchProxyBinding, proxyBindingEngine, proxyBindingError } from "./proxyBinding";
import type { ProxyNodeView } from "../api/types";

const nodes: ProxyNodeView[] = [
  { id: "sub", name: "订阅", kind: "subscription", engine: "xray", display: "example.test", hasSecret: true },
  { id: "relay", name: "中转", kind: "vless", engine: "mihomo", display: "example.test", hasSecret: true },
  { id: "exit", name: "出口", kind: "socks5", engine: "mihomo", display: "example.test", hasSecret: true },
];
describe("共用代理配置", () => {
  it("内核由主节点决定，未选或节点缺失时为 Mihomo", () => {
    expect(proxyBindingEngine(EMPTY_PROXY_BINDING, nodes)).toBe("mihomo");
    expect(proxyBindingEngine({ ...EMPTY_PROXY_BINDING, nodeId: "sub", staticId: "relay", exitId: "exit" }, nodes)).toBe("xray");
    expect(proxyBindingEngine({ ...EMPTY_PROXY_BINDING, nodeId: "relay" }, nodes)).toBe("mihomo");
    expect(proxyBindingEngine({ ...EMPTY_PROXY_BINDING, nodeId: "missing" }, nodes)).toBe("mihomo");
  });
  it("关闭可不选节点，开启必须选有效节点和凭据", () => {
    expect(proxyBindingError(EMPTY_PROXY_BINDING, [])).toBeNull();
    const binding = { ...EMPTY_PROXY_BINDING, enabled: true };
    expect(proxyBindingError(binding, nodes)).toContain("必须选择");
    expect(proxyBindingError({ ...binding, nodeId: "missing" }, nodes)).toContain("不存在");
    expect(proxyBindingError({ ...binding, nodeId: "sub" }, nodes)).toBeNull();
    expect(proxyBindingError({ ...binding, nodeId: "sub" }, nodes.map((n) => ({ ...n, hasSecret: false })))).toContain("缺少地址");
  });
  it("静态中转与出口限制类型且不能重复主节点", () => {
    const binding = { ...EMPTY_PROXY_BINDING, enabled: true, nodeId: "sub", staticId: "relay", exitId: "exit" };
    expect(proxyBindingError(binding, nodes)).toBeNull();
    expect(proxyBindingError({ ...binding, staticId: "exit" }, nodes)).toContain("vless");
    expect(proxyBindingError({ ...binding, exitId: "relay" }, nodes)).toContain("SOCKS5");
    expect(proxyBindingError({ ...binding, nodeId: "exit" }, nodes)).toContain("不同于主节点");
    expect(proxyBindingError(binding, nodes.filter((n) => n.id !== "relay"))).toContain("重新选择");
  });
  it("切换主节点清理重复跳点与订阅选中项，其余设置保留", () => {
    const binding = { ...EMPTY_PROXY_BINDING, enabled: true, nodeId: "sub", staticId: "relay", exitId: "exit", selected: "香港", allowLan: true };
    expect(patchProxyBinding(binding, { nodeId: "relay" })).toEqual({ ...binding, nodeId: "relay", staticId: null, selected: null });
    expect(patchProxyBinding(binding, { nodeId: "exit" })).toEqual({ ...binding, nodeId: "exit", exitId: null, selected: null });
    expect(patchProxyBinding(binding, { nodeId: "sub" })).toEqual(binding);
  });
});
