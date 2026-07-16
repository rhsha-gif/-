import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { executeTask } from '../src/task-runner.js';

const task = {
  id: 'T-e2e',
  objective: 'Inspect the bounded task execution path',
  kind: 'testing',
  role: 'executor',
  risk: 'low',
  write: false,
  weight: 2,
  allowedScope: [],
  forbiddenScope: [],
  acceptanceCriteria: ['worker returns a schema-valid receipt'],
  verificationCommands: ['node --version'],
  capabilityIds: []
};

test('routes, spawns a generic worker, validates its receipt, and persists evidence', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-e2e-'));
  const workerPath = path.join(cwd, 'fake-worker.mjs');
  await writeFile(workerPath, `
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const prompt = Buffer.concat(chunks).toString('utf8');
    if (!prompt.includes('T-e2e')) process.exit(9);
    process.stdout.write(JSON.stringify({
      status: 'complete',
      summary: 'The bounded execution path was inspected.',
      filesInspected: [],
      filesChanged: [],
      commands: [{ command: 'node --version', exitCode: 0, outcome: process.version }],
      criteria: [{ criterion: 'worker returns a schema-valid receipt', status: 'pass', evidence: 'valid JSON receipt emitted' }],
      unresolvedRisks: [],
      confidence: 0.9
    }));
  `);

  const config = {
    routing: { qualityTolerance: 0.01, tokenTolerance: 0.08 },
    providers: [{
      id: 'local-test', adapter: 'generic', enabled: true,
      executable: process.execPath, args: [workerPath]
    }],
    models: [{
      id: 'local-test-model', provider: 'local-test', model: 'fixture', enabled: true,
      roles: ['executor'], taskKinds: ['testing'], quality: { default: 0.9 },
      tokenIndex: 1, latencyIndex: 1, maturity: 'stable',
      efforts: [{ name: 'medium', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1 }]
    }],
    capabilities: [],
    progress: { intervalMinutes: 30 },
    paths: { stateDir: '.aorch' }
  };
  const progress = [];
  const result = await executeTask({ task, config, cwd, onProgress: (entry) => progress.push(entry) });

  assert.equal(result.route.provider, 'local-test');
  assert.equal(result.receipt.status, 'complete');
  assert.equal(result.attestation.status, 'pass');
  assert.equal(result.attestation.checks.length, 1);
  assert.equal(result.attestation.checks[0].exitCode, 0);
  assert.ok(result.attestationPath.endsWith('attestation.json'));
  assert.equal(JSON.parse(await readFile(result.receiptPath, 'utf8')).confidence, 0.9);
  assert.equal(progress[0].label, 'estimated');
  assert.equal(progress.at(-1).percent, 100);
  assert.equal(progress.at(-1).phase, 'complete');
  assert.equal(progress.at(-1).confidence, 'high');
  assert.ok(progress.at(-1).evidenceCount >= 2);
  assert.equal(JSON.parse(await readFile(result.attestationPath, 'utf8')).status, 'pass');
});

test('dry-run builds the route and command without mutating project state', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-dry-run-'));
  const stateRoot = path.join(cwd, '.aorch');
  const config = {
    routing: { qualityTolerance: 0.01, tokenTolerance: 0.08 },
    providers: [{ id: 'local-test', adapter: 'generic', enabled: true, executable: process.execPath, args: ['-e', ''] }],
    models: [{
      id: 'local-test-model', provider: 'local-test', model: 'fixture', enabled: true,
      roles: ['executor'], taskKinds: ['testing'], quality: { default: 0.9 },
      tokenIndex: 1, latencyIndex: 1, maturity: 'stable',
      efforts: [{ name: 'medium', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1 }]
    }],
    capabilities: [], progress: { intervalMinutes: 30 }, paths: { stateDir: '.aorch' }
  };
  const result = await executeTask({ task, config, cwd, stateRoot, dryRun: true });
  assert.equal(result.commandSpec.command, process.execPath);
  await assert.rejects(() => access(result.runDir), /ENOENT/);
});


