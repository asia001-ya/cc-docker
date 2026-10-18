/**
 * 弹框 1：新建 / 导入容器。
 * 新建：名称、镜像、算力、授权模式、项目挂载、共享会话组、端口映射、环境变量；底部实时预检。
 * 导入：选择已有容器（无 tdc 标签的需要重建才能纳管，此处只做检测与提示）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ContainerInfo, CreateContainerRequest, PortMapping, Precheck, ProjectMount, ProviderView, ProxyNodeView } from "../../api/types";
import { containerCreate, containerDefaults, containerList, containerPrecheck, errorText, isTauri, providerList, proxyNodeList } from "../../api/commands";
import { useUiStore } from "../../store/uiStore";
import { useShallow } from "zustand/react/shallow";
import { useFleetStore } from "../../store/fleetStore";
import { DEMO_PROVIDERS, DEMO_PROXY_NODES } from "../../lib/demo";
import { EMPTY_PROXY_BINDING, proxyBindingError } from "../../lib/proxyBinding";
import { ProxyBindingFields } from "./ProxyBindingFields";
import { ProxyNodesPane } from "./ProxyNodesPane";
import { ProxyPreflight } from "./ProxyPreflight";
import { HostConfigFields } from "./HostConfigFields";
import { hasHostConfig, hostConfigErrors, normalizeHostConfig } from "../../lib/hostConfig";
import { ImageBuildPanel } from "../shell/ImageBuildPanel";
import { deriveContainerPath, isWindowsDrivePath, parseEnvLines, validateContainerName, validatePort } from "../../lib/validators";
import { Modal } from "../ui/Modal";
import { containerRegionOptions, regionEnvErrors } from "../../lib/containerRegion";
import { Button, Callout, CardRadio, Field, Icon, Input, Section, Select, Switch, TextArea } from "../ui/controls";

/**
 * 新建表单初始值。
 * @returns 表单
 */
function initialForm(): CreateContainerRequest {
  return {
    name: "claude-dev-01",
    image: "tdc/claude-dev:latest",
    cpus: 4,
    memoryMb: 8192,
    timezone: containerRegionOptions.defaults.timezone,
    locale: containerRegionOptions.defaults.locale,
    authMode: "subscription",
    providerId: null,
    mounts: [],
    sharedGroup: true,
    groupName: "default",
    ports: [
      { containerPort: 3000, hostPort: 3010, label: "Web 预览 (Next/React)" },
      { containerPort: 5173, hostPort: 5183, label: "Vite 开发服务" },
      { containerPort: 8080, hostPort: 8090, label: "API 服务" },
    ],
    env: [],
    slot: 1,
    workingDir: null,
    proxyCapable: true,
    proxy: { ...EMPTY_PROXY_BINDING },
  };
}

/**
 * 导入页：列出非 tdc 容器并说明纳管方式。
 * @returns JSX
 */
