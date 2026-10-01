#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const names = [
  'package.json', '.agents/plugins/marketplace.json',
  '.claude-plugin/plugin.json', '.codex-plugin/plugin.json',
];

try {
  const files = names.map((name) => {
    const file = path.join(root, name);
    const text = fs.readFileSync(file, 'utf8');
    return { file, text, version: JSON.parse(text).version };
  });
  const current = files[0].version;
  if (!files.every(({ version }) => version === current)) throw new Error('plugin version mismatch between manifests');
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) throw new Error(`unsupported plugin version: ${current}`);
  const next = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
  const updates = files.map(({ file, text }) => {
    const updated = text.replace(/("version"\s*:\s*")[^"]+(")/, (_whole, prefix, suffix) => prefix + next + suffix);
    if (updated === text) throw new Error(`version field missing in ${file}`);
    return { file, updated };
  });
  for (const { file, updated } of updates) fs.writeFileSync(file, updated);
  process.stdout.write(`${next}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
