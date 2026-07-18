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
    models: [], capabilities: []
  });
  assert.equal(result.status, 'pass');
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

import { runSubscriptionDoctor, inspectCodexAppEnforcement } from '../src/doctor.js';
import { validateConfig } from '../src/config.js';
import { mkdir } from 'node:fs/promises';

function subscriptionConfig() {
  return validateConfig({
    version: 1,
    routing: {},
    providers: [
      { id: 'anthropic', adapter: 'claude', enabled: true, executable: 'claude' },
      { id: 'openai', adapter: 'codex', enabled: true, executable: 'codex' }
    ],
    models: [],
    capabilities: [],
    progress: { intervalMinutes: 30 },
    paths: { stateDir: '.aorch' }
  });
}

test('subscription doctor reports logged-in claude and unknown codex without inventing status', () => {
  const calls = [];
  const exec = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'claude') return { status: 0, stdout: '{"loggedIn":true,"method":"claude.ai"}', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unrecognized subcommand' };
  };
  const report = runSubscriptionDoctor({
    config: subscriptionConfig(),
    env: { PATH: '/bin', HOME: '/home/u' },
    exec
  });
  assert.equal(report.providers.anthropic.auth.status, 'pass');
  assert.equal(report.providers.openai.auth.status, 'unknown');
  assert.equal(report.providers.anthropic.environment.status, 'pass');
  assert.equal(report.status, 'unknown');
  assert.ok(calls.some(([cmd]) => cmd === 'claude'));
});

test('subscription doctor fails closed on credential conflicts and login expiry', () => {
  const exec = (command) => (command === 'claude'
    ? { status: 1, stdout: '{"loggedIn":false}', stderr: '' }
    : { status: 0, stdout: 'Logged in using ChatGPT', stderr: '' });
  const report = runSubscriptionDoctor({
    config: subscriptionConfig(),
    env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-x' },
    exec
  });
  assert.equal(report.providers.anthropic.environment.status, 'fail');
  assert.equal(report.providers.anthropic.auth.status, 'fail');
  assert.match(report.providers.anthropic.auth.reason ?? '', /log ?in|not logged/i);
  assert.equal(report.providers.openai.auth.status, 'pass');
  assert.equal(report.status, 'fail');
});

test('subscription doctor treats a missing client executable as unknown, not authenticated', () => {
  const exec = () => { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }); };
  const report = runSubscriptionDoctor({
    config: subscriptionConfig(),
    env: { PATH: '/bin' },
    exec
  });
  assert.equal(report.providers.anthropic.auth.status, 'unknown');
  assert.equal(report.providers.openai.auth.status, 'unknown');
});

test('codex-app enforcement is unknown without evidence and never strict from docs alone', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-surface-'));
  const bare = await inspectCodexAppEnforcement({ root });
  assert.equal(bare.status, 'unknown');
  assert.equal(bare.evidencePath.endsWith(path.join('evidence', 'codex-app.json')), true);

  await mkdir(path.join(root, 'evidence'), { recursive: true });
  await writeFile(path.join(root, 'evidence', 'codex-app.json'), JSON.stringify([
    { kind: 'official-doc', detail: 'hooks framework documented', verifiedAt: '2026-07-18T00:00:00Z' }
  ]));
  const advisory = await inspectCodexAppEnforcement({ root });
  assert.equal(advisory.status, 'advisory');

  await writeFile(path.join(root, 'evidence', 'codex-app.json'), JSON.stringify([
    { kind: 'authenticated-fixture', detail: 'write tool intercepted', verifiedAt: '2026-07-18T00:00:00Z' }
  ]));
  const strict = await inspectCodexAppEnforcement({ root });
  assert.equal(strict.status, 'strict');
});

test('codex-app fixture evidence without a verification date cannot support strict', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-surface-undated-'));
  await mkdir(path.join(root, 'evidence'), { recursive: true });
  await writeFile(path.join(root, 'evidence', 'codex-app.json'), JSON.stringify([
    { kind: 'authenticated-fixture', detail: 'claimed but undated' }
  ]));
  const result = await inspectCodexAppEnforcement({ root });
  assert.notEqual(result.status, 'strict');
  assert.ok(result.warnings.length > 0);
});