function ImportPane() {
  const [list, setList] = useState<ContainerInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return setList([]);
    containerList(true)
      .then((l) => setList(l.filter((c) => !c.image.startsWith("tdc/") || c.slot === 0)))
      .catch((e) => setErr(errorText(e)));
  }, []);
  return (
    <div className="flex flex-col gap-3">
      <Callout tone="info">
        已有容器需满足两个条件才能被完整纳管：①镜像包含 <code className="font-mono">/opt/tdc</code>（基于 docker/Dockerfile 构建）以支持额度与端口上报；
        ②带有 <code className="font-mono">tdc.managed=true</code> 标签。Docker 不能给已有容器追加标签或挂载，因此导入 = 以其镜像和挂载为模板<strong>重新创建</strong>（原容器保留）。
      </Callout>
      {err && <Callout tone="danger">{err}</Callout>}
      {list === null && <div className="py-6 text-center font-ui text-body-sm text-outline">正在读取容器列表…</div>}
      {list?.length === 0 && <div className="py-6 text-center font-ui text-body-sm text-outline">没有可导入的非 tdc 容器</div>}
      {list?.map((c) => (
        <div key={c.id} className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.03] p-3">
          <div className="flex flex-col">
            <span className="font-ui text-headline-sm text-on-surface">{c.name}</span>
            <span className="font-mono text-code-sm text-on-surface-variant">
              {c.image} · {c.status}
            </span>
          </div>
          <span className={`font-ui text-label-sm ${c.image.startsWith("tdc/") ? "text-st-ok" : "text-st-warn"}`}>
            {c.image.startsWith("tdc/") ? "镜像兼容，可在新建页按同名参数重建" : "镜像不含 /opt/tdc：额度 / 端口功能不可用"}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * 新建容器弹框。
 * @returns JSX
 */
export function CreateContainerModal() {
  const close = useUiStore((s) => s.closeModal);
  const toast = useUiStore((s) => s.toast);
  const openModal = useUiStore((s) => s.openModal);
  const existing = useFleetStore(useShallow((s) => s.fleet.entries.map((e) => e.container.name)));
  const [tab, setTab] = useState<"new" | "import">("new");
  const [form, setForm] = useState<CreateContainerRequest>(initialForm);
  const [envText, setEnvText] = useState("");
  const [imageReady, setImageReady] = useState<boolean | null>(null);
  const [defaultImage, setDefaultImage] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [precheck, setPrecheck] = useState<Precheck | null>(null);
  const [busy, setBusy] = useState<"create" | "start" | null>(null);
  const [autoShift, setAutoShift] = useState(true);
  const [proxyNodes, setProxyNodes] = useState<ProxyNodeView[]>([]);
  const [proxyLoadError, setProxyLoadError] = useState<string | null>(null);
  const [manageProxyNodes, setManageProxyNodes] = useState(false);
  const [proxyChecking, setProxyChecking] = useState(false);
  const proxy = form.proxy ?? EMPTY_PROXY_BINDING;
  const updateProxyNodes = useCallback((nodes: ProxyNodeView[]) => {
    setProxyNodes(nodes);
    setProxyLoadError(null);
  }, []);

  useEffect(() => {
    if (!isTauri()) return updateProxyNodes(DEMO_PROXY_NODES);
    proxyNodeList().then(updateProxyNodes).catch((e) => setProxyLoadError(errorText(e)));
  }, [updateProxyNodes]);

  useEffect(() => {
    if (!isTauri()) {
      setProviders(DEMO_PROVIDERS);
      setForm((f) => ({ ...f, name: "claude-dev-07", slot: 7 }));
      setImageReady(true);
      return;
    }
    containerDefaults()
      .then((d) => {
        setForm((f) => ({ ...f, name: d.name, slot: d.slot, image: d.image, ports: d.ports }));
        setDefaultImage(d.image);
        setImageReady(d.imageReady);
      })
      .catch((e) => toast("error", errorText(e)));
    providerList().then(setProviders).catch(() => undefined);
  }, [toast]);

  const env = useMemo(() => parseEnvLines(envText), [envText]);
  const regionErrors = regionEnvErrors(form.timezone, form.locale, env.env);
  const nameError = validateContainerName(form.name) ?? (existing.includes(form.name) ? "已存在同名容器" : null);
  const request = useMemo<CreateContainerRequest>(() => ({ ...form, hostConfig: normalizeHostConfig(form.hostConfig), proxy: form.proxy?.enabled ? form.proxy : null, env: env.env }), [form, env.env]);

  // 后端预检（防抖 400ms）
  useEffect(() => {
    if (!isTauri() || tab !== "new") return;
    let active = true;
    setPrecheck(null);
    const t = setTimeout(() => {
      containerPrecheck(request).then((r) => { if (active) setPrecheck(r); }).catch((cause) => { if (active) setPrecheck({ ok: false, errors: [`预检失败：${errorText(cause)}`], warnings: [] }); });
    }, 400);
    return () => { active = false; clearTimeout(t); };
  }, [request, tab, proxyNodes, imageReady]);

  /**
   * 更新表单字段。
   * @param patch 部分字段
   * @returns 无
   */
  const patch = (p: Partial<CreateContainerRequest>) => setForm((f) => ({ ...f, ...p }));

  /**
   * 更新端口行；开启自动顺延时，宿主端口与其他行冲突则 +1。
   * @param i 行号
   * @param p 新值
   * @returns 无
   */
  const setPort = (i: number, p: Partial<PortMapping>) =>
    setForm((f) => {
      const ports = f.ports.map((x, j) => (j === i ? { ...x, ...p } : x));
      if (autoShift && p.hostPort !== undefined) {
        const others = new Set(ports.filter((_, j) => j !== i).map((x) => x.hostPort));
        let hp = ports[i].hostPort;
        while (others.has(hp) && hp < 65535) hp += 1;
        ports[i] = { ...ports[i], hostPort: hp };
      }
      return { ...f, ports };
    });

  /**
   * 更新挂载行。
   * @param i 行号
   * @param m 新值
   * @returns 无
   */
  const setMount = (i: number, m: Partial<ProjectMount>) => setForm((f) => ({ ...f, mounts: f.mounts.map((x, j) => (j === i ? { ...x, ...m } : x)) }));

  /**
   * 选择宿主目录。
   * @param i 行号（-1 表示新增）
   * @returns Promise
   */
  const browse = async (i: number) => {
    if (!isTauri()) return;
    const dir = await openDialog({ directory: true, title: "选择要挂载到容器的项目目录" });
    if (typeof dir !== "string") return;
    const m = { hostPath: dir, containerPath: deriveContainerPath(dir), readOnly: false };
    if (i < 0) patch({ mounts: [...form.mounts, m] });
    else setMount(i, m);
  };

  const localErrors = [
    nameError,
    ...form.ports.map((p) => validatePort(p.hostPort, 1024)),
    ...env.errors,
    ...regionErrors,
    ...hostConfigErrors(form.hostConfig),
    proxy.enabled ? proxyLoadError ?? proxyBindingError(proxy, proxyNodes) : null,
    proxy.enabled && !form.proxyCapable ? "开启代理需要授予容器内代理能力" : null,
    form.authMode === "api" && !form.providerId ? "API 模式需要选择供应商" : null,
  ].filter(Boolean) as string[];
  const errors = [...new Set([...localErrors, ...(precheck?.errors ?? [])])];
  const warnings = [
    ...(precheck?.warnings ?? []),
    ...form.mounts.filter((m) => isWindowsDrivePath(m.hostPath)).map(() => "Windows 盘符目录 I/O 较慢，建议放到 WSL2 文件系统（\\\\wsl$\\…）"),
  ];
  const canSubmit = errors.length === 0 && busy === null && !proxyChecking && imageReady !== false
    && (!isTauri() || !hasHostConfig(form.hostConfig) || precheck?.ok === true);

  /**
   * 提交创建。
   * @param start 是否立即启动
   * @returns Promise
   */
  const submit = useCallback(
    async (start: boolean) => {
      if (!canSubmit) return;
      if (!isTauri()) {
        toast("info", "演示模式：未连接后端，未实际创建");
        return close();
      }
      setBusy(start ? "start" : "create");
      try {
        await containerCreate(request, start);
        toast("success", `容器 ${request.name} 已${start ? "创建并启动" : "创建"}`);
        close();
        if (start && request.authMode === "subscription") openModal({ kind: "auth", container: request.name });
      } catch (e) {
        toast("error", `创建失败：${errorText(e)}`);
      } finally {
        setBusy(null);
      }
    },
    [canSubmit, request, toast, close, openModal],
  );

  const footerLeft =
    tab === "new" ? (
      <div className="flex items-center gap-2 font-ui text-label-md">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${errors.length ? "bg-st-bad" : warnings.length ? "bg-st-warn" : "bg-st-ok shadow-[0_0_8px_#28CA41]"}`} />
        <span className={errors.length ? "text-st-bad" : warnings.length ? "text-st-warn" : "text-st-ok"}>
          {errors.length ? "预检未通过：" : warnings.length ? "预检通过（有提示）：" : "配置预检通过："}
        </span>
        <span className="truncate text-on-surface-variant" title={[...errors, ...warnings].join("\n")}>
          {errors[0] ?? warnings[0] ?? `宿主端口可用 · 镜像${imageReady ? "已就绪" : "检测中"} · 槽位 ${String(form.slot).padStart(2, "0")}`}
        </span>
      </div>
    ) : null;

  return (
    <Modal
      title="新建 / 导入 Claude 工作容器"
      icon="view_in_ar"
      badge="DOCKER"
      width={1040}
      onClose={close}
      onSubmit={() => void submit(true)}
      headerExtra={
        <div className="mr-2 flex rounded-md bg-white/[0.05] p-0.5">
          {(["new", "import"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded px-3 py-1 font-ui text-label-md ${tab === t ? "bg-white/[0.1] text-on-surface" : "text-on-surface-variant hover:text-on-surface"}`}
            >
              {t === "new" ? "新建容器" : "导入已有"}
            </button>
          ))}
        </div>
      }
      footerLeft={footerLeft}
      footer={
        tab === "new" ? (
          <>
            <Button onClick={close}>取消</Button>
            <Button icon="save" disabled={!canSubmit} onClick={() => void submit(false)}>
              {busy === "create" ? "创建中…" : "仅创建容器"}
            </Button>
            <Button variant="primary" icon={busy === "start" ? "progress_activity" : "rocket_launch"} kbd="Ctrl+Enter" disabled={!canSubmit} onClick={() => void submit(true)}>
              {busy === "start" ? "正在拉起容器…" : "立即创建并启动"}
            </Button>
          </>
        ) : (
          <Button onClick={close}>关闭</Button>
        )
      }
    >
      {tab === "import" ? (
        <ImportPane />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-12 gap-4">
            <Section title="基础实例配置" icon="dns" className="col-span-7" aside={<span className="font-mono text-code-sm text-on-surface-variant">槽位 {String(form.slot).padStart(2, "0")}</span>}>
              <Field
                label="容器名称"
                required
                error={nameError}
                hint="同时作为容器主机名与终端标签前缀"
                aside={!nameError && <span className="flex items-center gap-0.5 font-ui text-label-sm text-st-ok"><Icon name="check_circle" size={13} />命名可用</span>}
              >
                <Input mono value={form.name} invalid={!!nameError} onChange={(e) => patch({ name: e.target.value.toLowerCase() })} placeholder="例如 claude-dev-05" data-autofocus />
              </Field>
              <Field
                label="运行镜像"
                aside={
                  <span className={`font-ui text-label-sm ${imageReady ? "text-st-ok" : imageReady === false ? "text-st-bad" : "text-outline"}`}>
                    {imageReady ? "本地已就绪" : imageReady === false ? "本地不存在" : "检测中…"}
                  </span>
                }
                error={imageReady === false && form.image !== defaultImage ? `本地没有镜像 ${form.image}，自定义镜像需自行构建或拉取` : null}
              >
                <Input mono value={form.image} onChange={(e) => patch({ image: e.target.value })} />
              </Field>
              {imageReady === false && form.image === defaultImage && (
                <Callout tone="warning" icon="deployed_code">
                  <div className="flex flex-col gap-2">
                    <span>默认镜像尚未构建，构建完成后才能创建容器。</span>
                    <ImageBuildPanel onReady={() => setImageReady(true)} />
                  </div>
                </Callout>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="CPU 核数" hint="0 表示不限制">
                  <Input type="number" min={0} max={64} step={0.5} value={form.cpus} onChange={(e) => patch({ cpus: Number(e.target.value) })} />
                </Field>
                <Field label="内存上限（MB）" hint="0 表示不限制">
                  <Input type="number" min={0} step={512} value={form.memoryMb} onChange={(e) => patch({ memoryMb: Number(e.target.value) })} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="容器时区" hint="用于容器内的时间与日志">
                  <Select aria-label="容器时区" value={form.timezone ?? ""} onChange={(e) => patch({ timezone: e.target.value || null })}>
                    <option value="">沿用镜像</option>
                    {containerRegionOptions.timezones.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </Select>
                </Field>
                <Field label="系统语言" hint="用于命令提示与日期格式">
                  <Select aria-label="系统语言" value={form.locale ?? ""} onChange={(e) => patch({ locale: e.target.value || null })}>
                    <option value="">沿用镜像</option>
                    {containerRegionOptions.locales.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </Select>
                </Field>
              </div>
            </Section>

            <Section title="Claude 授权模式" icon="key" className="col-span-5">
              <CardRadio
                columns={1}
                value={form.authMode}
                onChange={(v) => patch({ authMode: v, providerId: v === "api" ? (providers[0]?.id ?? null) : null })}
                options={[
                  { value: "subscription", icon: "verified_user", title: "独立订阅账号", badge: "推荐", desc: "容器拥有独立的凭证卷，创建后在容器终端内执行 claude 登录（或导入 .credentials.json）。" },
                  { value: "api", icon: "api", title: "API 供应商", desc: "像 CC Switch 一样使用 Base URL + Token，按量计费；可随时切回订阅。" },
                ]}
              />
              {form.authMode === "api" && (
                <Field label="选择供应商" hint={providers.length === 0 ? "尚无供应商，请在 设置 → API 供应商 中添加" : undefined}>
                  <Select value={form.providerId ?? ""} onChange={(e) => patch({ providerId: e.target.value || null })}>
                    <option value="">请选择…</option>
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.hasToken ? "" : "（未保存 Token）"}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Callout tone="warning">多个订阅账号轮换绕开用量上限可能违反服务条款，请自行评估风险。</Callout>
            </Section>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Section
              title="项目源码挂载（Bind Mount）"
              icon="folder_open"
              aside={
                <Button variant="subtle" icon="add" className="h-7" onClick={() => void browse(-1)}>
                  添加目录
                </Button>
              }
            >
              {form.mounts.length === 0 && (
                <button type="button" onClick={() => void browse(-1)} className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-white/15 py-5 font-ui text-body-sm text-on-surface-variant hover:border-accent/50 hover:text-on-surface">
                  <Icon name="create_new_folder" size={24} />
                  选择宿主机项目目录
                </button>
              )}
              {form.mounts.map((m, i) => (
                <div key={i} className="flex flex-col gap-1.5 rounded-lg bg-white/[0.03] p-2">
                  <div className="flex items-center gap-1.5">
                    <Input mono value={m.hostPath} onChange={(e) => setMount(i, { hostPath: e.target.value })} placeholder="D:\\Projects\\app 或 \\\\wsl$\\Ubuntu\\home\\me\\app" />
                    <Button icon="folder" onClick={() => void browse(i)}>
                      浏览
                    </Button>
                    <button type="button" title="移除" className="text-outline hover:text-st-bad" onClick={() => patch({ mounts: form.mounts.filter((_, j) => j !== i) })}>
                      <Icon name="delete" size={16} />
                    </button>
                  </div>
                  <div className="flex items-center gap-2 font-ui text-label-sm text-on-surface-variant">
                    <Icon name="subdirectory_arrow_right" size={14} />
                    容器内
                    <Input mono className="!h-7 flex-1" value={m.containerPath} onChange={(e) => setMount(i, { containerPath: e.target.value })} />
                    <Switch checked={m.readOnly} onChange={(v) => setMount(i, { readOnly: v })} label="只读" />
                  </div>
                </div>
              ))}
              <span className="font-ui text-body-sm text-on-surface-variant">热切换要求各容器在<strong>相同容器路径</strong>挂载同一项目（Claude 按目录归档会话）。</span>
            </Section>

            <Section
              title="容器内代理能力"
              icon="vpn_lock"
              aside={<Switch checked={form.proxyCapable} disabled={proxy.enabled} onChange={(v) => patch({ proxyCapable: v })} label={form.proxyCapable ? "授予" : "不授予"} />}
            >
              <span className="font-ui text-body-sm text-on-surface-variant">
                授予 NET_ADMIN 与 /dev/net/tun 并关闭 IPv6，之后可随时在容器菜单中开关代理（TUN 全局接管、DNS 防泄露、失败即断网）。
                该能力只能在创建时设置，关闭后想用代理需要重建容器。
                {proxy.enabled && " 当前已开启代理，代理能力将一并授予。"}
              </span>
            </Section>

            <Section title="多容器共享会话池" icon="psychology" aside={<Switch checked={form.sharedGroup} onChange={(v) => patch({ sharedGroup: v })} label={form.sharedGroup ? "已启用" : "未启用"} />}>
              <div className={`flex flex-col gap-2 ${form.sharedGroup ? "" : "pointer-events-none opacity-40"}`}>
                <Field label="共享组" hint="同组容器共享会话历史（可跨容器 --resume）与 CLAUDE.md / skills">
                  <Input mono value={form.groupName ?? ""} onChange={(e) => patch({ groupName: e.target.value.replace(/[^a-z0-9_-]/gi, "").toLowerCase() || null })} placeholder="default" />
                </Field>
                <div className="rounded-lg bg-black/25 p-2 font-mono text-code-sm text-on-surface-variant">
                  <div>
                    <span className="text-teal">tdc_shared_projects{form.groupName && form.groupName !== "default" ? `_${form.groupName}` : ""}</span> → ~/.claude/projects
                  </div>
                  <div>
                    <span className="text-teal">tdc_shared_memory{form.groupName && form.groupName !== "default" ? `_${form.groupName}` : ""}</span> → ~/.claude-shared
                  </div>
                  <div>
                    <span className="text-magenta">tdc_home_{form.name}</span> → ~/.claude（独立凭证，不共享）
                  </div>
                </div>
              </div>
            </Section>
            <Section title="代理设置" icon="tune" aside={
              <Switch checked={proxy.enabled} disabled={!!busy || proxyChecking} label={proxy.enabled ? "开启" : "关闭"}
                onChange={(enabled) => patch({ proxy: { ...proxy, enabled }, ...(enabled ? { proxyCapable: true } : {}) })} />
            }>
              <ProxyBindingFields compact value={proxy} nodes={proxyNodes} disabled={!!busy || proxyChecking}
                onChange={(value) => patch({ proxy: value })} onManage={() => setManageProxyNodes((v) => !v)} />
              <ProxyPreflight image={form.image} binding={proxy} nodes={proxyNodes} disabled={!!busy || imageReady === false}
                onCheckingChange={setProxyChecking} />
              {proxyLoadError && <Callout tone="danger">节点库加载失败：{proxyLoadError}。可点“管理节点…”重新加载。</Callout>}
              <span className="font-ui text-body-sm text-on-surface-variant">开启后，新容器首次启动即使用此代理；之后仍可在右键菜单中调整。</span>
            </Section>
          </div>

          <Section title="宿主 Claude 配置" icon="folder_shared">
            <HostConfigFields value={form.hostConfig ?? {}} onChange={(hostConfig) => patch({ hostConfig })} disabled={!!busy || proxyChecking} />
          </Section>

          {manageProxyNodes && <Section title="代理节点库" icon="hub" aside={<Button variant="subtle" onClick={() => setManageProxyNodes(false)}>收起节点管理</Button>}>
            <ProxyNodesPane onChanged={updateProxyNodes} />
          </Section>}

          <div className="grid grid-cols-12 gap-4">
            <Section
              title="初始端口映射"
              icon="lan"
              className="col-span-8"
              aside={<Switch checked={autoShift} onChange={setAutoShift} label="冲突自动顺延 +1" />}
            >
              <div className="grid grid-cols-12 px-1 font-ui text-label-sm text-on-surface-variant">
                <span className="col-span-5">服务描述</span>
                <span className="col-span-2">容器端口</span>
                <span className="col-span-1 text-center">→</span>
                <span className="col-span-3">宿主端口（127.0.0.1）</span>
                <span className="col-span-1" />
              </div>
              {form.ports.map((p, i) => (
                <div key={i} className="grid grid-cols-12 items-center gap-1 rounded-lg bg-white/[0.03] px-1 py-1">
                  <Input className="col-span-5 !h-7" value={p.label} onChange={(e) => setPort(i, { label: e.target.value })} placeholder="描述" />
                  <Input className="col-span-2 !h-7" mono type="number" value={p.containerPort} onChange={(e) => setPort(i, { containerPort: Number(e.target.value) })} />
                  <span className="col-span-1 text-center text-outline">→</span>
                  <Input className="col-span-3 !h-7 !text-accent" mono type="number" invalid={!!validatePort(p.hostPort, 1024)} value={p.hostPort} onChange={(e) => setPort(i, { hostPort: Number(e.target.value) })} />
                  <button type="button" className="col-span-1 flex justify-center text-outline hover:text-st-bad" title="移除" onClick={() => patch({ ports: form.ports.filter((_, j) => j !== i) })}>
                    <Icon name="close" size={15} />
                  </button>
                </div>
              ))}
              <div className="flex items-center justify-between">
                <Button
                  variant="subtle"
                  icon="add"
                  className="h-7"
                  onClick={() => patch({ ports: [...form.ports, { containerPort: 4000, hostPort: 4000 + form.slot * 10, label: "" }] })}
                >
                  添加端口映射
                </Button>
                <span className="font-ui text-label-sm text-outline">Docker 不支持给运行中的容器新增映射，请预先规划</span>
              </div>
            </Section>

            <Section title="注入变量" icon="terminal" className="col-span-4">
              <div className="rounded-lg bg-black/30 p-2 font-mono text-code-sm">
                <div className="text-accent">COLORTERM=truecolor</div>
                <div className="text-teal">TERM=xterm-256color</div>
                <div className="text-secondary">TDC_CONTAINER_NAME={form.name}</div>
              </div>
              <Field label="自定义环境变量" hint="每行一个 K=V，# 开头为注释" error={env.errors[0] ?? regionErrors[0] ?? null}>
                <TextArea rows={4} value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder={"HTTP_PROXY=http://host.docker.internal:7890\nNODE_OPTIONS=--max-old-space-size=4096"} />
              </Field>
            </Section>
          </div>
        </div>
      )}
    </Modal>
  );
}
