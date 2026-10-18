/**
 * 弹框 7：全局与终端设置。
 * 分页：外观（字体 / 字号 / 行高 / 配色 / 光标 / WebGL + 实时预览）、Docker 连接、额度、API 供应商、代理节点、快捷键。
 */
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { ProviderProfile, ProviderView, Settings, WallpaperSettings } from "../../api/types";
import { dockerTest, errorText, isTauri, providerDelete, providerList, providerSave, settingsSet } from "../../api/commands";
import { useUiStore } from "../../store/uiStore";
import { DEMO_PROVIDERS } from "../../lib/demo";
import { buildShortcuts } from "../../lib/shortcuts";
import { FONTS, THEMES, truecolorBand } from "../../lib/themes";
import { applySettings, termOptions } from "../terminal/xtermPool";
import { Modal } from "../ui/Modal";
import { ProxyNodesPane } from "./ProxyNodesPane";
import { WallpaperPane } from "./WallpaperPane";
import { PricingEditor } from "./PricingEditor";
import { mergeBuiltinModelPricing, modelPriceDrafts, parseModelPrices, parsePriceDraft, priceDraft, ZERO_PRICING, type ModelPriceDraft } from "../../lib/providerPricing";
import { discardWallpaper } from "../../lib/wallpaper";
import { Button, Callout, Field, Icon, Input, Kbd, Section, Select, Switch } from "../ui/controls";

type TabId = "appearance" | "wallpaper" | "docker" | "quota" | "providers" | "proxy" | "shortcuts";

/** 自带增删改、不走底部"保存"的分页 */
const SELF_MANAGED_TABS: TabId[] = ["providers", "proxy"];

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: "appearance", label: "终端外观", icon: "palette" },
  { id: "wallpaper", label: "壁纸与玻璃", icon: "wallpaper" },
  { id: "docker", label: "Docker 引擎", icon: "deployed_code" },
  { id: "quota", label: "额度与切换", icon: "speed" },
  { id: "providers", label: "API 供应商", icon: "api" },
  { id: "proxy", label: "代理节点", icon: "vpn_lock" },
  { id: "shortcuts", label: "快捷键", icon: "keyboard" },
];

/**
 * 终端实时预览。
 * @param props settings 当前设置
 * @returns JSX
 */
function Preview({ settings }: { settings: Settings }) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  useEffect(() => {
    if (!box.current) return;
    const t = new Terminal({ ...termOptions(settings.terminal, null), disableStdin: true, scrollback: 0 });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(box.current);
    term.current = t;
    fit.current = f;
    return () => t.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const t = term.current;
    if (!t) return;
    const o = termOptions(settings.terminal, null);
    t.options.fontFamily = o.fontFamily;
    t.options.fontSize = o.fontSize;
    t.options.lineHeight = o.lineHeight;
    t.options.theme = o.theme;
    t.options.cursorStyle = o.cursorStyle;
    t.options.cursorBlink = o.cursorBlink;
    requestAnimationFrame(() => {
      fit.current?.fit();
      const c = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
      t.reset();
      t.write(
        [
          `${c(86, 182, 194)}node@claude-dev-01${"\x1b[0m"}:${c(97, 175, 239)}~/app${"\x1b[0m"} ${c(198, 120, 221)}(main)${"\x1b[0m"} $ git log --oneline -3`,
          `\x1b[33ma1b2c3d\x1b[0m \x1b[1;36m(HEAD -> main)\x1b[0m feat: 新增额度热切换 => 完成`,
          `\x1b[33m9f8e7d6\x1b[0m fix: 修复 UTF-8 截断 != 乱码 === 解决`,
          `\x1b[31m红\x1b[32m绿\x1b[33m黄\x1b[34m蓝\x1b[35m紫\x1b[36m青\x1b[0m \x1b[91m亮红\x1b[92m亮绿\x1b[93m亮黄\x1b[94m亮蓝\x1b[95m亮紫\x1b[96m亮青\x1b[0m \x1b[1m粗体\x1b[0m \x1b[3m斜体\x1b[0m \x1b[4m下划线\x1b[0m`,
          truecolorBand(Math.max(20, t.cols - 2)),
          "$ ",
        ].join("\r\n"),
      );
    });
  }, [settings.terminal]);
  return <div ref={box} className="h-[180px] w-full overflow-hidden rounded-lg border border-white/[0.08] p-1.5" style={{ background: THEMES.find((x) => x.id === settings.terminal.theme)?.theme.background }} />;
}

