import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const hook = path.resolve(here, '../integrations/shared/session-review.mjs');

async function projectWithRun({ status = 'completed', reviewStatus = 'pending' } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-session-review-'));
  const runDir = path.join(cwd, '.aorch/runs/R1');
  await mkdir(runDir, { recursive: true });
  const runPath = path.join(runDir, 'run.json');
  await writeFile(runPath, JSON.stringify({
    version: 1,
    id: 'R1',
    status,
    reviewStatus,
    tasks: [{ id: 'T1', status: 'complete' }]
  }));
  await writeFile(path.join(cwd, '.aorch/active-run.json'), JSON.stringify({ runPath }));
  return cwd;
}

function invoke(cwd, input, env = {}) {
  return spawnSync(process.execPath, [hook], {
    cwd,
    input: JSON.stringify({ cwd, ...input }),
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

test('Stop requests a post-run reflection for a terminal unreviewed run', async () => {
  const cwd = await projectWithRun();
  const result = invoke(cwd, { hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /post-run-reflection/i);
  assert.match(output.reason, /user approval/i);
});

test('Stop does not create a continuation loop when stop_hook_active is already true', async () => {
  const cwd = await projectWithRun();
  const result = invoke(cwd, { hook_event_name: 'Stop', stop_hook_active: true });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('Stop allows a reviewed run to finish', async () => {
  const cwd = await projectWithRun({ reviewStatus: 'complete' });
  const result = invoke(cwd, { hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('SessionEnd records an unreviewed-run fallback event without trying to block exit', async () => {
  const cwd = await projectWithRun();
  const result = invoke(cwd, { hook_event_name: 'SessionEnd', reason: 'other', session_id: 'S1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  const log = await readFile(path.join(cwd, '.aorch/learning/unreviewed-sessions.jsonl'), 'utf8');
  assert.match(log, /"runId":"R1"/);
  assert.match(log, /"sessionId":"S1"/);
  assert.match(log, /"checksum":/);
});

test('worker subprocesses bypass lifecycle review hooks', async () => {
  const cwd = await projectWithRun();
  const result = invoke(cwd, { hook_event_name: 'Stop', stop_hook_active: false }, { AORCH_WORKER: '1' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('Stop requests continuation when an active run is still running', async () => {
  const cwd = await projectWithRun({ status: 'running', reviewStatus: 'not-ready' });
  const result = invoke(cwd, { hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /run.*still running/i);
});

test('Stop blocks when the active-run pointer targets a missing run instead of silently passing', async () => {
  const cwd = await projectWithRun();
  const { rm } = await import('node:fs/promises');
  await rm(path.join(cwd, '.aorch/runs/R1/run.json'));
  const result = invoke(cwd, { hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /could not be verified/i);
  assert.match(output.reason, /missing run state/i);
});
