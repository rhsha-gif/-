import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createRun,
  finishRun,
  loadRun,
  resolveActiveRun,
  updateTaskState
} from '../src/state.js';
import { sha256 } from '../src/verifier.js';

async function writePassingAttestation(root, { taskId, runId }) {
  const attestation = {
    schemaVersion: 1,
    verificationId: `${taskId}-verification`,
    taskId,
    runId,
    status: 'pass',
    issuedAt: new Date().toISOString(),
    isolation: 'same-workspace',
    taskHash: sha256({ taskId }),
    claimHash: sha256({ claim: taskId }),
    changeEvidence: { status: 'verified', actualChangedFiles: [] },
    checks: [{ command: 'node --version', exitCode: 0, visibility: 'worker-visible' }]
  };
  attestation.evidenceDigest = sha256(attestation);
  const dir = path.join(root, 'task-runs', runId, taskId);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'attestation.json');
  await writeFile(filePath, JSON.stringify(attestation, null, 2));
  return filePath;
}

test('run state is durable and progress-relevant fields survive updates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-state-'));
  const run = await createRun({ root, prompt: 'build it', tasks: [{ id: 'T1', weight: 2, status: 'pending' }] });
  await updateTaskState(run.path, 'T1', { status: 'running', fraction: 0.4 });
  const loaded = await loadRun(run.path);
  assert.equal(loaded.tasks[0].status, 'running');
  assert.equal(loaded.tasks[0].fraction, 0.4);
  assert.equal((await resolveActiveRun(root)).path, run.path);
});

test('finishing a run creates a pending review gate', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-state-finish-'));
  const run = await createRun({ root, prompt: 'build it', tasks: [] });
  const finished = await finishRun(run.path, 'completed');
  assert.equal(finished.status, 'completed');
  assert.equal(finished.reviewStatus, 'pending');
  assert.ok(finished.finishedAt);
});

test('rejects unsafe run ids and refuses to overwrite an unfinished active run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-state-guard-'));
  await assert.rejects(
    () => createRun({ root, prompt: 'unsafe', runId: '../escape', tasks: [] }),
    /path-safe/i
  );

  const first = await createRun({ root, prompt: 'first', runId: 'R1', tasks: [] });
  await assert.rejects(
    () => createRun({ root, prompt: 'second', runId: 'R2', tasks: [] }),
    /active run.*running/i
  );

  await finishRun(first.path, 'completed');
  await assert.rejects(
    () => createRun({ root, prompt: 'second', runId: 'R2', tasks: [] }),
    /reflection/i
  );
});

test('completed runs require successful terminal task states', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-state-complete-'));
  const run = await createRun({ root, prompt: 'build it', runId: 'RSC', tasks: [{ id: 'T1', status: 'running', fraction: 0.5 }] });
  await assert.rejects(() => finishRun(run.path, 'completed'), /unfinished tasks.*T1/i);
  const attestationPath = await writePassingAttestation(root, { taskId: 'T1', runId: 'RSC' });
  await updateTaskState(run.path, 'T1', { status: 'complete', fraction: 1, attestationPath });
  const finished = await finishRun(run.path, 'completed');
  assert.equal(finished.status, 'completed');
});

test('task updates validate status and fraction', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-state-task-validation-'));
  const run = await createRun({ root, prompt: 'build it', tasks: [{ id: 'T1' }] });
  await assert.rejects(() => updateTaskState(run.path, 'T1', { status: 'mystery' }), /task status/i);
  await assert.rejects(() => updateTaskState(run.path, 'T1', { status: 'running', fraction: 2 }), /fraction/i);
});


test('concurrent updates to different tasks do not overwrite each other', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-state-concurrent-'));
  const run = await createRun({
    root,
    prompt: 'parallel updates',
    tasks: [{ id: 'T1' }, { id: 'T2' }]
  });
  await Promise.all([
    updateTaskState(run.path, 'T1', { status: 'running', fraction: 0.25 }),
    updateTaskState(run.path, 'T2', { status: 'running', fraction: 0.75 })
  ]);
  const loaded = await loadRun(run.path);
  assert.equal(loaded.tasks.find((task) => task.id === 'T1').fraction, 0.25);
  assert.equal(loaded.tasks.find((task) => task.id === 'T2').fraction, 0.75);
});

test('task patches cannot rewrite identity or weight and terminal runs reject updates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-state-patch-guard-'));
  const run = await createRun({ root, prompt: 'guard', runId: 'RPG', tasks: [{ id: 'T1', weight: 2 }, { id: 'T2', weight: 1 }] });
  await assert.rejects(
    () => updateTaskState(run.path, 'T1', { status: 'running', id: 'T2', weight: -3 }),
    /cannot modify: id, weight/
  );
  await updateTaskState(run.path, 'T1', {
    status: 'complete', attestationPath: await writePassingAttestation(root, { taskId: 'T1', runId: 'RPG' })
  });
  await updateTaskState(run.path, 'T2', {
    status: 'complete', attestationPath: await writePassingAttestation(root, { taskId: 'T2', runId: 'RPG' })
  });
  await finishRun(run.path, 'completed');
  await assert.rejects(
    () => updateTaskState(run.path, 'T1', { status: 'running' }),
    /terminal run/i
  );
});

test('an active-run pointer escaping the state root is rejected', async () => {
  const { atomicWriteJson } = await import('../src/file-store.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-state-escape-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'aorch-state-outside-'));
  const foreignRun = path.join(outside, 'run.json');
  await atomicWriteJson(foreignRun, { version: 1, id: 'EVIL', status: 'running', tasks: [] });
  await atomicWriteJson(path.join(root, 'active-run.json'), { runPath: foreignRun });
  await assert.rejects(() => resolveActiveRun(root), /outside state root/i);
});

test('run creation enforces a bounded task budget', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-state-task-budget-'));
  const tasks = Array.from({ length: 3 }, (_, index) => ({ id: `T${index + 1}` }));
  await assert.rejects(
    () => createRun({ root, prompt: 'too many tasks', tasks, maxTasks: 2 }),
    /task budget|maximum.*2|too many tasks/i
  );
  const run = await createRun({ root, prompt: 'within budget', tasks: tasks.slice(0, 2), maxTasks: 2 });
  assert.equal(run.tasks.length, 2);
});
