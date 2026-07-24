import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectStateHealth, runDoctor } from '../src/doctor.js';

test('doctor fails overall when an enabled provider CLI is unavailable', () => {
  const result = runDoctor({
    providers: [{ id: 'missing', adapter: 'generic', executable: '/definitely/not/a/cli', enabled: true }],
    models: [], capabilities: []
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.providers[0].status, 'fail');
});

test('doctor passes with an available executable', () => {
  const result = runDoctor({
    providers: [{ id: 'node', adapter: 'generic', executable: process.execPath, enabled: true }],
    models: [], capabilities: []
  });
  assert.equal(result.status, 'pass');
});


test('doctor detects and repairs an invalid active-run pointer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-doctor-pointer-'));
  const pointer = path.join(root, 'active-run.json');
  await writeFile(pointer, JSON.stringify({ runPath: path.join(root, 'runs/missing/run.json') }));
  const unhealthy = await inspectStateHealth(root, { repair: false });
  assert.equal(unhealthy.status, 'fail');
  assert.equal(unhealthy.activeRun.status, 'fail');
  const repaired = await inspectStateHealth(root, { repair: true });
  assert.equal(repaired.status, 'pass');
  assert.equal(repaired.activeRun.repaired, true);
  await assert.rejects(() => readFile(pointer, 'utf8'), /ENOENT/);
});
