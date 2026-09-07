import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const hook = path.resolve(here, '../integrations/shared/subagent-gate.mjs');

test('legacy subagent hook never blocks a model choice or spawns a classifier', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'aorch-gate-'));
  for (const input of [{ model: 'opus' }, {}, { model: 'haiku' }, { model: 'future-model' }]) {
    const result = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: 'Agent', tool_input: input }), cwd, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});