test('rejects a worker success claim when independent verification fails', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-verification-fail-'));
  const workerPath = path.join(cwd, 'fake-worker.mjs');
  const command = `${process.execPath} -e "process.exit(7)"`;
  const receipt = {
    status: 'complete',
    summary: 'Claimed success.',
    filesInspected: [],
    filesChanged: [],
    commands: [{ command, exitCode: 0, outcome: 'claimed pass' }],
    criteria: [{ criterion: 'independent verification detects false success', status: 'pass', evidence: 'claimed evidence' }],
    unresolvedRisks: [],
    confidence: 0.99
  };
  await writeFile(workerPath, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(receipt))}));`);
  const failingTask = {
    ...task,
    id: 'T-false-success',
    acceptanceCriteria: ['independent verification detects false success'],
    verificationCommands: [command]
  };
  const config = {
    routing: { qualityTolerance: 0.01, tokenTolerance: 0.08 },
    providers: [{ id: 'local-test', adapter: 'generic', enabled: true, executable: process.execPath, args: [workerPath] }],
    models: [{
      id: 'local-test-model', provider: 'local-test', model: 'fixture', enabled: true,
      roles: ['executor'], taskKinds: ['testing'], quality: { default: 0.9 },
      tokenIndex: 1, latencyIndex: 1, maturity: 'stable',
      efforts: [{ name: 'medium', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1 }]
    }],
    capabilities: [], progress: { intervalMinutes: 30 }, paths: { stateDir: '.aorch' }
  };

  const progress = [];
  await assert.rejects(() => executeTask({
    task: failingTask,
    config,
    cwd,
    onProgress: (entry) => progress.push(entry)
  }), /independent verification failed/i);
  assert.equal(progress.at(-1).phase, 'failed');
  assert.equal(progress.at(-1).confidence, 'low');
  assert.match(progress.at(-1).blockers[0].message, /independent verification failed/i);
});

test('partial worker outcomes are reported as partial rather than still executing', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-partial-'));
  const workerPath = path.join(cwd, 'fake-worker.mjs');
  const partialReceipt = {
    status: 'partial',
    summary: 'Some evidence was gathered, but the task remains incomplete.',
    filesInspected: [],
    filesChanged: [],
    commands: [],
    criteria: [{
      criterion: 'worker returns a schema-valid receipt',
      status: 'not-run',
      evidence: 'verification was not completed'
    }],
    unresolvedRisks: ['Required verification is still pending.'],
    confidence: 0.4
  };
  await writeFile(workerPath, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(partialReceipt))}));`);
  const config = {
    routing: { qualityTolerance: 0.01, tokenTolerance: 0.08 },
    providers: [{ id: 'local-test', adapter: 'generic', enabled: true, executable: process.execPath, args: [workerPath] }],
    models: [{
      id: 'local-test-model', provider: 'local-test', model: 'fixture', enabled: true,
      roles: ['executor'], taskKinds: ['testing'], quality: { default: 0.9 },
      tokenIndex: 1, latencyIndex: 1, maturity: 'stable',
      efforts: [{ name: 'medium', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1 }]
    }],
    capabilities: [], progress: { intervalMinutes: 30 }, paths: { stateDir: '.aorch' }
  };
  const progress = [];
  const result = await executeTask({ task, config, cwd, onProgress: (entry) => progress.push(entry) });
  assert.equal(result.receipt.status, 'partial');
  assert.equal(result.attestation, null);
  assert.equal(progress.at(-1).phase, 'partial');
  assert.equal(progress.at(-1).percent, 75);
  assert.match(progress.at(-1).blockers[0].message, /verification is still pending/i);
});

test('write workers require an isolated worktree unless low or standard risk is explicitly authorized in place', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git unavailable');
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-write-isolation-'));
  spawnSync('git', ['init', '-q'], { cwd });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd });
  await writeFile(path.join(cwd, 'tracked.txt'), 'baseline\n');
  spawnSync('git', ['add', '.'], { cwd });
  spawnSync('git', ['commit', '-qm', 'baseline'], { cwd });

  const workerPath = path.join(cwd, 'fake-worker.mjs');
  const partialReceipt = {
    status: 'partial', summary: 'No write was attempted.', filesInspected: [], filesChanged: [], commands: [],
    criteria: [{ criterion: 'write isolation is enforced', status: 'not-run', evidence: 'isolation gate' }],
    unresolvedRisks: ['No write was attempted.'], confidence: 0.2
  };
  await writeFile(workerPath, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(partialReceipt))}));`);
  const config = {
    routing: { qualityTolerance: 0.01, tokenTolerance: 0.08 },
    providers: [{ id: 'local-test', adapter: 'generic', enabled: true, executable: process.execPath, args: [workerPath] }],
    models: [{
      id: 'local-test-model', provider: 'local-test', model: 'fixture', enabled: true,
      roles: ['executor'], taskKinds: ['testing'], quality: { default: 0.9 },
      tokenIndex: 1, latencyIndex: 1, maturity: 'stable',
      efforts: [{ name: 'medium', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1 }]
    }],
    capabilities: [], progress: { intervalMinutes: 30 }, paths: { stateDir: '.aorch' }
  };
  const writeTask = {
    ...task,
    id: 'T-write-isolation',
    write: true,
    allowedScope: ['tracked.txt'],
    acceptanceCriteria: ['write isolation is enforced']
  };

  await assert.rejects(() => executeTask({ task: writeTask, config, cwd }), /isolated linked worktree|in-place write/i);
  const allowed = await executeTask({ task: { ...writeTask, allowInPlaceWrite: true }, config, cwd, onProgress: () => {} });
  assert.equal(allowed.receipt.status, 'partial');
  await assert.rejects(() => executeTask({
    task: { ...writeTask, risk: 'high', complexity: 'high', allowInPlaceWrite: true },
    config,
    cwd
  }), /high-risk.*worktree|worktree.*high-risk/i);
});
