import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listDirectories } from '../../src-tauri/src/commands/container_directories.mjs';

test('directory picker: lists only directories and preserves spaces and non-ASCII paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdc-directory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, '项目 with spaces');
  fs.mkdirSync(directory);
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, 'private-file.txt'), 'never read this content');
  const listing = listDirectories(root);
  assert.deepEqual(new Set(listing.directories.map((entry) => entry.name)), new Set(['.hidden', '项目 with spaces']));
  assert.equal(listing.directories.find((entry) => entry.name === '项目 with spaces').path, directory);
  assert.equal(listDirectories(directory).parent, fs.realpathSync(root));
  assert.equal(listDirectories(directory).directories.length, 0);
  assert.ok(!JSON.stringify(listing).includes('never read this content'));
  assert.throws(() => listDirectories(path.join(root, 'missing')), /目录不存在/);
  assert.throws(() => listDirectories(path.join(root, 'private-file.txt')), /目录不存在/);
  assert.throws(() => listDirectories('relative/path'), /绝对路径/);
});