/**
 * 供应商管理页。
 * @returns JSX
 */
function ProvidersPane() {
  const toast = useUiStore((s) => s.toast);
  const [list, setList] = useState<ProviderView[]>([]);
  const [edit, setEdit] = useState<ProviderProfile | null>(null);
  const [token, setToken] = useState("");
  const [extraText, setExtraText] = useState("");
  const [pricing, setPricing] = useState(() => priceDraft());
  const [modelPrices, setModelPrices] = useState<ModelPriceDraft[]>([]);
  const [saving, setSaving] = useState(false);

  /**
   * 刷新列表。
   * @returns 无
   */
  const reload = () => {
    if (!isTauri()) return setList(DEMO_PROVIDERS);
    providerList().then((providers) => setList(providers.map((provider) => ({ ...provider, modelPricing: mergeBuiltinModelPricing(provider.modelPricing) })))).catch((e) => toast("error", errorText(e)));
  };
  useEffect(reload, [toast]);

  /**
   * 保存当前编辑项。
   * @returns Promise
   */
  const save = async () => {
    if (!edit || saving) return;
    const extraEnv: Record<string, string> = {};
    for (const line of extraText.split(/\r?\n/)) {
      const i = line.indexOf("=");
      if (i > 0) extraEnv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    try {
      const profile = { ...edit, extraEnv, pricing: parsePriceDraft(pricing), modelPricing: mergeBuiltinModelPricing(parseModelPrices(modelPrices)) };
      if (!isTauri()) return toast("info", "演示模式：校验通过，未保存到后端");
      setSaving(true);
      await providerSave(profile, token || null);
      toast("success", `供应商「${edit.name}」已保存${token ? "，Token 已写入 Windows 凭据管理器" : ""}`);
      setEdit(null);
      setToken("");
      reload();
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setSaving(false);
    }
  };

  /**
   * 删除供应商。
   * @param id 供应商 ID
   * @returns Promise
   */
  const del = async (id: string) => {
    if (!isTauri()) return;
    try {
      await providerDelete(id);
      reload();
    } catch (e) {
      toast("error", errorText(e));
    }
  };

  if (edit) {
    return (
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="名称" required>
            <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} data-autofocus />
          </Field>
          <Field label="Base URL" hint="留空使用官方 https://api.anthropic.com">
            <Input mono value={edit.baseUrl} onChange={(e) => setEdit({ ...edit, baseUrl: e.target.value })} placeholder="填写供应商 API 地址" />
          </Field>
          <Field label="主模型（ANTHROPIC_MODEL）" hint="留空不覆盖">
            <Input mono value={edit.model} onChange={(e) => setEdit({ ...edit, model: e.target.value })} placeholder="claude-sonnet-5" />
          </Field>
          <Field label="快速模型（ANTHROPIC_SMALL_FAST_MODEL）" hint="留空不覆盖">
            <Input mono value={edit.smallModel} onChange={(e) => setEdit({ ...edit, smallModel: e.target.value })} placeholder="claude-haiku-4-5-20251001" />
          </Field>
          <Field label="Token 变量" hint="Bearer 认证用 AUTH_TOKEN；x-api-key 认证用 API_KEY">
            <Select value={edit.tokenEnv} onChange={(e) => setEdit({ ...edit, tokenEnv: e.target.value as ProviderProfile["tokenEnv"] })}>
              <option value="ANTHROPIC_AUTH_TOKEN">ANTHROPIC_AUTH_TOKEN</option>
              <option value="ANTHROPIC_API_KEY">ANTHROPIC_API_KEY</option>
            </Select>
          </Field>
          <Field label="Token" hint={edit.id ? "留空表示不修改已保存的 Token" : "保存到 Windows 凭据管理器，不写入配置文件"}>
            <Input mono type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={edit.id ? "••••••（不修改）" : "sk-…"} autoComplete="off" />
          </Field>
        </div>
        <Field label="额外环境变量" hint="每行一个 K=V，如 API_TIMEOUT_MS=600000">
          <textarea
            rows={3}
            value={extraText}
            onChange={(e) => setExtraText(e.target.value)}
            className="w-full rounded border border-white/10 bg-white/[0.04] px-2.5 py-1.5 font-mono text-code-md text-on-surface outline-none focus:border-b-accent"
          />
        </Field>
        <PricingEditor pricing={pricing} onPricing={setPricing} models={modelPrices} onModels={setModelPrices} />
        <div className="flex justify-end gap-2">
          <Button disabled={saving} onClick={() => setEdit(null)}>返回</Button>
          <Button variant="primary" icon="save" disabled={saving} onClick={() => void save()}>
            {saving ? "保存中…" : "保存供应商"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Callout tone="info">供应商用于把容器切换为 API 按量模式（与 CC Switch 类似）。写入容器的是 provider-settings.json 的 env 块，会话以 claude --settings 加载。</Callout>
      {list.map((p) => (
        <div key={p.id} className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.03] p-2.5">
          <div className="flex flex-col">
            <span className="font-ui text-headline-sm text-on-surface">{p.name}</span>
            <span className="font-mono text-code-sm text-on-surface-variant">
              {p.baseUrl || "官方 API"} · {p.model || "默认模型"} · {p.tokenEnv}
            </span>
            <span className="font-ui text-body-sm text-outline">
              未收录模型回退：输入 ${p.pricing?.input ?? 0} · 输出 ${p.pricing?.output ?? 0} / 百万 token
              {Object.keys(p.modelPricing ?? {}).length > 0 ? ` · ${Object.keys(p.modelPricing).length} 项模型定价` : ""}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`font-ui text-label-sm ${p.hasToken ? "text-st-ok" : "text-st-warn"}`}>{p.hasToken ? "Token 已保存" : "缺少 Token"}</span>
            <Button
              variant="subtle"
              icon="edit"
              className="h-7"
              onClick={() => {
                setEdit(p);
                setToken("");
                setPricing(priceDraft(p.pricing));
                setModelPrices(modelPriceDrafts(p.modelPricing));
                setExtraText(Object.entries(p.extraEnv).map(([k, v]) => `${k}=${v}`).join("\n"));
              }}
            >
              编辑
            </Button>
            <Button variant="subtle" icon="delete" className="h-7 hover:!text-st-bad" onClick={() => void del(p.id)}>
              删除
            </Button>
          </div>
        </div>
      ))}
      <Button
        icon="add"
        className="self-start"
        onClick={() => {
          setEdit({ id: "", name: "", baseUrl: "", model: "", smallModel: "", tokenEnv: "ANTHROPIC_AUTH_TOKEN", extraEnv: {}, pricing: { ...ZERO_PRICING }, modelPricing: mergeBuiltinModelPricing() });
          setPricing(priceDraft());
          setModelPrices(modelPriceDrafts());
          setExtraText("");
          setToken("");
        }}
      >
        新增供应商
      </Button>
    </div>
  );
}

