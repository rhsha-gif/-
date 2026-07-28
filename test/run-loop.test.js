import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeWithVerification } from '../src/run-loop.js';

function baseTask(overrides = {}) {
  return {
    id: 'T-loop',
    objective: 'Exercise the verification loop',
    kind: 'implementation',
    role: 'executor',
    risk: 'standard',
    complexity: 'standard',
    acceptanceCriteria: ['behavior observed'],
    verificationCommands: ['node --test'],
    ...overrides
  };
}

function baseConfig(overrides = {}) {
  return {
    escalation: {
      maxAttempts: 3,
      ladders: {
        anthropic: [
          { profileId: 'claude-opus-deep', effort: 'high' },
          { profileId: 'claude-fable-apex', effort: 'high' }
        ]
      }
    },
    verification: { commandTimeoutMs: 5000 },
    ...overrides
  };
}

async function temporaryDirectory(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aorch-run-loop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Stand-in for executeTask: records calls and materializes a run directory the
// way the real runner does, without spawning any worker.
function stubExecutor(dir, calls, { initialRoute } = {}) {
  return async ({ task, forcedRoute, dryRun }) => {
    calls.push({ task, forcedRoute, dryRun });
    const route = forcedRoute
      ? { provider: 'anthropic', profileId: forcedRoute.profileId, model: forcedRoute.profileId, effort: forcedRoute.effort }
      : (initialRoute ?? { provider: 'anthropic', profileId: 'claude-sonnet-general', model: 'sonnet', effort: 'medium' });
    const runDir = path.join(dir, 'task-runs', task.runId ?? 'run', task.id);
    await mkdir(runDir, { recursive: true });
    return { task, route, receipt: { status: 'complete' }, receiptPath: path.join(runDir, 'receipt.json'), runDir };
  };
}

function stubVerifier(outcomes, verifyCalls = []) {
  return async ({ commands, timeoutMs }) => {
    verifyCalls.push({ commands, timeoutMs });
    const passed = outcomes.shift();
    return {
      passed,
      results: [{
        command: commands[0],
        status: passed ? 'complete' : 'failed',
        exitCode: passed ? 0 : 1,
        timedOut: false,
        durationMs: 5,
        stdoutTail: '',
        stderrTail: passed ? '' : 'assertion blew up'
      }]
    };
  };
}

function stubRecorder(records) {
  return async (filePath, input) => {
    records.push({ filePath, input });
    return input;
  };
}

test('a first-attempt pass records evidence and a verify-gate observation', async (t) => {
  const dir = await temporaryDirectory(t);
  const calls = [];
  const records = [];
  const result = await executeWithVerification({
    task: baseTask(),
    config: baseConfig(),
    cwd: dir,
    observationsPath: path.join(dir, 'obs.jsonl'),
    executeTaskImpl: stubExecutor(dir, calls),
    runVerificationImpl: stubVerifier([true]),
    appendObservationImpl: stubRecorder(records)
  });

  assert.equal(result.verification.passed, true);
  assert.equal(result.attempts.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].input.quality, 1);
  assert.equal(records[0].input.taskKind, 'implementation');
  assert.equal(records[0].input.metadata.source, 'verify-gate');
  const persisted = JSON.parse(await readFile(path.join(result.runDir, 'verification.json'), 'utf8'));
  assert.equal(persisted.passed, true);
  assert.equal(persisted.route.model, 'sonnet');
});

test('a task without verification commands keeps single-shot behavior', async (t) => {
  const dir = await temporaryDirectory(t);
  const calls = [];
  const records = [];
  const verifyCalls = [];
  const result = await executeWithVerification({
    task: baseTask({ verificationCommands: [] }),
    config: baseConfig(),
    cwd: dir,
    observationsPath: path.join(dir, 'obs.jsonl'),
    executeTaskImpl: stubExecutor(dir, calls),
    runVerificationImpl: stubVerifier([], verifyCalls),
    appendObservationImpl: stubRecorder(records)
  });

  assert.equal(result.verification, null);
  assert.equal(calls.length, 1);
  assert.equal(verifyCalls.length, 0);
  assert.equal(records.length, 0);
});

