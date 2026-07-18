import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { executeTask } from '../src/task-runner.js';
import { createRun, finishRun } from '../src/state.js';
import { decideProposal, loadRetrospective, saveRetrospective } from '../src/learning.js';

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

test('a non-complete receipt cannot hide actual workspace mutations', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git unavailable');
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-lying-partial-'));
  spawnSync('git', ['init', '-q'], { cwd });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd });
  await writeFile(path.join(cwd, 'tracked.txt'), 'baseline\n');
  const workerPath = path.join(cwd, 'fake-worker.mjs');
  const lyingReceipt = {
    status: 'partial', summary: 'Nothing was changed.', filesInspected: [], filesChanged: [], commands: [],
    criteria: [{ criterion: 'claims match evidence', status: 'not-run', evidence: 'pending' }],
    unresolvedRisks: ['incomplete'], confidence: 0.3
  };
  await writeFile(workerPath, `
    import { writeFile } from 'node:fs/promises';
    process.stdin.resume();
    process.stdin.on('end', async () => {
      await writeFile('tracked.txt', 'mutated by worker\\n');
      process.stdout.write(${JSON.stringify(JSON.stringify(lyingReceipt))});
    });
  `);
  spawnSync('git', ['add', '.'], { cwd });
  spawnSync('git', ['commit', '-qm', 'baseline'], { cwd });
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
  const lyingTask = {
    ...task,
    id: 'T-lying-partial',
    write: true,
    allowInPlaceWrite: true,
    allowedScope: ['tracked.txt'],
    acceptanceCriteria: ['claims match evidence']
  };
  await assert.rejects(
    () => executeTask({ task: lyingTask, config, cwd, onProgress: () => {} }),
    /does not match actual changes/i
  );
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

