/**
 * 表单校验（新建容器 / 会话 / 环境变量 / 端口），返回中文错误信息。
 */

/**
 * 校验容器名（与后端 spec::validate_name 一致）。
 * @param name 容器名
 * @returns 错误信息；合法返回 null
 */
export function validateContainerName(name: string): string | null {
  if (!name) return "请输入容器名称";
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(name)) return "仅限 2~63 位小写字母、数字、- 或 _，且以字母或数字开头";
  return null;
}

/**
 * 解析多行 K=V 环境变量文本。
 * @param text 每行一个 K=V，# 开头为注释
 * @returns 变量列表与逐行错误
 */
export function parseEnvLines(text: string): { env: string[]; errors: string[] } {
  const env: string[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      errors.push(`第 ${i + 1} 行缺少 =`);
      return;
    }
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      errors.push(`第 ${i + 1} 行变量名 ${key} 不合法`);
      return;
    }
    env.push(`${key}=${line.slice(eq + 1)}`);
  });
  return { env, errors };
}

/**
 * 校验端口号。
 * @param port 端口
 * @param min 最小值（宿主端口默认 1024）
 * @returns 错误信息；合法返回 null
 */
export function validatePort(port: number, min = 1): string | null {
  if (!Number.isInteger(port) || port < min || port > 65535) return `端口需在 ${min}~65535 之间`;
  return null;
}

/**
 * 校验容器内路径。
 * @param p 路径
 * @returns 错误信息；合法返回 null
 */
export function validateContainerPath(p: string): string | null {
  if (!p.startsWith("/")) return "容器内路径必须以 / 开头";
  if (p.includes("..")) return "路径不能包含 ..";
  return null;
}

/**
 * 由宿主路径推导容器内项目目录 /workspace/<目录名>。
 * @param hostPath 宿主路径（Windows 或 \\wsl$ 路径）
 * @returns 容器内路径
 */
export function deriveContainerPath(hostPath: string): string {
  const parts = hostPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const base = (parts[parts.length - 1] ?? "app").toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "app";
  return `/workspace/${base}`;
}

/**
 * 是否为 Windows 盘符路径（I/O 慢，需提示）。
 * @param p 宿主路径
 * @returns 是否盘符路径
 */
export function isWindowsDrivePath(p: string): boolean {
  return /^[A-Za-z]:/.test(p.trim());
}

/** SOCKS5 节点表单字段 */
export interface Socks5Fields {
  host: string;
  port: string;
  username: string;
  password: string;
}

/**
 * 把 SOCKS5 表单拼成后端认可的规范链接 socks5://user:pass@host:port（用户名与密码经 URL 编码）。
 * 后端会再次严格校验，这里只拦截明显错误以便就地提示。
 * @param f 表单字段（主机与端口必填，用户名与密码可选）
 * @returns 成功时 { uri }，失败时 { error }
 */
export function buildSocks5Uri(f: Socks5Fields): { uri?: string; error?: string } {
  const host = f.host.trim();
  if (!host) return { error: "请填写主机" };
  if (/[\s/?#@]/.test(host)) return { error: "主机只填域名或 IP，不要带协议、路径或空格" };
  const port = f.port.trim();
  if (!/^\d+$/.test(port) || validatePort(Number(port)) !== null) return { error: "端口需在 1~65535 之间" };
  if (f.password && !f.username) return { error: "填写了密码时必须填写用户名" };
  const addr = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const auth = f.username ? encodeURIComponent(f.username) + (f.password ? `:${encodeURIComponent(f.password)}` : "") + "@" : "";
  return { uri: `socks5://${auth}${addr}:${Number(port)}` };
}
