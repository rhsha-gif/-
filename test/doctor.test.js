import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendJournalRecord } from '../src/file-store.js';
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
    models: [{ id: 'm', provider: 'node', model: 'fixture', enabled: true }], capabilities: []
  });
  assert.equal(result.status, 'pass');
});

test('doctor fails a catalog with no enabled providers or models', () => {
  const noModels = runDoctor({
    providers: [{ id: 'node', adapter: 'generic', executable: process.execPath, enabled: true }],
    models: [], capabilities: []
  });
  assert.equal(noModels.status, 'fail');
  assert.equal(noModels.catalog.status, 'fail');
  assert.ok(noModels.catalog.issues.some((issue) => /no enabled models/.test(issue)));

  const noProviders = runDoctor({ providers: [], models: [], capabilities: [] });
  assert.equal(noProviders.status, 'fail');
  assert.ok(noProviders.catalog.issues.some((issue) => /no enabled providers/.test(issue)));
});


test('doctor state health can repair a partial JSONL tail', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-doctor-state-'));
  const file = path.join(root, 'observations.jsonl');
  await appendJournalRecord(file, { ok: true });
  await appendFile(file, '{partial');
  const unhealthy = await inspectStateHealth(root, { repair: false });
  assert.equal(unhealthy.status, 'fail');
  const repaired = await inspectStateHealth(root, { repair: true });
  assert.equal(repaired.status, 'pass');
  assert.equal(repaired.repairedJournals, 1);
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
