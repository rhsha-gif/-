import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureWorkspaceState, inspectWorkspaceIsolation, verifyTaskClaim } from '../src/verifier.js';

const baseTask = {
  id: 'T-verify', objective: 'Verify a worker claim', kind: 'testing', role: 'executor',
  risk: 'low', complexity: 'low', write: false, allowedScope: [], forbiddenScope: [],
  acceptanceCriteria: ['claim is independently verified'],
  verificationCommands: ['node --version'],
  verifierCommands: [`${process.execPath} -e "process.exit(0)"`]
};

const receipt = {
  status: 'complete', summary: 'Claimed complete.', filesInspected: [], filesChanged: [],
  commands: [{ command: 'node --version', exitCode: 0, outcome: process.version }],
  criteria: [{ criterion: 'claim is independently verified', status: 'pass', evidence: 'worker claim' }],
  unresolvedRisks: [], confidence: 0.9
};

test('verifier issues a separate hashed attestation for visible and hidden checks', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-verifier-'));
  const runDir = path.join(cwd, '.aorch/task-runs/R/T-verify');
  const before = await captureWorkspaceState(cwd);
  const attestation = await verifyTaskClaim({
    task: baseTask, receipt, cwd, runDir, beforeState: before, afterState: before,
    timeoutMs: 5000, isolationMode: 'same-workspace'
  });

  assert.equal(attestation.status, 'pass');
  assert.equal(attestation.schemaVersion, 1);
  assert.equal(attestation.checks.length, 2);
  assert.equal(attestation.checks.filter((entry) => entry.visibility === 'hidden').length, 1);
  assert.match(attestation.claimHash, /^[a-f0-9]{64}$/);
  assert.match(attestation.evidenceDigest, /^[a-f0-9]{64}$/);
  const persisted = JSON.parse(await readFile(attestation.path, 'utf8'));
  assert.equal(persisted.verificationId, attestation.verificationId);
});

test('verifier persists a failed attestation before rejecting a false claim', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-verifier-fail-'));
  const runDir = path.join(cwd, '.aorch/task-runs/R/T-verify');
  const failingTask = { ...baseTask, verifierCommands: [`${process.execPath} -e "process.exit(7)"`] };
  await assert.rejects(() => verifyTaskClaim({
    task: failingTask, receipt, cwd, runDir, timeoutMs: 5000, isolationMode: 'same-workspace'
  }), /verifier check failed/i);
  const index = JSON.parse(await readFile(path.join(runDir, 'verification-latest.json'), 'utf8'));
  const failed = JSON.parse(await readFile(index.attestationPath, 'utf8'));
  assert.equal(failed.status, 'fail');
  assert.equal(failed.checks.at(-1).exitCode, 7);
});

test('verifier detects actual git changes omitted from a worker claim', async (t) => {
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git unavailable');
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-verifier-git-'));
  spawnSync('git', ['init', '-q'], { cwd });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd });
  await writeFile(path.join(cwd, 'tracked.txt'), 'before\n');
  spawnSync('git', ['add', '.'], { cwd });
  spawnSync('git', ['commit', '-qm', 'baseline'], { cwd });
  const before = await captureWorkspaceState(cwd);
  await writeFile(path.join(cwd, 'tracked.txt'), 'after\n');
  const after = await captureWorkspaceState(cwd);

  await assert.rejects(() => verifyTaskClaim({
    task: { ...baseTask, write: true, allowedScope: ['tracked.txt'] },
    receipt: { ...receipt, filesChanged: [] }, cwd, runDir: path.join(cwd, '.aorch/run'),
    beforeState: before, afterState: after, isolationMode: 'same-workspace'
  }), /worker claim does not match actual changes/i);
});

test('write claims fail closed when Git change evidence is unavailable', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-verifier-no-git-'));
  const state = await captureWorkspaceState(cwd);
  await assert.rejects(() => verifyTaskClaim({
    task: { ...baseTask, write: true, allowedScope: ['tracked.txt'] },
    receipt: { ...receipt, filesChanged: [] },
    cwd,
    runDir: path.join(cwd, '.aorch/run'),
    beforeState: state,
    afterState: state,
    isolationMode: 'same-workspace'
  }), /write-task claims require before\/after workspace snapshots/i);
});

