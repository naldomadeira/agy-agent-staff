import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/bump-plugin-version.mjs', import.meta.url));
const manifests = [
  'package.json', '.agents/plugins/marketplace.json',
  '.claude-plugin/plugin.json', '.codex-plugin/plugin.json',
];

function fixture(versions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-release-version-'));
  for (const [index, name] of manifests.entries()) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `{"name":"agy","version":"${versions[index]}"}\n`);
  }
  return root;
}

test('bumps one patch and keeps all plugin manifests in sync', () => {
  const root = fixture(['0.10.1', '0.10.1', '0.10.1', '0.10.1']);
  const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '0.10.2');
  for (const name of manifests) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    assert.equal(manifest.version, '0.10.2');
  }
});

test('refuses inconsistent versions without changing any manifest', () => {
  const root = fixture(['0.10.1', '0.10.0', '0.10.1', '0.10.1']);
  const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /version mismatch/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, '0.10.1');
});
