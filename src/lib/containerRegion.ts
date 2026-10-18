import options from "../../docker/rootfs/opt/tdc/region-options.json";

/** 表单、后端校验、镜像生成 locale 共用同一份选项。 */
export const containerRegionOptions = options;

export function regionEnvErrors(timezone: string | null | undefined, locale: string | null | undefined, env: string[]): string[] {
  const managed = new Set([...(timezone ? ["TZ"] : []), ...(locale ? ["LANG", "LC_ALL", "LANGUAGE"] : [])]);
  return env.flatMap((entry) => {
    const key = entry.split("=", 1)[0];
    return managed.has(key) ? [`${key} 与上方时区或语言设置重复，请删除该变量，或将对应选项改为“沿用镜像”。`] : [];
  });
}
