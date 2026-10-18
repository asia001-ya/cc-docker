import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseCredential } from '../rootfs/opt/tdc/tdc-git-bridge.mjs';
const script = path.resolve('docker/rootfs/opt/tdc/tdc-git-bridge.mjs');

test('helper accepts HTTPS credential fields and rejects duplicate/control fields', () => {
  assert.deepEqual(parseCredential('protocol=https\nhost=gitee.com\npath=team/repo.git\n\n'), {protocol:'https',host:'gitee.com',path:'team/repo.git'});
  for (const text of ['protocol=http\nhost=gitee.com\n', 'protocol=https\nhost=gitee.com\nhost=evil.test\n', 'protocol=https\nhost=gitee.com\r\n', 'x'.repeat(65537)]) assert.equal(parseCredential(text), null);
});
test('enable/disable preserves existing git config and never creates a credential store', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tdc-git-bridge-'));
  t.after(()=>{
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
    assert.match(path.basename(dir),/^tdc-git-bridge-/);
    fs.rmSync(dir,{recursive:true,force:true});
  });
  const global=path.join(dir,'gitconfig');
  fs.writeFileSync(global,'[user]\n\tname = Original User\n[credential]\n\thelper = original-helper\n');
  const env={...process.env,GIT_CONFIG_GLOBAL:global,GIT_CONFIG_NOSYSTEM:'1',TDC_GIT_BRIDGE_DIR:path.join(dir,'bridge'),TDC_GIT_SOCKET_DIR:path.join(dir,'socket')};
  // Keep this repository's local Git identity/helpers out of the fixture.
  const options={env,cwd:dir,encoding:'utf8',windowsHide:true};
  const code=`import {installConfig} from ${JSON.stringify(new URL('../rootfs/opt/tdc/tdc-git-bridge.mjs',import.meta.url).href)}; installConfig({allowedHosts:['gitee.com'],identity:{name:'Host User'}});`;
  const run=spawnSync(process.execPath,['--input-type=module','-e',code],options);
  assert.equal(run.status,0,run.stderr);
  const get=key=>spawnSync('git',['config','--get',key],options).stdout.trim();
  assert.equal(get('user.name'),'Host User');
  assert.equal(get('credential.helper'),'original-helper');
  const include=fs.readFileSync(path.join(dir,'bridge/config'),'utf8');
  assert.match(include,/tdc-git-bridge\.mjs helper/); assert.doesNotMatch(include,/password|token|store/);
  assert.equal(spawnSync(process.execPath,[script,'disable'],options).status,0);
  assert.equal(get('user.name'),'Original User'); assert.equal(get('credential.helper'),'original-helper');
  assert.doesNotMatch(fs.readFileSync(global,'utf8'),/path\s*=/);
  assert.equal(spawnSync(process.execPath,[script,'disable'],options).status,0,'disabling twice is safe');
});
test('store and erase never start the host bridge or save supplied credentials', () => {
  for(const command of ['store','erase']) {
    const result=spawnSync(process.execPath,[script,'helper',command],{input:'protocol=https\nhost=gitee.com\npassword=test-only\n\n',encoding:'utf8'});
    assert.equal(result.status,0); assert.equal(result.stdout,'');
  }
});
