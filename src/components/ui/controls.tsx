/**
 * 基础 UI 组件（Fluent 风格，令牌来自 DESIGN.md）：图标、按钮、输入框、开关、状态灯、进度条、字段、分段选择。
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import type { Health } from "../../api/types";
import { HEALTH_COLOR } from "../../lib/quota";

/**
 * Material Symbols 图标；加载图标在允许动态效果时持续旋转。
 * @param props name 图标名、size 像素、className
 * @returns JSX
 */
export function Icon({ name, size = 16, className = "", fill = false }: { name: string; size?: number; className?: string; fill?: boolean }) {
  return (
    <span
      aria-hidden
      className={`material-symbols-outlined select-none leading-none ${name === "progress_activity" ? "motion-safe:animate-spin" : ""} ${className}`}
      style={{ fontSize: size, fontVariationSettings: `'FILL' ${fill ? 1 : 0}, 'wght' 400, 'opsz' 20` }}
    >
      {name}
    </span>
  );
}

type Variant = "primary" | "standard" | "subtle" | "danger";

const VARIANT: Record<Variant, string> = {
  primary: "bg-accent text-black font-semibold hover:bg-accent-hover active:bg-accent-active border-b border-black/20 disabled:bg-accent/40",
  standard: "bg-white/[0.06] text-white border border-white/[0.08] hover:bg-white/10 active:bg-white/[0.03]",
  subtle: "bg-transparent text-on-surface-variant hover:bg-white/[0.06] hover:text-on-surface active:bg-white/[0.03]",
  danger: "bg-st-bad/15 text-st-bad border border-st-bad/30 hover:bg-st-bad/25 disabled:opacity-40",
};

/**
 * 按钮。
 * @param props variant 样式、icon 前置图标、kbd 快捷键提示，以及原生 button 属性
 * @returns JSX
 */
export function Button({
  variant = "standard",
  icon,
  kbd,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: string; kbd?: string }) {
  return (
    <button
      type="button"
      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded px-3 font-ui text-body-md transition-colors disabled:cursor-not-allowed ${VARIANT[variant]} ${className}`}
      {...rest}
    >
      {icon && <Icon name={icon} size={16} />}
      {children}
      {kbd && <span className="ml-1 rounded bg-black/15 px-1 font-mono text-code-sm opacity-70">{kbd}</span>}
    </button>
  );
}

/**
 * 图标按钮（标题栏 / 工具条）。
 * @param props icon 图标名、title 提示，以及原生 button 属性
 * @returns JSX
 */
export function IconButton({
  icon,
  title,
  active = false,
  size = 16,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; title: string; active?: boolean; size?: number }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={`inline-flex h-7 w-7 items-center justify-center rounded text-on-surface-variant transition-colors hover:bg-white/[0.08] hover:text-on-surface ${active ? "bg-accent/15 text-accent" : ""} ${className}`}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

/**
 * 输入框（聚焦时底部 2px 强调线）。
 * @param props 原生 input 属性，mono 使用等宽字体，invalid 标红
 * @returns JSX
 */
export function Input({ className = "", mono = false, invalid = false, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; invalid?: boolean }) {
  return (
    <input
      className={`h-8 w-full rounded border bg-white/[0.04] px-2.5 text-on-surface caret-accent outline-none transition-colors placeholder:text-outline focus:border-b-2 focus:bg-white/[0.06] ${
        invalid ? "border-st-bad/60 focus:border-b-st-bad" : "border-white/10 focus:border-b-accent"
      } ${mono ? "font-mono text-code-md" : "font-ui text-body-md"} ${className}`}
      {...rest}
    />
  );
}

/**
 * 多行文本框。
 * @param props 原生 textarea 属性
 * @returns JSX
 */
export function TextArea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full rounded border border-white/10 bg-white/[0.04] px-2.5 py-1.5 font-mono text-code-md text-on-surface caret-accent outline-none placeholder:text-outline focus:border-b-2 focus:border-b-accent ${className}`}
      {...rest}
    />
  );
}

/**
 * 下拉选择。
 * @param props 原生 select 属性
 * @returns JSX
 */
export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`h-8 w-full rounded border border-white/10 bg-surface-container-high px-2 font-ui text-body-md text-on-surface outline-none focus:border-b-2 focus:border-b-accent ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}

/**
 * Fluent 开关（40×20）。
 * @param props checked 状态、onChange 回调、label 可选文字
 * @returns JSX
 */
export function Switch({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <label className={`inline-flex items-center gap-2 ${disabled ? "opacity-40" : "cursor-pointer"}`}>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-10 rounded-full border transition-colors ${checked ? "border-accent bg-accent" : "border-white/60 bg-transparent"}`}
      >
        <span className={`absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full transition-all ease-fluent ${checked ? "left-[22px] bg-black" : "left-[3px] bg-white/80"}`} />
      </button>
      {label && <span className="font-ui text-body-md text-on-surface">{label}</span>}
    </label>
  );
}

/**
 * 复选框（18px，3px 圆角）。
 * @param props checked、onChange、label、desc
 * @returns JSX
 */
