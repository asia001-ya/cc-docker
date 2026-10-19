import { describe, expect, it } from "vitest";
import cases from "../../docker/tests/fixtures/lan-cidrs.json";
import { DEFAULT_LAN_CIDRS, MAX_LAN_CIDRS, lanCidrsError, normalizeLanCidrs } from "./proxyLan";
import { EMPTY_PROXY_BINDING, patchProxyBinding, proxyBindingError } from "./proxyBinding";

describe("可编辑内网直连范围", () => {
  it("三个执行边界共用同一组地址边界样例", () => {
    for (const { input, expected } of cases.valid) expect(normalizeLanCidrs(input)).toEqual(expected);
    for (const input of cases.invalid) expect(() => normalizeLanCidrs(input)).toThrow();
  });
  it("空列表和过长列表不能开启直连", () => {
    expect(lanCidrsError([])).toContain("至少");
    expect(lanCidrsError(Array(MAX_LAN_CIDRS + 1).fill("10.0.0.1"))).toContain("最多");
    expect(lanCidrsError(DEFAULT_LAN_CIDRS)).toBeNull();
  });
  it("切换节点或关闭再打开直连都保留用户编辑的列表", () => {
    const binding = { ...EMPTY_PROXY_BINDING, nodeId: "old", allowLan: true, lanCidrs: ["192.168.1.20"] };
    const changed = patchProxyBinding(binding, { nodeId: "new", allowLan: false });
    expect(changed.lanCidrs).toEqual(binding.lanCidrs);
    expect(patchProxyBinding(changed, { allowLan: true }).lanCidrs).toEqual(binding.lanCidrs);
  });
  it("无效直连范围阻止应用，但不阻止关闭代理的救援操作", () => {
    const nodes = [{ id: "n", name: "node", kind: "socks5" as const, engine: "mihomo" as const, display: "example.test", hasSecret: true }];
    const binding = { ...EMPTY_PROXY_BINDING, enabled: true, nodeId: "n", allowLan: true, lanCidrs: ["0.0.0.0/0"] };
    expect(proxyBindingError(binding, nodes)).toContain("公网");
    expect(proxyBindingError({ ...binding, enabled: false }, nodes)).toBeNull();
    expect(proxyBindingError({ ...binding, allowLan: false }, nodes)).toBeNull();
    expect(proxyBindingError({ ...binding, lanCidrs: ["10.20.0.0/16"] }, nodes)).toBeNull();
  });
});