/**
 * 设置弹框。
 * @param props tab 初始分页
 * @returns JSX
 */
export function SettingsModal({ tab: initialTab }: { tab?: TabId }) {
  const close = useUiStore((s) => s.closeModal);
  const toast = useUiStore((s) => s.toast);
  const saved = useUiStore((s) => s.settings);
  const setSaved = useUiStore((s) => s.setSettings);
  const [tab, setTab] = useState<TabId>(initialTab ?? "appearance");
  const [draft, setDraft] = useState<Settings>(saved);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [patternsText, setPatternsText] = useState(saved.quota.limitPatterns.join("\n"));
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const importPending = useRef(false);
  const savePending = useRef(false);
  const importedAssets = useRef(new Set<string>());

  useEffect(() => () => {
    const current = useUiStore.getState();
    current.setWallpaperPreview(null);
    useUiStore.setState({ terminalPreview: null });
    applySettings(current.settings.terminal);
    for (const fileName of importedAssets.current) {
      if (fileName !== current.settings.wallpaper.asset?.fileName) void discardWallpaper(fileName).catch(() => undefined);
    }
  }, []);

  const setWallpaper = (wallpaper: WallpaperSettings) => {
    setDraft((previous) => ({ ...previous, wallpaper }));
    useUiStore.getState().setWallpaperPreview(wallpaper);
  };

  /**
   * 修改终端设置并实时预览到所有终端。
   * @param p 部分字段
   * @returns 无
   */
  const setTerm = (p: Partial<Settings["terminal"]>) => {
    const next = { ...draft, terminal: { ...draft.terminal, ...p } };
    setDraft(next);
    useUiStore.setState({ terminalPreview: next.terminal });
    applySettings(next.terminal);
  };
  const setQuota = (p: Partial<Settings["quota"]>) => setDraft({ ...draft, quota: { ...draft.quota, ...p } });

  /**
   * 取消：恢复已保存的外观。
   * @returns 无
   */
  const cancel = () => {
    if (importPending.current || savePending.current) return;
    useUiStore.getState().setWallpaperPreview(null);
    useUiStore.setState({ terminalPreview: null });
    applySettings(saved.terminal);
    close();
  };

  /**
   * 保存。
   * @returns Promise
   */
  const save = async () => {
    if (importPending.current || savePending.current) return;
    savePending.current = true;
    setSaving(true);
    const next: Settings = { ...draft, quota: { ...draft.quota, limitPatterns: patternsText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) } };
    try {
      if (isTauri()) await settingsSet(next);
      setSaved(next);
      useUiStore.getState().setWallpaperPreview(null);
      useUiStore.setState({ terminalPreview: null });
      applySettings(next.terminal);
      if (saved.wallpaper.asset && saved.wallpaper.asset.fileName !== next.wallpaper.asset?.fileName) {
        void discardWallpaper(saved.wallpaper.asset.fileName).catch(() => toast("warning", "设置已保存，旧壁纸文件暂未清理"));
      }
      toast("success", "设置已保存");
      close();
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  };

  /**
   * 测试 Docker 连接。
   * @returns Promise
   */
  const test = async () => {
    if (!isTauri()) return setTestResult({ ok: false, text: "演示模式：未连接后端" });
    setTestResult({ ok: true, text: "正在连接…" });
    try {
      const info = await dockerTest(draft.docker.host);
      setTestResult({ ok: true, text: `连接成功：Docker ${info.version}（API ${info.apiVersion}），延迟 ${info.latencyMs}ms` });
    } catch (e) {
      setTestResult({ ok: false, text: errorText(e) });
    }
  };

  const t = draft.terminal;
  const q = draft.quota;
  return (
    <Modal
      title="设置"
      icon="settings"
      width={920}
      onClose={cancel}
      footerLeft={(importing || saving) ? <span className="font-ui text-body-sm text-accent">{importing ? "正在导入壁纸…" : "正在保存…"}</span> : tab === "wallpaper" ? <span className="font-ui text-body-sm text-outline">实时预览 · 取消可恢复</span> : undefined}
      onSubmit={SELF_MANAGED_TABS.includes(tab) ? undefined : () => void save()}
      footer={
        SELF_MANAGED_TABS.includes(tab) ? (
          <Button disabled={importing || saving} onClick={cancel}>关闭</Button>
        ) : (
          <>
            <Button disabled={importing || saving} onClick={cancel}>取消</Button>
            <Button disabled={importing || saving} variant="primary" icon="save" kbd="Ctrl+Enter" onClick={() => void save()}>
              保存
            </Button>
          </>
        )
      }
    >
      <div className="grid min-h-[480px] grid-cols-[180px_1fr] gap-5">
        <nav className="sticky top-0 flex flex-col gap-0.5 self-start">
          {TABS.map((x) => (
            <button
              key={x.id}
              type="button"
              disabled={importing || saving}
              onClick={() => setTab(x.id)}
              className={`relative flex h-9 items-center gap-2 rounded px-3 font-ui text-body-md ${tab === x.id ? "bg-white/[0.07] text-on-surface" : "text-on-surface-variant hover:bg-white/[0.04]"}`}
            >
              {tab === x.id && <span className="absolute left-0 top-2 h-5 w-[3px] rounded-full bg-accent" />}
              <Icon name={x.icon} size={17} />
              {x.label}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-col gap-4">
          {tab === "wallpaper" && <WallpaperPane value={draft.wallpaper} onChange={setWallpaper} disabled={saving}
            onImported={(asset) => importedAssets.current.add(asset.fileName)}
            onBusyChange={(busy) => { importPending.current = busy; setImporting(busy); }} />}
          {tab === "appearance" && (
            <>
              <Preview settings={draft} />
              <div className="grid grid-cols-3 gap-3">
                <Field label="终端字体">
                  <Select value={t.fontFamily} onChange={(e) => setTerm({ fontFamily: e.target.value })}>
                    {FONTS.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={`字号：${t.fontSize}px`}>
                  <input type="range" min={10} max={24} value={t.fontSize} onChange={(e) => setTerm({ fontSize: Number(e.target.value) })} className="accent-[#60CDFF]" />
                </Field>
                <Field label={`行高：${t.lineHeight.toFixed(2)}`}>
                  <input type="range" min={1} max={1.8} step={0.05} value={t.lineHeight} onChange={(e) => setTerm({ lineHeight: Number(e.target.value) })} className="accent-[#60CDFF]" />
                </Field>
              </div>
              <Field label="真彩配色方案">
                <div className="grid grid-cols-4 gap-2">
                  {THEMES.map((th) => (
                    <button
                      key={th.id}
                      type="button"
                      onClick={() => setTerm({ theme: th.id })}
                      className={`flex flex-col gap-1.5 rounded-lg border p-2 text-left ${t.theme === th.id ? "border-accent/70" : "border-white/[0.08] hover:border-white/20"}`}
                      style={{ background: th.theme.background }}
                    >
                      <span className="font-ui text-label-md" style={{ color: th.theme.foreground }}>
                        {th.name}
                      </span>
                      <span className="flex gap-0.5">
                        {[th.theme.red, th.theme.green, th.theme.yellow, th.theme.blue, th.theme.magenta, th.theme.cyan].map((c, i) => (
                          <span key={i} className="h-2.5 w-2.5 rounded-sm" style={{ background: c }} />
                        ))}
                      </span>
                    </button>
                  ))}
                </div>
              </Field>
              <div className="grid grid-cols-3 items-end gap-3">
                <Field label="光标样式">
                  <Select value={t.cursorStyle} onChange={(e) => setTerm({ cursorStyle: e.target.value as Settings["terminal"]["cursorStyle"] })}>
                    <option value="block">方块</option>
                    <option value="bar">竖线</option>
                    <option value="underline">下划线</option>
                  </Select>
                </Field>
                <Field label="本地回滚行数" hint="tmux 另有 50000 行历史">
                  <Input type="number" min={1000} max={100000} step={1000} value={t.scrollback} onChange={(e) => setTerm({ scrollback: Number(e.target.value) })} />
                </Field>
                <div className="flex flex-col gap-2 pb-1">
                  <Switch checked={t.cursorBlink} onChange={(v) => setTerm({ cursorBlink: v })} label="光标闪烁" />
                  <Switch checked={t.webgl} onChange={(v) => setTerm({ webgl: v })} label="WebGL 加速渲染" />
                </div>
              </div>
            </>
          )}

          {tab === "docker" && (
            <>
              <Section title="Docker 引擎连接" icon="lan">
                <Field label="引擎地址" hint="留空使用默认 npipe:////./pipe/docker_engine（Docker Desktop）；也支持 tcp://host:2375">
                  <div className="flex gap-1.5">
                    <Input mono value={draft.docker.host} onChange={(e) => setDraft({ ...draft, docker: { ...draft.docker, host: e.target.value } })} placeholder="npipe:////./pipe/docker_engine" />
                    <Button icon="network_check" onClick={() => void test()}>
                      测试连接
                    </Button>
                  </div>
                </Field>
                {testResult && <Callout tone={testResult.ok ? "success" : "danger"}>{testResult.text}</Callout>}
                <Field label="默认镜像" hint="新建容器时的默认镜像；本地不存在时，可在启动页或新建容器中用应用内置的标准 Dockerfile 一键构建">
                  <Input mono value={draft.docker.defaultImage} onChange={(e) => setDraft({ ...draft, docker: { ...draft.docker, defaultImage: e.target.value } })} />
                </Field>
              </Section>
              <Callout tone="info">项目源码建议放在 WSL2 文件系统（如 \\wsl$\Ubuntu\home\…），Windows 盘符目录挂载到容器 I/O 较慢，文件监听（inotify）也不可靠。</Callout>
            </>
          )}

          {tab === "quota" && (
            <>
              <Section title="额度刷新与阈值" icon="speed">
                <div className="grid grid-cols-2 gap-3">
                  <Field label={`刷新频率：每 ${q.refreshSecs} 秒`} hint="对运行中的容器执行 tdc-ctl snapshot">
                    <input type="range" min={2} max={60} value={q.refreshSecs} onChange={(e) => setQuota({ refreshSecs: Number(e.target.value) })} className="accent-[#60CDFF]" />
                  </Field>
                  <Field label={`触发切换：已用 ≥ ${q.switchThreshold}%`} hint="5h 或周任一窗口达到即视为耗尽">
                    <input type="range" min={80} max={100} value={q.switchThreshold} onChange={(e) => setQuota({ switchThreshold: Number(e.target.value) })} className="accent-[#60CDFF]" />
                  </Field>
                  <Field label={`黄色预警：剩余 ≤ ${q.warnThreshold}%`}>
                    <input type="range" min={10} max={60} value={q.warnThreshold} onChange={(e) => setQuota({ warnThreshold: Number(e.target.value) })} className="accent-[#FCE100]" />
                  </Field>
                  <Field label={`红色告警：剩余 < ${q.criticalThreshold}%`}>
                    <input type="range" min={1} max={20} value={q.criticalThreshold} onChange={(e) => setQuota({ criticalThreshold: Number(e.target.value) })} className="accent-[#FF5449]" />
                  </Field>
                </div>
              </Section>
              <Section title="热切换行为" icon="swap_horiz">
                <Switch checked={q.autoPrompt} onChange={(v) => setQuota({ autoPrompt: v })} label="额度耗尽时自动弹出切换框" />
                <Switch checked={q.includeStopped} onChange={(v) => setQuota({ includeStopped: v })} label="候选包含已停止的订阅容器（切换时自动启动）" />
                <Switch checked={q.allowApiFallback} onChange={(v) => setQuota({ allowApiFallback: v })} label="允许 API 模式容器作为最后候选（会产生按量费用）" />
                <Field label="限额文案识别（正则，每行一个）" hint="作为辅助信号：终端输出命中时立即标记该容器耗尽">
                  <textarea
                    rows={4}
                    value={patternsText}
                    onChange={(e) => setPatternsText(e.target.value)}
                    className="w-full rounded border border-white/10 bg-white/[0.04] px-2.5 py-1.5 font-mono text-code-md text-on-surface outline-none focus:border-b-accent"
                  />
                </Field>
              </Section>
            </>
          )}

          {tab === "providers" && <ProvidersPane />}

          {tab === "proxy" && <ProxyNodesPane />}

          {tab === "shortcuts" && (
            <>
              <Field label="侧栏快捷键" hint="Ctrl+B 同时是 Claude Code「转后台」、tmux 前缀与 bash 光标左移；选择它会让这些按键在终端中失效">
                <Select value={draft.sidebarShortcut} onChange={(e) => setDraft({ ...draft, sidebarShortcut: e.target.value })}>
                  <option value="ctrl+shift+b">Ctrl+Shift+B（推荐）</option>
                  <option value="ctrl+b">Ctrl+B</option>
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                {buildShortcuts(draft.sidebarShortcut).map((s) => (
                  <div key={s.action} className="flex items-center justify-between border-b border-white/[0.04] py-1.5 font-ui text-body-md">
                    <span className="text-on-surface">{s.desc}</span>
                    <Kbd>{s.label}</Kbd>
                  </div>
                ))}
                <div className="flex items-center justify-between border-b border-white/[0.04] py-1.5 font-ui text-body-md">
                  <span className="text-on-surface">额度切换弹框：确认 / 稍后 / 换候选</span>
                  <span className="flex gap-1">
                    <Kbd>Enter</Kbd>
                    <Kbd>Esc</Kbd>
                    <Kbd>Tab</Kbd>
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