export function Checkbox({ checked, onChange, label, desc }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; desc?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[3px] border ${checked ? "border-accent bg-accent text-black" : "border-white/50"}`}
      >
        {checked && <Icon name="check" size={14} />}
      </button>
      <span className="flex flex-col">
        <span className="font-ui text-body-md text-on-surface">{label}</span>
        {desc && <span className="font-ui text-body-sm text-on-surface-variant">{desc}</span>}
      </span>
    </label>
  );
}

/**
 * 状态灯。
 * @param props health 健康状态、size 直径、pulse 是否脉冲
 * @returns JSX
 */
export function StatusDot({ health, size = 8, pulse = false }: { health: Health; size?: number; pulse?: boolean }) {
  const color = HEALTH_COLOR[health];
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {pulse && <span className="absolute inset-0 animate-ping rounded-full opacity-60" style={{ background: color }} />}
      <span className="relative inline-flex h-full w-full rounded-full" style={{ background: color, boxShadow: health === "healthy" ? `0 0 6px ${color}` : undefined }} />
    </span>
  );
}

/**
 * 细进度条。
 * @param props pct 百分比、color 颜色、height 高度
 * @returns JSX
 */
export function ProgressBar({ pct, color, height = 4 }: { pct: number; color: string; height?: number }) {
  return (
    <div className="w-full overflow-hidden rounded-full bg-white/[0.08]" style={{ height }}>
      <div className="h-full rounded-full transition-all duration-500 ease-fluent" style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </div>
  );
}

/**
 * 表单字段（标签 + 控件 + 说明 / 错误）。
 * @param props label、required、hint、error、aside 右侧附加信息、children 控件
 * @returns JSX
 */
export function Field({
  label,
  required,
  hint,
  error,
  aside,
  children,
}: {
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: string | null;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1 font-ui text-label-md text-on-surface">
          {label}
          {required && <span className="text-st-bad">*</span>}
        </label>
        {aside}
      </div>
      {children}
      {error ? (
        <span className="flex items-center gap-1 font-ui text-body-sm text-st-bad">
          <Icon name="error" size={13} />
          {error}
        </span>
      ) : (
        hint && <span className="font-ui text-body-sm text-on-surface-variant">{hint}</span>
      )}
    </div>
  );
}

/**
 * 分段 / 卡片单选。
 * @param props options 选项、value 当前值、onChange 回调
 * @returns JSX
 */
export function CardRadio<T extends string>({
  options,
  value,
  onChange,
  columns = 3,
}: {
  options: { value: T; title: string; desc?: string; icon?: string; badge?: string }[];
  value: T;
  onChange: (v: T) => void;
  columns?: number;
}) {
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`flex flex-col gap-1 rounded-lg border p-2.5 text-left transition-colors ${
              on ? "border-accent/60 bg-accent/[0.12]" : "border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.06]"
            }`}
          >
            <span className="flex items-center justify-between gap-2">
              <span className={`flex items-center gap-1.5 font-ui text-headline-sm ${on ? "text-accent" : "text-on-surface"}`}>
                {o.icon && <Icon name={o.icon} size={16} />}
                {o.title}
              </span>
              {o.badge ? (
                <span className="rounded-full bg-accent/20 px-1.5 py-0.5 font-ui text-label-sm text-accent">{o.badge}</span>
              ) : (
                <Icon name={on ? "radio_button_checked" : "radio_button_unchecked"} size={16} className={on ? "text-accent" : "text-outline"} />
              )}
            </span>
            {o.desc && <span className="font-ui text-body-sm text-on-surface-variant">{o.desc}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 卡片分组容器。
 * @param props title、icon、aside、children
 * @returns JSX
 */
export function Section({ title, icon, aside, children, className = "" }: { title: string; icon: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`flex flex-col gap-3 rounded-xl border border-white/[0.06] bg-white/[0.03] p-4 ${className}`}>
      <header className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-ui text-headline-sm text-on-surface">
          <Icon name={icon} size={18} className="text-accent" />
          {title}
        </span>
        {aside}
      </header>
      {children}
    </section>
  );
}

/**
 * 提示条。
 * @param props tone 语气、children 内容
 * @returns JSX
 */
export function Callout({ tone = "info", icon, children }: { tone?: "info" | "warning" | "danger" | "success"; icon?: string; children: ReactNode }) {
  const style = {
    info: "border-accent/25 bg-accent/[0.08] text-on-surface",
    warning: "border-st-warn/25 bg-st-warn-bg/60 text-on-surface",
    danger: "border-st-bad/30 bg-st-bad-bg/70 text-on-surface",
    success: "border-st-ok/25 bg-st-ok-bg/60 text-on-surface",
  }[tone];
  const iconColor = { info: "text-accent", warning: "text-st-warn", danger: "text-st-bad", success: "text-st-ok" }[tone];
  const iconName = icon ?? { info: "info", warning: "warning", danger: "report", success: "check_circle" }[tone];
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 font-ui text-body-sm ${style}`}>
      <Icon name={iconName} size={16} className={`mt-px ${iconColor}`} />
      <div className="flex-1">{children}</div>
    </div>
  );
}

/**
 * 键帽。
 * @param props children 键名
 * @returns JSX
 */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-white/15 bg-white/[0.06] px-1.5 py-px font-mono text-code-sm text-on-surface">{children}</kbd>;
}
