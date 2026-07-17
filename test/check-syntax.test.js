import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = path.join(root, 'scripts/check-syntax.mjs');

test('syntax checking remains bounded across repeated release verification', { timeout: 90_000 }, () => {
  for (let iteration = 1; iteration <= 6; iteration += 1) {
    const result = spawnSync(process.execPath, [checker], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000
    });
    assert.equal(
      result.status,
      0,
      `syntax check iteration ${iteration} did not finish cleanly: ${result.error?.message ?? result.stderr}`
    );
    assert.match(result.stdout, /Checked \d+ source files and \d+ JSON files/);
  }
});
