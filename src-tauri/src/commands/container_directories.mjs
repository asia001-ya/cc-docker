import fs from 'node:fs';
import path from 'node:path';

export function listDirectories(requested) {
  if (typeof requested !== 'string' || !path.isAbsolute(requested) || requested.includes('\0') || requested.length > 4096) {
    throw new Error('请输入容器内的绝对路径');
  }
  let directory;
  let resolved;
  try {
    resolved = fs.realpathSync(requested);
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK);
    directory = fs.opendirSync(resolved);
  } catch {
    throw new Error('目录不存在或当前用户没有读取权限');
  }
  const directories = [];
  let inspected = 0;
  let truncated = false;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      if (++inspected > 20_000 || directories.length >= 1000) { truncated = true; break; }
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try { isDirectory = fs.statSync(path.join(resolved, entry.name)).isDirectory(); } catch { /* broken link */ }
      }
      if (isDirectory) directories.push({ name: entry.name, path: path.join(resolved, entry.name) });
    }
  } finally {
    directory.closeSync();
  }
  directories.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  return { path: resolved, parent: path.dirname(resolved), directories, truncated };
}

if (process.argv[1] === '--tdc-list-directories') {
  try {
    process.stdout.write(JSON.stringify({ ok: true, ...listDirectories(process.argv[2]) }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