test('a verify failure escalates on the provider ladder with the failure evidence attached', async (t) => {
  const dir = await temporaryDirectory(t);
  const calls = [];
  const records = [];
  const result = await executeWithVerification({
    task: baseTask(),
    config: baseConfig(),
    cwd: dir,
    observationsPath: path.join(dir, 'obs.jsonl'),
    executeTaskImpl: stubExecutor(dir, calls),
    runVerificationImpl: stubVerifier([false, true]),
    appendObservationImpl: stubRecorder(records)
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].forcedRoute, { profileId: 'claude-opus-deep', effort: 'high' });
  assert.equal(calls[1].task.id, 'T-loop.esc1');
  assert.match(calls[1].task.objective, /failed verification/i);
  assert.match(calls[1].task.objective, /assertion blew up/);
  // Both attempts share one run id so their evidence lands under one run tree.
  assert.equal(calls[0].task.runId, calls[1].task.runId);
  assert.equal(result.verification.passed, true);
  assert.equal(result.attempts.length, 2);
  assert.deepEqual(records.map((entry) => entry.input.quality), [0.2, 1]);
});

test('exhausting the attempt budget returns the human an error with evidence', async (t) => {
  const dir = await temporaryDirectory(t);
  const calls = [];
  const records = [];
  await assert.rejects(
    executeWithVerification({
      task: baseTask(),
      config: baseConfig(),
      cwd: dir,
      observationsPath: path.join(dir, 'obs.jsonl'),
      executeTaskImpl: stubExecutor(dir, calls),
      runVerificationImpl: stubVerifier([false, false, false]),
      appendObservationImpl: stubRecorder(records)
    }),
    (error) => {
      assert.match(error.message, /Verification failed after 3 attempt/i);
      assert.match(error.message, /verification\.json/);
      assert.equal(error.attempts.length, 3);
      return true;
    }
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].forcedRoute, { profileId: 'claude-fable-apex', effort: 'high' });
  assert.deepEqual(records.map((entry) => entry.input.quality), [0.2, 0.2, 0.2]);
});

test('a ladder step the run already used is skipped instead of retried', async (t) => {
  const dir = await temporaryDirectory(t);
  const calls = [];
  const result = await executeWithVerification({
    task: baseTask(),
    config: baseConfig(),
    cwd: dir,
    executeTaskImpl: stubExecutor(dir, calls, {
      initialRoute: { provider: 'anthropic', profileId: 'claude-opus-deep', model: 'opus', effort: 'high' }
    }),
    runVerificationImpl: stubVerifier([false, true])
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].forcedRoute, { profileId: 'claude-fable-apex', effort: 'high' });
  assert.equal(result.verification.passed, true);
});

test('an empty ladder fails after the first attempt instead of retrying blindly', async (t) => {
  const dir = await temporaryDirectory(t);
  const calls = [];
  await assert.rejects(
    executeWithVerification({
      task: baseTask(),
      config: baseConfig({ escalation: { maxAttempts: 3, ladders: {} } }),
      cwd: dir,
      executeTaskImpl: stubExecutor(dir, calls),
      runVerificationImpl: stubVerifier([false])
    }),
    /Verification failed after 1 attempt/i
  );
  assert.equal(calls.length, 1);
});

test('dry-run delegates without running verification', async (t) => {
  const dir = await temporaryDirectory(t);
  const calls = [];
  const verifyCalls = [];
  await executeWithVerification({
    task: baseTask(),
    config: baseConfig(),
    cwd: dir,
    dryRun: true,
    executeTaskImpl: stubExecutor(dir, calls),
    runVerificationImpl: stubVerifier([], verifyCalls)
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dryRun, true);
  assert.equal(verifyCalls.length, 0);
});