test('bounded workers cannot change Git HEAD to hide committed changes', async (t) => {
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git unavailable');
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-verifier-head-'));
  spawnSync('git', ['init', '-q'], { cwd });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd });
  await writeFile(path.join(cwd, 'tracked.txt'), 'before\n');
  spawnSync('git', ['add', '.'], { cwd });
  spawnSync('git', ['commit', '-qm', 'baseline'], { cwd });
  const before = await captureWorkspaceState(cwd);
  await writeFile(path.join(cwd, 'tracked.txt'), 'after\n');
  spawnSync('git', ['add', 'tracked.txt'], { cwd });
  spawnSync('git', ['commit', '-qm', 'worker commit'], { cwd });
  const after = await captureWorkspaceState(cwd);

  await assert.rejects(() => verifyTaskClaim({
    task: { ...baseTask, write: true, allowedScope: ['tracked.txt'] },
    receipt: { ...receipt, filesChanged: ['tracked.txt'] },
    cwd,
    runDir: path.join(cwd, '.aorch/run'),
    beforeState: before,
    afterState: after,
    isolationMode: 'same-workspace'
  }), /changed Git HEAD|commits are not allowed/i);
});

test('git-worktree verifier replays the post-worker tree in an isolated workspace', async (t) => {
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git unavailable');
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-verifier-worktree-'));
  spawnSync('git', ['init', '-q'], { cwd });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd });
  await writeFile(path.join(cwd, 'tracked.txt'), 'before\n');
  spawnSync('git', ['add', '.'], { cwd });
  spawnSync('git', ['commit', '-qm', 'baseline'], { cwd });
  const before = await captureWorkspaceState(cwd);
  await writeFile(path.join(cwd, 'tracked.txt'), 'after\n');
  const after = await captureWorkspaceState(cwd);
  const command = `${process.execPath} -e "const fs=require('fs');if(fs.readFileSync('tracked.txt','utf8')!=='after\\n')process.exit(7)"`;
  const task = {
    ...baseTask,
    write: true,
    allowedScope: ['tracked.txt'],
    acceptanceCriteria: ['isolated verifier sees the changed tree'],
    verificationCommands: [command],
    verifierCommands: []
  };
  const claim = {
    ...receipt,
    filesChanged: ['tracked.txt'],
    commands: [{ command, exitCode: 0, outcome: 'claimed pass' }],
    criteria: [{ criterion: 'isolated verifier sees the changed tree', status: 'pass', evidence: 'worker claim' }]
  };

  const attestation = await verifyTaskClaim({
    task,
    receipt: claim,
    cwd,
    runDir: path.join(cwd, '.aorch/run'),
    beforeState: before,
    afterState: after,
    isolationMode: 'git-worktree'
  });
  assert.equal(attestation.status, 'pass');
  assert.equal(attestation.isolation, 'git-worktree');
  assert.equal(attestation.checks[0].exitCode, 0);
});

test('workspace isolation inspection distinguishes the primary checkout from a linked worktree', async (t) => {
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git unavailable');
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-isolation-inspect-'));
  spawnSync('git', ['init', '-q'], { cwd });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd });
  await writeFile(path.join(cwd, 'tracked.txt'), 'baseline\n');
  spawnSync('git', ['add', '.'], { cwd });
  spawnSync('git', ['commit', '-qm', 'baseline'], { cwd });
  const linked = path.join(await mkdtemp(path.join(os.tmpdir(), 'aorch-linked-parent-')), 'worktree');
  const add = spawnSync('git', ['worktree', 'add', '--detach', linked, 'HEAD'], { cwd, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);
  try {
    assert.equal((await inspectWorkspaceIsolation(cwd)).linkedWorktree, false);
    assert.equal((await inspectWorkspaceIsolation(linked)).linkedWorktree, true);
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', linked], { cwd });
  }
});