test('a complete claim with nothing verifiable yields an inconclusive attestation and low confidence', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-inconclusive-'));
  const workerPath = path.join(cwd, 'fake-worker.mjs');
  const unverifiableReceipt = {
    status: 'complete',
    summary: 'Claimed complete with no verifiable evidence.',
    filesInspected: [], filesChanged: [], commands: [],
    criteria: [{ criterion: 'nothing to verify', status: 'pass', evidence: 'worker assertion only' }],
    unresolvedRisks: [], confidence: 0.95
  };
  await writeFile(workerPath, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(unverifiableReceipt))}));`);
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
  const result = await executeTask({
    task: { ...task, id: 'T-unverifiable', verificationCommands: [], acceptanceCriteria: ['nothing to verify'] },
    config, cwd,
    onProgress: (entry) => progress.push(entry)
  });
  assert.equal(result.attestation.status, 'inconclusive');
  assert.equal(progress.at(-1).confidence, 'low');
});

test('single-worker lane delegates exactly one bounded worker invocation', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-single-worker-lane-'));
  const workerPath = path.join(cwd, 'fake-worker.mjs');
  const singleReceipt = {
    status: 'complete', summary: 'Single worker completed the bundled task.', filesInspected: [], filesChanged: [],
    commands: [{ command: 'node --version', exitCode: 0, outcome: process.version }],
    criteria: [{ criterion: 'single worker completes the task', status: 'pass', evidence: 'worker receipt' }],
    unresolvedRisks: [], confidence: 0.9
  };
  await writeFile(workerPath, `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify(singleReceipt))}));`);
  const singleTask = {
    ...task,
    id: 'T-single', kind: 'documentation', risk: 'low', complexity: 'low', write: false,
    acceptanceCriteria: ['single worker completes the task'], verificationCommands: ['node --version'],
    signature: {
      ambiguity: 'low', repositoryBreadth: 'local', editBreadth: 'none', contextVolume: 'small',
      toolIntensity: 'low', stateComplexity: 'none', testCoverage: 'good', externalIntegration: 'none'
    }
  };
  const config = {
    routing: { qualityTolerance: 0.01, tokenTolerance: 0.08, priorWeight: 3, uncertaintyPenalty: 0 },
    hostPolicy: { selectionMode: 'preferred', executionMode: 'bootstrap-only', allowHostProductEdits: false },
    lanePolicy: {
      'single-worker': { maxTasks: 1, maxExternalModelCalls: 1, maxLlmReviewers: 0 },
      bundled: { maxTasks: 2, maxExternalModelCalls: 1, maxLlmReviewers: 0 },
      orchestrated: { maxTasks: 24, maxExternalModelCalls: 12, maxLlmReviewers: 3 }
    },
    providers: [{ id: 'local-test', adapter: 'generic', enabled: true, executable: process.execPath, args: [workerPath] }],
    models: [{
      id: 'local-worker', provider: 'local-test', model: 'fixture', revision: 'fixture-r1', enabled: true,
      roles: ['executor'], taskKinds: ['documentation'], quality: { default: 0.9 }, tokenIndex: 1, latencyIndex: 1,
      maturity: 'stable', efforts: [{ name: 'medium', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1, complexities: ['low'] }]
    }],
    capabilities: [], progress: { intervalMinutes: 30 }, paths: { stateDir: '.aorch' }
  };
  const result = await executeTask({
    task: singleTask, config, cwd,
    host: { provider: 'local-test', requestedModel: 'fixture', resolvedModel: 'fixture', requestedEffort: 'medium', effectiveEffort: 'medium', selectionMode: 'preferred' },
    onProgress: () => {}
  });
  assert.equal(result.lane.lane, 'single-worker');
  assert.equal(result.route.execution, 'delegated');
  assert.equal(result.receipt.status, 'complete');
  assert.equal(result.modelUse.host.executionMode, 'bootstrap-only');
  assert.equal(result.modelUse.externalModelCalls, 1);
  assert.equal(result.modelUse.executor.execution, 'delegated');
});

test('delegated execution persists actual host, executor, prompt, shadow, and verifier trace events', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-task-trace-'));
  const workerPath = path.join(cwd, 'fake-worker.mjs');
  const traceReceipt = {
    status: 'complete', summary: 'Trace worker complete.', filesInspected: [], filesChanged: [],
    commands: [{ command: 'node --version', exitCode: 0, outcome: process.version }],
    criteria: [{ criterion: 'trace exists', status: 'pass', evidence: 'trace event' }], unresolvedRisks: [], confidence: 0.9
  };
  await writeFile(workerPath, `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify(traceReceipt))}));`);
  const config = {
    routing: { qualityTolerance: 0.02, tokenTolerance: 0.1, priorWeight: 3, uncertaintyPenalty: 0 },
    hostPolicy: { selectionMode: 'bootstrap-only', directExecutionWhenUnknown: false },
    lanePolicy: { direct: { maxTasks: 1, maxExternalModelCalls: 0, maxLlmReviewers: 0 }, bundled: { maxTasks: 2, maxExternalModelCalls: 1, maxLlmReviewers: 0 }, orchestrated: { maxTasks: 24, maxExternalModelCalls: 12, maxLlmReviewers: 3 } },
    providers: [
      { id: 'local-test', adapter: 'generic', enabled: true, executable: process.execPath, args: [workerPath] },
      { id: 'shadow-provider', adapter: 'generic', enabled: true, executable: process.execPath, args: [workerPath] }
    ],
    models: [
      { id: 'primary', provider: 'local-test', model: 'fixture', enabled: true, roles: ['executor'], taskKinds: ['testing'], quality: { default: 0.9 }, tokenIndex: 1, latencyIndex: 1, maturity: 'stable', efforts: [{ name: 'medium', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1 }] },
      { id: 'shadow', provider: 'shadow-provider', model: 'shadow-fixture', enabled: true, roles: ['executor'], taskKinds: ['testing'], quality: { default: 0.89 }, tokenIndex: 1, latencyIndex: 1, maturity: 'stable', efforts: [{ name: 'medium', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1 }] }
    ],
    capabilities: [], progress: { intervalMinutes: 30 }, paths: { stateDir: '.aorch' }
  };
  const result = await executeTask({
    task: { ...task, acceptanceCriteria: ['trace exists'] }, config, cwd, shadowMode: 'record-only',
    host: { provider: 'anthropic', requestedModel: 'sonnet', resolvedModel: 'sonnet', requestedEffort: 'high', effectiveEffort: 'high', selectionMode: 'bootstrap-only' },
    onProgress: () => {}
  });
  const { readTrace, summarizeTrace } = await import('../src/trace.js');
  const summary = summarizeTrace(await readTrace(result.tracePath));
  assert.equal(summary.host.resolvedModel, 'sonnet');
  assert.equal(summary.host.selectionMode, 'bootstrap-only');
  assert.equal(summary.host.executionMode, 'bootstrap-only');
  assert.equal(summary.externalModelCalls, 1);
  assert.equal(summary.executor.model, 'fixture');
  assert.equal(summary.shadow.execute, false);
  assert.equal(summary.shadow.evidenceStatus, 'counterfactual-only');
  assert.equal(summary.verification.status, 'pass');
  assert.equal(result.modelUse.executor.model, 'fixture');
});

test('persists redacted worker evidence while parsing the original bounded receipt', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-redacted-evidence-'));
  const secret = 'sk-test-abcdefghijklmnopqrstuvwxyz012345';
  const workerPath = path.join(cwd, 'fake-worker.mjs');
  await writeFile(workerPath, `
    process.stdin.resume();
    process.stdin.on('end', () => process.stdout.write(JSON.stringify({
      status: 'complete', summary: 'Authorization: Bearer ${secret}', filesInspected: [], filesChanged: [],
      commands: [{ command: 'node --version', exitCode: 0, outcome: process.version }],
      criteria: [{ criterion: 'worker returns a schema-valid receipt', status: 'pass', evidence: 'OPENAI_API_KEY=${secret}' }],
      unresolvedRisks: [], confidence: 0.9
    })));
  `);
  const config = {
    routing: { qualityTolerance: 0.01, tokenTolerance: 0.08 },
    execution: { workerTimeoutMs: 5000, killGraceMs: 30, maxOutputBytes: 1024 * 1024, maxReceiptBytes: 1024 * 1024 },
    verification: { commandTimeoutMs: 5000, totalTimeoutMs: 10000, maxOutputBytes: 1024 * 1024, maxChecks: 10, isolationByRisk: { low: 'same-workspace' } },
    providers: [{ id: 'local-test', adapter: 'generic', enabled: true, executable: process.execPath, args: [workerPath] }],
    models: [{ id: 'local-test-model', provider: 'local-test', model: 'fixture', enabled: true, roles: ['executor'], taskKinds: ['testing'], quality: { default: 0.9 }, tokenIndex: 1, latencyIndex: 1, maturity: 'stable', efforts: [{ name: 'medium', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1 }] }],
    capabilities: [], progress: { intervalMinutes: 30 }, paths: { stateDir: '.aorch' }
  };
  const result = await executeTask({ task, config, cwd, onProgress: () => {} });
  assert.match(result.receipt.summary, new RegExp(secret));
  const persisted = [
    await readFile(path.join(result.runDir, 'stdout.log'), 'utf8'),
    await readFile(path.join(result.runDir, 'receipt.json'), 'utf8'),
    await readFile(path.join(result.runDir, 'execution.json'), 'utf8')
  ].join('\n');
  assert.doesNotMatch(persisted, new RegExp(secret));
  assert.match(persisted, /REDACTED/);
});

test('task runner captures ignored evidence files in its before and after claim boundary', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git unavailable');
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-runner-evidence-file-'));
  spawnSync('git', ['init', '-q'], { cwd });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd });
  await writeFile(path.join(cwd, '.gitignore'), '.env\n.aorch/\n');
  await writeFile(path.join(cwd, 'tracked.txt'), 'baseline\n');
  await writeFile(path.join(cwd, '.env'), 'VALUE=before\n');
  spawnSync('git', ['add', '.gitignore', 'tracked.txt'], { cwd });
  spawnSync('git', ['commit', '-qm', 'baseline'], { cwd });
  const workerPath = path.join(cwd, 'worker.mjs');
  await writeFile(workerPath, `
    import { writeFile } from 'node:fs/promises';
    process.stdin.resume();
    process.stdin.on('end', async () => {
      await writeFile('.env', 'VALUE=after\\n');
      process.stdout.write(JSON.stringify({status:'complete',summary:'changed evidence',filesInspected:['.env'],filesChanged:['.env'],commands:[{command:'node --version',exitCode:0,outcome:process.version}],criteria:[{criterion:'ignored evidence is tracked',status:'pass',evidence:'changed'}],unresolvedRisks:[],confidence:0.9}));
    });
  `);
  const config = {
    routing: { qualityTolerance: 0.01, tokenTolerance: 0.08 },
    execution: { workerTimeoutMs: 5000, killGraceMs: 30, maxOutputBytes: 1024 * 1024, maxReceiptBytes: 1024 * 1024 },
    verification: { commandTimeoutMs: 5000, totalTimeoutMs: 10000, maxOutputBytes: 1024 * 1024, maxChecks: 10, isolationByRisk: { low: 'same-workspace' } },
    providers: [{ id: 'local-test', adapter: 'generic', enabled: true, executable: process.execPath, args: [workerPath] }],
    models: [{ id: 'local-test-model', provider: 'local-test', model: 'fixture', enabled: true, roles: ['executor'], taskKinds: ['testing'], quality: { default: 0.9 }, tokenIndex: 1, latencyIndex: 1, maturity: 'stable', efforts: [{ name: 'medium', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1 }] }],
    capabilities: [], progress: { intervalMinutes: 30 }, paths: { stateDir: '.aorch' }
  };
  const evidenceTask = { ...task, write: true, allowInPlaceWrite: true, allowedScope: ['.env'], evidenceFiles: ['.env'], acceptanceCriteria: ['ignored evidence is tracked'] };
  const result = await executeTask({ task: evidenceTask, config, cwd, onProgress: () => {} });
  assert.equal(result.attestation.status, 'pass');
  assert.deepEqual(result.attestation.changeEvidence.actualChangedFiles, ['.env']);
});

test('ordinary workers cannot mutate protected control-plane files even when they claim the change', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git unavailable');
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-protected-runner-'));
  spawnSync('git', ['init', '-q'], { cwd });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd });
  await writeFile(path.join(cwd, '.gitignore'), '.aorch/\n');
  await writeFile(path.join(cwd, 'tracked.txt'), 'baseline\n');
  spawnSync('git', ['add', '.gitignore', 'tracked.txt'], { cwd });
  spawnSync('git', ['commit', '-qm', 'baseline'], { cwd });
  await mkdir(path.join(cwd, '.aorch'), { recursive: true });
  await writeFile(path.join(cwd, '.aorch/config.json'), '{"before":true}\n');
  const workerPath = path.join(cwd, 'worker.mjs');
  await writeFile(workerPath, `
    import { mkdir, writeFile } from 'node:fs/promises';
    process.stdin.resume();
    process.stdin.on('end', async () => {
      await mkdir('.aorch', { recursive: true });
      await writeFile('.aorch/config.json', '{"after":true}\\n');
      process.stdout.write(JSON.stringify({status:'complete',summary:'changed config',filesInspected:['.aorch/config.json'],filesChanged:['.aorch/config.json'],commands:[{command:'node --version',exitCode:0,outcome:process.version}],criteria:[{criterion:'config changed',status:'pass',evidence:'changed'}],unresolvedRisks:[],confidence:0.9}));
    });
  `);
  const config = {
    routing: { qualityTolerance: 0.01, tokenTolerance: 0.08 },
    execution: { workerTimeoutMs: 5000, killGraceMs: 30, maxOutputBytes: 1024 * 1024, maxReceiptBytes: 1024 * 1024 },
    verification: { commandTimeoutMs: 5000, totalTimeoutMs: 10000, maxOutputBytes: 1024 * 1024, maxChecks: 10, isolationByRisk: { low: 'same-workspace' } },
    controlPlane: { protectedFiles: ['.aorch/config.json'] },
    providers: [{ id: 'local-test', adapter: 'generic', enabled: true, executable: process.execPath, args: [workerPath] }],
    models: [{ id: 'local-test-model', provider: 'local-test', model: 'fixture', enabled: true, roles: ['executor'], taskKinds: ['testing'], quality: { default: 0.9 }, tokenIndex: 1, latencyIndex: 1, maturity: 'stable', efforts: [{ name: 'medium', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1 }] }],
    capabilities: [], progress: { intervalMinutes: 30 }, paths: { stateDir: '.aorch' }
  };
  const protectedTask = { ...task, write: true, allowInPlaceWrite: true, allowedScope: ['.aorch/config.json'], acceptanceCriteria: ['config changed'] };
  await assert.rejects(() => executeTask({ task: protectedTask, config, cwd, onProgress: () => {} }), /protected control-plane files/i);
});

test('an approved control-plane proposal is consumed only after passing independent verification', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git unavailable');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-approved-control-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  await writeFile(path.join(root, '.gitignore'), '.aorch/\n');
  await writeFile(path.join(root, 'tracked.txt'), 'baseline\n');
  spawnSync('git', ['add', '.gitignore', 'tracked.txt'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
  const cwd = path.join(root, 'linked');
  const added = spawnSync('git', ['worktree', 'add', '-q', '-b', 'control-test', cwd], { cwd: root, encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);
  await mkdir(path.join(cwd, '.aorch'), { recursive: true });
  await writeFile(path.join(cwd, '.aorch/config.json'), '{"before":true}\n');

  const stateRoot = path.join(cwd, '.aorch');
  const sourceRun = await createRun({ root: stateRoot, prompt: 'approve config change', tasks: [] });
  await finishRun(sourceRun.path, 'completed');
  await saveRetrospective({ root: stateRoot, runPath: sourceRun.path, input: {
    runId: sourceRun.id, outcome: 'completed', summary: 'Approve one config change.', whatWorked: [], errors: [], inefficiencies: [], technicalDebt: [],
    proposals: [{ id: 'P-control', category: 'routing', title: 'Change config', rationale: 'Needed for routing.', expectedBenefit: 'Correct route.', risks: ['Config regression.'], affectedFiles: ['.aorch/config.json'] }]
  } });
  await decideProposal({ root: stateRoot, runId: sourceRun.id, proposalId: 'P-control', decision: 'approved' });

  const workerPath = path.join(root, 'worker.mjs');
  await writeFile(workerPath, `
    import { mkdir, writeFile } from 'node:fs/promises';
    process.stdin.resume();
    process.stdin.on('end', async () => {
      await mkdir('.aorch', { recursive: true });
      await writeFile('.aorch/config.json', '{"after":true}\\n');
      process.stdout.write(JSON.stringify({status:'complete',summary:'changed approved config',filesInspected:['.aorch/config.json'],filesChanged:['.aorch/config.json'],commands:[{command:'node --version',exitCode:0,outcome:process.version}],criteria:[{criterion:'approved config changes',status:'pass',evidence:'changed'}],unresolvedRisks:[],confidence:0.9}));
    });
  `);
  const config = {
    routing: { qualityTolerance: 0.01, tokenTolerance: 0.08 },
    execution: { workerTimeoutMs: 5000, killGraceMs: 30, maxOutputBytes: 1024 * 1024, maxReceiptBytes: 1024 * 1024 },
    verification: { commandTimeoutMs: 5000, totalTimeoutMs: 10000, maxOutputBytes: 1024 * 1024, maxChecks: 10, isolationByRisk: { critical: 'git-worktree' } },
    controlPlane: { protectedFiles: ['.aorch/config.json'], providerTrustByRisk: { critical: ['trusted'] }, capabilityTrustByRisk: { critical: ['trusted'] } },
    providers: [{ id: 'local-test', adapter: 'generic', enabled: true, executable: process.execPath, args: [workerPath], trustTier: 'trusted', adapterMaturity: 'stable' }],
    models: [{ id: 'local-test-model', provider: 'local-test', model: 'fixture', enabled: true, roles: ['executor'], taskKinds: ['testing'], quality: { default: 0.99 }, tokenIndex: 1, latencyIndex: 1, maturity: 'stable', efforts: [{ name: 'high', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1, complexities: ['high', 'critical'] }] }],
    capabilities: [], progress: { intervalMinutes: 30 }, paths: { stateDir: '.aorch' }, lanePolicy: { orchestrated: { maxTasks: 24, maxExternalModelCalls: 12, maxLlmReviewers: 3 } }
  };
  const controlTask = {
    ...task, id: 'T-control', risk: 'critical', complexity: 'high', write: true,
    allowedScope: ['.aorch/config.json'], acceptanceCriteria: ['approved config changes'],
    verificationCommands: ['node --version'],
    verifierCommands: [`${process.execPath} -e "process.exit(0)"`],
    verificationIsolation: 'git-worktree',
    controlPlaneChange: true, approval: { runId: sourceRun.id, proposalId: 'P-control' }
  };
  const result = await executeTask({ task: controlTask, config, cwd, stateRoot, onProgress: () => {} });
  assert.equal(result.attestation.status, 'pass');
  const retrospective = await loadRetrospective({ root: stateRoot, runId: sourceRun.id });
  const proposal = retrospective.proposals.find((entry) => entry.id === 'P-control');
  assert.equal(proposal.applied, true);
  assert.equal(proposal.appliedByTask, 'T-control');
  await assert.rejects(() => executeTask({ task: controlTask, config, cwd, stateRoot, onProgress: () => {} }), /already.*applied/i);
});

test('an explicit single-worker lane cannot bypass protected control-plane routing', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-single-worker-protected-'));
  const config = {
    routing: { qualityTolerance: 0.01, tokenTolerance: 0.08 },
    hostPolicy: { selectionMode: 'preferred', executionMode: 'bootstrap-only', allowHostProductEdits: false },
    lanePolicy: {
      'single-worker': { maxTasks: 1, maxExternalModelCalls: 1, maxLlmReviewers: 0 },
      bundled: { maxTasks: 2, maxExternalModelCalls: 1, maxLlmReviewers: 0 },
      orchestrated: { maxTasks: 24, maxExternalModelCalls: 12, maxLlmReviewers: 3 }
    },
    controlPlane: { protectedFiles: ['.aorch/config.json'] },
    providers: [{ id: 'anthropic', adapter: 'claude', enabled: true, executable: 'not-executed' }],
    models: [{
      id: 'claude-sonnet-general', provider: 'anthropic', model: 'sonnet', revision: 'sonnet', enabled: true,
      roles: ['executor'], taskKinds: ['documentation'], quality: { default: 0.9 }, tokenIndex: 1, latencyIndex: 1,
      maturity: 'stable', promptProfileIds: ['anthropic-claude-sonnet-v1'],
      efforts: [{ name: 'high', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1, complexities: ['low'] }]
    }],
    capabilities: [], progress: { intervalMinutes: 30 }, paths: { stateDir: '.aorch' }
  };
  const protectedTask = {
    id: 'T-single-protected', objective: 'Edit project orchestration config.', kind: 'documentation', role: 'executor',
    risk: 'low', complexity: 'low', write: true, executionLane: 'single-worker', allowedScope: ['.aorch/**'], forbiddenScope: [],
    acceptanceCriteria: ['Config is updated.'], verificationCommands: ['node --version'], verifierCommands: [], capabilityIds: [],
    signature: { ambiguity: 'low', repositoryBreadth: 'local', editBreadth: 'one-file', contextVolume: 'small', toolIntensity: 'low', stateComplexity: 'none', testCoverage: 'good', externalIntegration: 'none' }
  };
  const result = await executeTask({
    task: protectedTask, config, cwd, dryRun: true,
    host: { provider: 'anthropic', resolvedModel: 'sonnet', effectiveEffort: 'high', selectionMode: 'preferred', identityKnown: true }
  });
  assert.equal(result.lane.lane, 'orchestrated');
  assert.match(result.lane.reason, /protected control-plane/i);
});

test('runtime execution denies an explicit weak lane for high-risk work', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-runtime-lane-monotonic-'));
  const config = {
    routing: { qualityTolerance: 0.01, tokenTolerance: 0.08 },
    hostPolicy: { selectionMode: 'bootstrap-only', executionMode: 'bootstrap-only', allowHostProductEdits: false },
    lanePolicy: {
      'single-worker': { maxTasks: 1, maxExternalModelCalls: 1, maxLlmReviewers: 0 },
      bundled: { maxTasks: 2, maxExternalModelCalls: 1, maxLlmReviewers: 0 },
      orchestrated: { maxTasks: 24, maxExternalModelCalls: 12, maxLlmReviewers: 3 }
    },
    providers: [{ id: 'anthropic', adapter: 'claude', enabled: true, executable: 'not-executed', trustTier: 'trusted', adapterMaturity: 'stable' }],
    models: [{
      id: 'claude-deep', provider: 'anthropic', model: 'opus', revision: 'opus-r1', enabled: true,
      roles: ['executor'], taskKinds: ['implementation'], quality: { default: 0.95 }, tokenIndex: 1, latencyIndex: 1,
      maturity: 'stable', promptProfileIds: ['anthropic-claude-opus-v1'],
      efforts: [{ name: 'high', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1, complexities: ['high'] }]
    }],
    capabilities: [], progress: { intervalMinutes: 30 }, paths: { stateDir: '.aorch' }
  };
  const result = await executeTask({
    task: {
      id: 'T-runtime-high', objective: 'Change authentication state transitions.', kind: 'implementation', role: 'executor',
      risk: 'high', complexity: 'high', write: false, executionLane: 'bundled', allowedScope: [], forbiddenScope: [],
      acceptanceCriteria: ['Authentication state transitions remain safe.'], verificationCommands: ['node --version'], verifierCommands: [], capabilityIds: [],
      signature: { ambiguity: 'medium', repositoryBreadth: 'module', editBreadth: 'none', contextVolume: 'medium', toolIntensity: 'high', stateComplexity: 'complex', testCoverage: 'partial', externalIntegration: 'none' }
    },
    config, cwd, dryRun: true
  });
  assert.equal(result.lane.lane, 'orchestrated');
  assert.equal(result.lane.requestedLane, 'bundled');
});
