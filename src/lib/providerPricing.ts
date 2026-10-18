import type { Pricing } from "../api/types";
import bundledClaudePricing from "../data/claude-pricing.json";

export interface BuiltinModelPricing {
  id: string;
  name: string;
  aliases: string[];
  pricing: Pricing;
  longContext?: { inputTokensThreshold: number; pricing: Pricing };
  note?: string;
}

export const CLAUDE_PRICING_CATALOG: { checkedAt: string; sourceUrl: string; models: BuiltinModelPricing[] } = bundledClaudePricing;
export const BUILTIN_MODEL_PRICING = new Map(CLAUDE_PRICING_CATALOG.models.map((model) => [model.id, model]));

export const ZERO_PRICING: Pricing = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export const PRICE_FIELDS = [
  ["input", "输入"], ["output", "输出"], ["cacheRead", "缓存读取"], ["cacheWrite", "缓存写入"],
] as const;
export type PriceDraft = Record<keyof Pricing, string>;
export interface ModelPriceDraft { model: string; prices: PriceDraft; builtinId?: string }

/** 随安装包补齐已知模型；供应商已有报价（包括 0 和别名报价）优先。 */
export function mergeBuiltinModelPricing(pricing: Record<string, Pricing> = {}): Record<string, Pricing> {
  return Object.fromEntries([
    ...CLAUDE_PRICING_CATALOG.models.map((model) => [model.id, { ...model.pricing }]),
    ...Object.entries(pricing).map(([model, prices]) => [model, { ...prices }]),
  ]);
}

export function modelPriceDrafts(pricing?: Record<string, Pricing>): ModelPriceDraft[] {
  return Object.entries(mergeBuiltinModelPricing(pricing)).map(([model, prices]) => ({
    model,
    prices: priceDraft(prices),
    ...(BUILTIN_MODEL_PRICING.has(model) ? { builtinId: model } : {}),
  }));
}

export function priceDraft(pricing?: Pricing): PriceDraft {
  return Object.fromEntries(PRICE_FIELDS.map(([key]) => [key, pricing?.[key] === undefined ? "" : String(pricing[key])])) as PriceDraft;
}

/** 空值按 0 计费；拒绝负数和非有限数字，避免误存费用。 */
export function parsePriceDraft(draft: PriceDraft): Pricing {
  return Object.fromEntries(PRICE_FIELDS.map(([key, label]) => {
    const value = draft[key].trim() === "" ? 0 : Number(draft[key]);
    if (!Number.isFinite(value) || value < 0 || value > 1_000_000) throw new Error(`${label}单价须为 0 至 1,000,000 的数字`);
    return [key, value];
  })) as unknown as Pricing;
}

export function parseModelPrices(rows: ModelPriceDraft[]): Record<string, Pricing> {
  const entries: [string, Pricing][] = [];
  const names = new Set<string>();
  for (const row of rows) {
    const name = row.model.trim();
    if (!name) throw new Error("请填写模型定价中的模型 ID，或删除空行");
    if (names.has(name)) throw new Error(`模型「${name}」重复，请合并定价`);
    names.add(name);
    entries.push([name, parsePriceDraft(row.prices)]);
  }
  return Object.fromEntries(entries);
}
