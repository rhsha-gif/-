import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAllocation } from '../src/allocation.js';
import { validateConfig } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = validateConfig(JSON.parse(await readFile(path.join(root, 'config/aorch.config.json'), 'utf8')));

test('allocation loads the shipped example and is absent without a file', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'aorch-alloc-'));
  assert.equal(await loadAllocation({ catalog, homeDir }), null);
  await writeFile(path.join(homeDir, 'allocation.json'), await readFile(path.join(root, 'examples/allocation.json'), 'utf8'));
  const loaded = await loadAllocation({ catalog, homeDir });
  assert.deepEqual(loaded.rules.map((rule) => rule.id), ['grunt-to-flash', 'opus-standard']);
});

test('allocation fails closed with the file path on any malformed input', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'aorch-alloc-'));
  const rule = { id: 'r', match: { kinds: ['testing'] }, prefer: ['agy-flash'] };
  const cases = [
    ['{not json', /allocation .*allocation\.json/],
    [{ version: 2, rules: [] }, /version must be 1/],
    [{ version: 1, rules: [], extra: true }, /unknown key/],
    [{ version: 1, rules: [{ ...rule, prefer: ['ghost-profile'] }] }, /does not name a catalog profile/],
    [{ version: 1, rules: [{ ...rule, prefer: ['agy-flash:ultra'] }] }, /has no effort ultra/],
    [{ version: 1, rules: [rule, rule] }, /duplicate rule id/],
    [{ version: 1, rules: [{ ...rule, match: { risks: ['low'] } }] }, /unknown key/],
    [{ version: 1, rules: [{ ...rule, match: { complexities: ['huge'] } }] }, /unknown value/]
  ];
  for (const [input, pattern] of cases) {
    await writeFile(path.join(homeDir, 'allocation.json'), typeof input === 'string' ? input : JSON.stringify(input));
    await assert.rejects(loadAllocation({ catalog, homeDir }), pattern, JSON.stringify(input));
  }
});
