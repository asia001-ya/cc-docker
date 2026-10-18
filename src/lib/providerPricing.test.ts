import { describe, expect, it } from "vitest";
import { CLAUDE_PRICING_CATALOG, mergeBuiltinModelPricing, modelPriceDrafts, parseModelPrices, parsePriceDraft, priceDraft, ZERO_PRICING } from "./providerPricing";

describe("供应商价格录入", () => {
  it("未填的默认价格按0计算", () => {
    expect(parsePriceDraft(priceDraft())).toEqual(ZERO_PRICING);
    expect(parseModelPrices([])).toEqual({});
  });
  it("新供应商和缺少报价的旧供应商自动补齐内置模型价格", () => {
    const empty = mergeBuiltinModelPricing();
    expect(Object.keys(empty)).toHaveLength(CLAUDE_PRICING_CATALOG.models.length);
    for (const model of CLAUDE_PRICING_CATALOG.models) expect(empty[model.id]).toEqual(model.pricing);
    const partial = { [CLAUDE_PRICING_CATALOG.models[0].id]: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } };
    const merged = mergeBuiltinModelPricing(partial);
    expect(Object.keys(merged)).toHaveLength(CLAUDE_PRICING_CATALOG.models.length);
    expect(merged[CLAUDE_PRICING_CATALOG.models[0].id]).toEqual(partial[CLAUDE_PRICING_CATALOG.models[0].id]);
  });
  it("保留自定义模型、别名和显式零报价，且不修改供应商或内置数据", () => {
    const model = CLAUDE_PRICING_CATALOG.models.find((entry) => entry.aliases.length > 0)!;
    const alias = model.aliases[0];
    const custom = { input: 1.2, output: 6, cacheRead: 0.12, cacheWrite: 1.5 };
    const saved = { [model.id]: { ...ZERO_PRICING }, [alias]: custom, "vendor-custom": custom };
    const original = structuredClone(saved);
    const catalog = structuredClone(CLAUDE_PRICING_CATALOG);
    const merged = mergeBuiltinModelPricing(saved);
    expect(merged).toMatchObject(saved);
    expect(mergeBuiltinModelPricing(merged)).toEqual(merged);
    merged[model.id].input = 99;
    merged[alias].output = 99;
    expect(saved).toEqual(original);
    expect(CLAUDE_PRICING_CATALOG).toEqual(catalog);
  });
  it("编辑草稿补齐缺项、识别内置行，往返保存保留自定义零价格", () => {
    const model = CLAUDE_PRICING_CATALOG.models[0];
    const rows = modelPriceDrafts({ [model.id]: { ...ZERO_PRICING }, "custom-model": { ...ZERO_PRICING } });
    expect(rows.find((row) => row.model === model.id)).toEqual({ model: model.id, builtinId: model.id, prices: priceDraft(ZERO_PRICING) });
    expect(rows.find((row) => row.model === "custom-model")?.builtinId).toBeUndefined();
    expect(priceDraft(ZERO_PRICING).input).toBe("0");
    expect(parseModelPrices(rows)).toEqual(mergeBuiltinModelPricing({ [model.id]: ZERO_PRICING, "custom-model": ZERO_PRICING }));
  });
  it("保留小数，支持按模型独立报价", () => {
    const prices = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    expect(parsePriceDraft(priceDraft(prices))).toEqual(prices);
    expect(parseModelPrices([{ model: " sonnet ", prices: priceDraft(prices) }])).toEqual({ sonnet: prices });
  });
  it("拒绝负数、溢出和重复模型，避免静默覆盖", () => {
    for (const value of ["-1", "Infinity", "NaN", "1000001"]) expect(() => parsePriceDraft({ ...priceDraft(), input: value })).toThrow();
    expect(() => parseModelPrices([{ model: "", prices: priceDraft() }])).toThrow();
    expect(() => parseModelPrices([{ model: "a", prices: priceDraft() }, { model: " a ", prices: priceDraft() }])).toThrow();
  });
});
