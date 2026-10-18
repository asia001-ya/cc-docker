/** Update only this tool's statusline in explicitly named running containers. */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const containers = process.argv.slice(2);
if (!containers.length || containers.some(name => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))) throw new Error('Usage: node scripts/update-statusline.mjs <container> ...');
const files = ['statusline-display.mjs', 'tdc-session-history.mjs', 'tdc-ctl.sh', 'statusline.mjs'].map(name => ({
  path: '/opt/tdc/' + name, body: fs.readFileSync(new URL('../docker/rootfs/opt/tdc/' + name, import.meta.url), 'utf8'),
}));
const installer = `
const fs = require('node:fs'), path = require('node:path');
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
const settingsPath = '/etc/claude-code/managed-settings.json';
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
if (settings.statusLine?.command !== 'node /opt/tdc/statusline.mjs') throw new Error('Custom statusline command detected; no files changed');
const backup = '/opt/tdc/.statusline-backups/' + Date.now() + '-' + process.pid;
fs.mkdirSync(backup, { recursive: true });
settings.statusLine.refreshInterval = 5;
const changes = [...payload, { path: settingsPath, body: JSON.stringify(settings, null, 2) + '\\n' }];
for (const file of changes) if (fs.existsSync(file.path)) fs.copyFileSync(file.path, path.join(backup, path.basename(file.path)));
for (const file of changes) {
  const temporary = file.path + '.tdc-statusline-' + process.pid;
  const mode = fs.existsSync(file.path) ? fs.statSync(file.path).mode & 0o777 : 0o755;
  fs.writeFileSync(temporary, file.body, { mode });
  fs.renameSync(temporary, file.path);
}
console.log(JSON.stringify({ updated: true, backup }));
`;
for (const container of containers) {
  const [info] = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8', windowsHide: true }));
  if (info.Config?.Labels?.['tdc.managed'] !== 'true' || !info.State?.Running) throw new Error(`${container}: not a running managed container`);
  const result = execFileSync('docker', ['exec', '-i', '-u', 'root', container, 'node', '-e', installer], {
    input: JSON.stringify(files), encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  console.log(container + ': ' + result.trim());
}
