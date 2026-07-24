import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const hook = path.resolve(here, '../integrations/shared/session-review.mjs');

async function projectWithRun({ status = 'completed' } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-session-review-'));
  const runDir = path.join(cwd, '.aorch/runs/R1');
  await mkdir(runDir, { recursive: true });
  const runPath = path.join(runDir, 'run.json');
  await writeFile(runPath, JSON.stringify({
    version: 1,
    id: 'R1',
    status,
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

test('Stop blocks when the active run is still running', async () => {
  const cwd = await projectWithRun({ status: 'running' });
  const result = invoke(cwd, { hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /run.*still running/i);
});

test('Stop allows a terminal run to finish', async () => {
  const cwd = await projectWithRun({ status: 'completed' });
  const result = invoke(cwd, { hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('Stop does not create a continuation loop when stop_hook_active is already true', async () => {
  const cwd = await projectWithRun({ status: 'running' });
  const result = invoke(cwd, { hook_event_name: 'Stop', stop_hook_active: true });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('non-Stop events pass through untouched', async () => {
  const cwd = await projectWithRun({ status: 'running' });
  const result = invoke(cwd, { hook_event_name: 'SessionEnd' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('worker subprocesses bypass lifecycle hooks', async () => {
  const cwd = await projectWithRun({ status: 'running' });
  const result = invoke(cwd, { hook_event_name: 'Stop', stop_hook_active: false }, { AORCH_WORKER: '1' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
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
