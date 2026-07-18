import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAndValidateAttestation } from '../src/attestation.js';
import { sha256 } from '../src/verifier.js';
import { createRun, finishRun, loadRun, updateTaskState } from '../src/state.js';

async function writeAttestation(root, { taskId, runId = null, status = 'pass', tamper = false, dropDigest = false }) {
  const attestation = {
    schemaVersion: 1,
    verificationId: `${taskId}-verification`,
    taskId,
    runId,
    status,
    issuedAt: new Date().toISOString(),
    isolation: 'same-workspace',
    taskHash: sha256({ taskId }),
    claimHash: sha256({ claim: taskId }),
    changeEvidence: { status: 'verified', actualChangedFiles: [] },
    checks: [{ command: 'node --version', exitCode: 0, visibility: 'worker-visible' }]
  };
  attestation.evidenceDigest = sha256(attestation);
  if (tamper) attestation.status = 'pass';
  if (tamper) attestation.checks = [];
  if (dropDigest) delete attestation.evidenceDigest;
  const dir = path.join(root, 'task-runs', runId ?? 'manual', taskId);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'attestation.json');
  await writeFile(filePath, JSON.stringify(attestation, null, 2));
  return filePath;
}

test('loadAndValidateAttestation verifies digest, ids, and status binding', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-att-'));
  const good = await writeAttestation(root, { taskId: 'T1', runId: 'R1' });
  const loaded = await loadAndValidateAttestation(good, { taskId: 'T1', runId: 'R1', stateRoot: root });
  assert.equal(loaded.status, 'pass');
  assert.ok(loaded.evidenceDigest);

  await assert.rejects(
    () => loadAndValidateAttestation(good, { taskId: 'T2', runId: 'R1', stateRoot: root }),
    /taskId/i
  );
  await assert.rejects(
    () => loadAndValidateAttestation(good, { taskId: 'T1', runId: 'other-run', stateRoot: root }),
    /runId/i
  );

  const tampered = await writeAttestation(root, { taskId: 'T3', runId: 'R1', tamper: true });
  await assert.rejects(
    () => loadAndValidateAttestation(tampered, { taskId: 'T3', runId: 'R1', stateRoot: root }),
    /digest/i
  );

  const undigested = await writeAttestation(root, { taskId: 'T4', runId: 'R1', dropDigest: true });
  await assert.rejects(
    () => loadAndValidateAttestation(undigested, { taskId: 'T4', runId: 'R1', stateRoot: root }),
    /digest/i
  );
});

test('attestations outside the state root are rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-att-root-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'aorch-att-outside-'));
  const foreign = await writeAttestation(outside, { taskId: 'T1', runId: 'R1' });
  await assert.rejects(
    () => loadAndValidateAttestation(foreign, { taskId: 'T1', runId: 'R1', stateRoot: root }),
    /state root/i
  );
});

test('task completion cannot be recorded without a passing attestation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-att-state-'));
  const run = await createRun({ root, prompt: 'bind completion', runId: 'RBIND', tasks: [{ id: 'T1' }] });

  await assert.rejects(
    () => updateTaskState(run.path, 'T1', { status: 'complete' }),
    /attestation/i
  );

  const failPath = await writeAttestation(root, { taskId: 'T1', runId: 'RBIND', status: 'fail' });
  await assert.rejects(
    () => updateTaskState(run.path, 'T1', { status: 'complete', attestationPath: failPath }),
    /pass/i
  );

  const inconclusivePath = await writeAttestation(root, { taskId: 'T1', runId: 'RBIND', status: 'inconclusive' });
  await assert.rejects(
    () => updateTaskState(run.path, 'T1', { status: 'complete', attestationPath: inconclusivePath }),
    /pass/i
  );

  const passPath = await writeAttestation(root, { taskId: 'T1', runId: 'RBIND', status: 'pass' });
  const updated = await updateTaskState(run.path, 'T1', { status: 'complete', attestationPath: passPath });
  const task = updated.tasks.find((entry) => entry.id === 'T1');
  assert.equal(task.status, 'complete');
  assert.ok(task.attestationDigest);
  assert.ok(task.attestationVerifiedAt);
  assert.equal(path.isAbsolute(task.attestationPath), true);
});

test('a mismatched attestation cannot complete a different task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-att-mismatch-'));
  const run = await createRun({ root, prompt: 'mismatch', runId: 'RMIS', tasks: [{ id: 'T1' }, { id: 'T2' }] });
  const otherTaskAttestation = await writeAttestation(root, { taskId: 'T2', runId: 'RMIS' });
  await assert.rejects(
    () => updateTaskState(run.path, 'T1', { status: 'complete', attestationPath: otherTaskAttestation }),
    /taskId/i
  );
});

test('completed runs re-validate retained attestations and exempt skipped tasks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-att-finish-'));
  const run = await createRun({
    root, prompt: 'finish binding', runId: 'RFIN',
    tasks: [{ id: 'T1' }, { id: 'T2' }]
  });
  const passPath = await writeAttestation(root, { taskId: 'T1', runId: 'RFIN' });
  await updateTaskState(run.path, 'T1', { status: 'complete', attestationPath: passPath });
  await updateTaskState(run.path, 'T2', { status: 'skipped' });
  const finished = await finishRun(run.path, 'completed');
  assert.equal(finished.status, 'completed');

  const run2 = await createRun({ root, prompt: 'lost evidence', runId: 'RLOST', activate: false, tasks: [{ id: 'T1' }] });
  const lostPath = await writeAttestation(root, { taskId: 'T1', runId: 'RLOST' });
  await updateTaskState(run2.path, 'T1', { status: 'complete', attestationPath: lostPath });
  await rm(lostPath);
  await assert.rejects(() => finishRun(run2.path, 'completed'), /attestation/i);
});

test('runs cannot be created with pre-completed tasks lacking evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-att-precomplete-'));
  await assert.rejects(
    () => createRun({ root, prompt: 'pre-done', tasks: [{ id: 'T1', status: 'complete' }] }),
    /attestation/i
  );
  const run = await createRun({ root, prompt: 'pre-skip', tasks: [{ id: 'T1', status: 'skipped' }] });
  assert.equal((await loadRun(run.path)).tasks[0].status, 'skipped');
});
