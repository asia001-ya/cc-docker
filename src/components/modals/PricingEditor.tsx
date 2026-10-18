import { BUILTIN_MODEL_PRICING, CLAUDE_PRICING_CATALOG, PRICE_FIELDS, priceDraft, type ModelPriceDraft, type PriceDraft } from "../../lib/providerPricing";
import { openExternal } from "../terminal/xtermPool";
import { Button, Field, Input, Section } from "../ui/controls";

function PriceInputs({ value, onChange, prefix }: { value: PriceDraft; onChange: (v: PriceDraft) => void; prefix: string }) {
  return <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
    {PRICE_FIELDS.map(([key, label]) => <Field key={key} label={`${label}单价`}>
      <Input type="number" min={0} max={1_000_000} step="any" aria-label={`${prefix}${label}单价`} value={value[key]} placeholder="0" onChange={(e) => onChange({ ...value, [key]: e.target.value })} />
    </Field>)}
  </div>;
}

export function PricingEditor({ pricing, onPricing, models, onModels }: {
  pricing: PriceDraft; onPricing: (v: PriceDraft) => void;
  models: ModelPriceDraft[]; onModels: (v: ModelPriceDraft[]) => void;
}) {
  const builtinRows = models.map((row, index) => ({ row, index, builtin: row.builtinId ? BUILTIN_MODEL_PRICING.get(row.builtinId) : undefined })).filter(({ builtin }) => builtin);
  const customRows = models.map((row, index) => ({ row, index })).filter(({ row }) => !row.builtinId);
  const updatePrices = (index: number, prices: PriceDraft) => onModels(models.map((row, i) => i === index ? { ...row, prices } : row));
  return <Section title="用量定价" icon="payments">
    <p className="font-ui text-body-sm text-on-surface-variant">单位：美元 / 百万 token。留空按 0 计算，授权模式费用为 0。统计为估算成本，以供应商账单为准。</p>
    <div className="rounded-lg border border-accent/20 bg-accent/[0.05] p-3 font-ui text-body-sm text-on-surface-variant">
      <p>已随工具内置 Claude 官方参考价，新安装和新增供应商自动补齐；已有供应商报价保留，可按实际账单修改。</p>
      <p className="mt-1">
        <a href={CLAUDE_PRICING_CATALOG.sourceUrl} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2" onClick={(e) => { e.preventDefault(); openExternal(CLAUDE_PRICING_CATALOG.sourceUrl); }}>Anthropic 官方定价</a>
        {` · 核对日期 ${CLAUDE_PRICING_CATALOG.checkedAt}`}
      </p>
      <p className="mt-1">按标准 API 价格估算，缓存写入按 5 分钟计价；批处理、Fast、1 小时缓存和地区差价未单独计入。</p>
    </div>
    <PriceInputs value={pricing} onChange={onPricing} prefix="默认" />
    <p className="font-ui text-body-sm text-outline">默认价格用于未收录的模型。保存后，统计按当前定价重算已有请求的估算费用，无需重启容器或 Claude。请求所属供应商与原始用量记录保留。</p>
    <details className="rounded-lg border border-white/10 bg-black/10">
      <summary className="cursor-pointer px-3 py-2 font-ui text-body-md text-on-surface">内置 Claude 模型定价（{builtinRows.length} 项）</summary>
      <div className="flex max-h-96 flex-col gap-2 overflow-y-auto px-3 pb-3">
        <p className="font-ui text-body-sm text-outline">展开模型可修改或恢复官方价。内置条目会自动补齐；需按免费计算时将四项设为 0。已收录别名跟随对应模型价格，单独填写的别名报价优先。</p>
        {builtinRows.map(({ row, index, builtin }) => builtin && <details key={row.builtinId} className="rounded border border-white/10 bg-white/[0.02]">
          <summary className="cursor-pointer px-3 py-2 font-ui text-body-md text-on-surface">
            {builtin.name}
            <span className="ml-2 text-body-sm text-on-surface-variant">输入 ${row.prices.input || "0"} · 输出 ${row.prices.output || "0"}</span>
          </summary>
          <div className="flex flex-col gap-2 px-3 pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="break-all font-mono text-code-sm text-on-surface-variant">{row.model}</span>
              <Button variant="subtle" icon="restart_alt" title={`恢复 ${builtin.name} 官方定价`} onClick={() => updatePrices(index, priceDraft(builtin.pricing))}>恢复官方价</Button>
            </div>
            <PriceInputs value={row.prices} prefix={`${builtin.name} `} onChange={(prices) => updatePrices(index, prices)} />
            {builtin.aliases.length > 0 && <p className="break-all font-ui text-body-sm text-outline">适用别名：{builtin.aliases.join("、")}</p>}
            {builtin.longContext && <p className="font-ui text-body-sm text-on-surface-variant">
              四项基价均与官方价相同时，请求输入（含缓存）超过 {builtin.longContext.inputTokensThreshold.toLocaleString("zh-CN")} token，整次请求自动改用长上下文价：
              {PRICE_FIELDS.map(([key, label]) => `${label} $${builtin.longContext!.pricing[key]}`).join(" · ")}。
              任一基价改为其他报价后按所填固定单价计算。
            </p>}
            {builtin.note && <p className="font-ui text-body-sm text-outline">{builtin.note}</p>}
          </div>
        </details>)}
      </div>
    </details>
    {customRows.map(({ row, index }) => <div key={index} className="flex flex-col gap-2 rounded-lg border border-white/10 bg-black/10 p-3">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1"><Field label="模型 ID（精确匹配）">
          <Input mono aria-label={`定价模型 ${index + 1}`} placeholder="claude-sonnet-4-6" value={row.model} onChange={(e) => onModels(models.map((v, i) => i === index ? { ...v, model: e.target.value } : v))} />
        </Field></div>
        <Button variant="subtle" icon="delete" title={`删除模型定价 ${index + 1}`} onClick={() => onModels(models.filter((_, i) => i !== index))}>删除</Button>
      </div>
      <PriceInputs value={row.prices} prefix={`模型 ${index + 1} `} onChange={(prices) => updatePrices(index, prices)} />
    </div>)}
    <Button variant="subtle" icon="add" className="self-start" onClick={() => onModels([...models, { model: "", prices: priceDraft() }])}>添加自定义模型定价</Button>
  </Section>;
}
