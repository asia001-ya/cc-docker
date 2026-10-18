// Opt-in image integration; each case creates a disposable container without user mounts or credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const image = process.env.TDC_REGION_TEST_IMAGE;
const options = JSON.parse(readFileSync(new URL('../docker/rootfs/opt/tdc/region-options.json', import.meta.url), 'utf8'));
const inspect = `
  const fs=require('fs'), {execFileSync}=require('child_process');
  const exec=(name,args)=>execFileSync(name,args,{encoding:'utf8'}).trim();
  exec('tmux',['-L','region-qa','-f','/dev/null','new-session','-d','-s','qa','sleep','5']);
  const tmuxEnv=['TZ','LANG','LC_ALL'].map(key=>exec('tmux',['-L','region-qa','show-environment','-g',key]));
  exec('tmux',['-L','region-qa','kill-server']);
  console.log(JSON.stringify({
    tz:process.env.TZ, lang:process.env.LANG, lcAll:process.env.LC_ALL, language:process.env.LANGUAGE,
    timezone:fs.readFileSync('/etc/timezone','utf8').trim(), localtime:fs.readlinkSync('/etc/localtime'),
    offset:exec('date',['-d','@0','+%z']), charmap:exec('locale',['charmap']), locales:exec('locale',['-a']).split('\\n'),
    zones:require('/opt/tdc/region-options.json').timezones.every(z=>fs.existsSync('/usr/share/zoneinfo/'+z.value)), tmuxEnv
  }));
`;

for (const [timezone, locale, offset] of [['Asia/Shanghai', 'zh_CN.UTF-8', '+0800'], ['America/New_York', 'en_US.UTF-8', '-0500']]) {
  test(`container region: ${timezone}, ${locale}`, { skip: !image && 'Set TDC_REGION_TEST_IMAGE' }, () => {
    const name = `tdc-region-qa-${randomUUID().slice(0, 8)}`;
    const language = options.locales.find(l => l.value === locale).language;
    try {
      const run = spawnSync('docker', ['run', '--rm', '--name', name, '--network', 'none',
        '-e', `TZ=${timezone}`, '-e', `LANG=${locale}`, '-e', `LC_ALL=${locale}`, '-e', `LANGUAGE=${language}`,
        image, 'node', '-e', inspect], { encoding: 'utf8', timeout: 45000, windowsHide: true });
      assert.equal(run.status, 0, run.stderr);
      assert.doesNotMatch(run.stderr, /setlocale|Cannot set LC_/i);
      const actual = JSON.parse(run.stdout.trim().split('\n').at(-1));
      assert.equal(actual.tz, timezone);
      assert.equal(actual.timezone, timezone);
      assert.equal(actual.localtime, `/usr/share/zoneinfo/${timezone}`);
      assert.equal(actual.offset, offset);
      assert.equal(actual.lang, locale);
      assert.equal(actual.lcAll, locale);
      assert.equal(actual.language, language);
      assert.equal(actual.charmap, 'UTF-8');
      assert.equal(actual.zones, true);
      assert.deepEqual(actual.tmuxEnv, [`TZ=${timezone}`, `LANG=${locale}`, `LC_ALL=${locale}`]);
      for (const choice of options.locales) {
        assert.ok(actual.locales.includes(choice.value.replace('UTF-8', 'utf8')), `${choice.value} missing`);
      }
    } finally {
      spawnSync('docker', ['rm', '-f', name], { windowsHide: true, timeout: 10000, stdio: 'ignore' });
    }
  });
}
