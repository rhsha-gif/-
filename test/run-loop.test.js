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
    return {
      task,
      route,
      receipt: { status: 'complete', filesChanged: [] },
      receiptPath: path.join(runDir, 'receipt.json'),
      runDir
    };
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

const NON_GIT_SNAPSHOT = Object.freeze({
  applicable: false,
  reason: 'not-git-repository',
  root: null,
  head: null,
  entries: {}
});

function executeLoop(options) {
  return executeWithVerification({
    captureGitSnapshotImpl: async () => NON_GIT_SNAPSHOT,
    ...options
  });
}

test('a first-attempt pass records evidence and a verify-gate observation', async (t) => {
  const dir = await temporaryDirectory(t);
  const calls = [];
  const records = [];
  const result = await executeLoop({
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
  assert.equal(persisted.changeGuard.passed, true);
});

test('a task without verification commands keeps single-shot behavior', async (t) => {
  const dir = await temporaryDirectory(t);
  const calls = [];
  const records = [];
  const verifyCalls = [];
  const result = await executeLoop({
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
  const persisted = JSON.parse(await readFile(path.join(result.runDir, 'verification.json'), 'utf8'));
  assert.equal(persisted.passed, true);
  assert.deepEqual(persisted.results, []);
  assert.equal(persisted.changeGuard.applicable, false);
});

test('a change guard violation returns immediately without verification or escalation', async (t) => {
  const dir = await temporaryDirectory(t);
  const calls = [];
  const records = [];
  const verifyCalls = [];
  const snapshots = [
    { applicable: true, reason: null, root: dir, head: 'before', entries: {} },
    {
      applicable: true,
      reason: null,
      root: dir,
      head: 'before',
      entries: {
        'src/unclaimed.js': {
          status: ' M',
          index: '100644 fixture 0',
          worktree: 'file:changed'
        }
      }
    }
  ];
  let caught;

  await assert.rejects(
    executeLoop({
      task: baseTask({
        write: true,
        allowedScope: ['src/**'],
        forbiddenScope: []
      }),
      config: baseConfig(),
      cwd: dir,
      observationsPath: path.join(dir, 'obs.jsonl'),
      executeTaskImpl: stubExecutor(dir, calls),
      runVerificationImpl: stubVerifier([true], verifyCalls),
      appendObservationImpl: stubRecorder(records),
      captureGitSnapshotImpl: async () => snapshots.shift()
    }),
    (error) => {
      caught = error;
      assert.match(error.message, /change guard failed/i);
      assert.deepEqual(error.changeGuard.unclaimedFiles, ['src/unclaimed.js']);
      return true;
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(verifyCalls.length, 0);
  assert.equal(records.length, 0);
  const persisted = JSON.parse(await readFile(path.join(caught.runDir, 'verification.json'), 'utf8'));
  assert.equal(persisted.passed, false);
  assert.deepEqual(persisted.changeGuard.unclaimedFiles, ['src/unclaimed.js']);
});

test('the change guard compares every attempt against the pre-run baseline, not a dirtied one', async (t) => {
  const dir = await temporaryDirectory(t);
  const calls = [];
  // Clean at the start; the first worker to run leaves the target modified and
  // it stays modified across retries (a stronger model builds on the prior tree).
  let treeModified = false;
  const snapshot = () => ({
    applicable: true,
    reason: null,
    root: dir,
    head: 'h',
    entries: treeModified
      ? { 'src/difficulty.js': { status: ' M', index: '100644 x 0', worktree: 'file:new' } }
      : {}
  });
  const executor = async ({ task, forcedRoute }) => {
    calls.push({ forcedRoute });
    treeModified = true;
    const runDir = path.join(dir, 'task-runs', task.runId ?? 'run', `${task.id}-${calls.length}`);
    await mkdir(runDir, { recursive: true });
    return {
      task,
      route: forcedRoute
        ? { provider: 'anthropic', profileId: forcedRoute.profileId, model: forcedRoute.profileId, effort: forcedRoute.effort }
        : { provider: 'anthropic', profileId: 'claude-sonnet-general', model: 'sonnet', effort: 'medium' },
      receipt: { status: 'complete', filesChanged: ['src/difficulty.js'] },
      receiptPath: path.join(runDir, 'receipt.json'),
      runDir
    };
  };

  // Attempt 1 writes the file but verify fails; attempt 2 rewrites the same
  // content, so a per-attempt baseline sees zero delta and rejects the honest
  // claim as overclaimed. Against a fixed pre-run baseline the net change matches.
  const result = await executeLoop({
    task: baseTask({ write: true, allowedScope: ['src/**'], forbiddenScope: [] }),
    config: baseConfig(),
    cwd: dir,
    observationsPath: path.join(dir, 'obs.jsonl'),
    executeTaskImpl: executor,
    runVerificationImpl: stubVerifier([false, true]),
    appendObservationImpl: stubRecorder([]),
    captureGitSnapshotImpl: async () => snapshot()
  });

  assert.equal(calls.length, 2);
  assert.equal(result.verification.passed, true);
});

test('a verify failure escalates on the provider ladder with the failure evidence attached', async (t) => {
  const dir = await temporaryDirectory(t);
  const calls = [];
  const records = [];
  const result = await executeLoop({
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
    executeLoop({
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
  const result = await executeLoop({
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
    executeLoop({
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

test('a rate-limited attempt records the limit and reroutes to another provider', async (t) => {
  const dir = await temporaryDirectory(t);
  const calls = [];
  const limitCalls = [];
  let first = true;
  const executor = async ({ task, forcedRoute, dryRun }) => {
    calls.push({ task, forcedRoute, dryRun });
    if (first) {
      first = false;
      const error = new Error('Worker exited with 1');
      error.route = { provider: 'anthropic', profileId: 'claude-sonnet-general', model: 'sonnet', effort: 'medium' };
      error.result = { stderr: 'usage limit reached, resets at 5pm', stdout: '' };
      throw error;
    }
    const runDir = path.join(dir, 'task-runs', task.runId ?? 'run', task.id);
    await mkdir(runDir, { recursive: true });
    return {
      task,
      route: { provider: 'openai', profileId: 'codex-terra-general', model: 'gpt-5.6-terra', effort: 'medium' },
      receipt: { status: 'complete', filesChanged: [] },
      receiptPath: path.join(runDir, 'receipt.json'),
      runDir
    };
  };

  const result = await executeLoop({
    task: baseTask(),
    config: baseConfig(),
    cwd: dir,
    executeTaskImpl: executor,
    runVerificationImpl: stubVerifier([true]),
    setLimitImpl: async (stateRoot, provider, options) => { limitCalls.push({ stateRoot, provider, options }); }
  });

  assert.equal(calls.length, 2);
  assert.equal(limitCalls.length, 1);
  assert.equal(limitCalls[0].provider, 'anthropic');
  assert.equal(limitCalls[0].options.source, 'auto-detect');
  // The reroute is a fresh selection under forbiddenProviders, not a ladder step.
  assert.equal(calls[1].forcedRoute, undefined);
  assert.ok(calls[1].task.forbiddenProviders.includes('anthropic'));
  assert.equal(result.route.provider, 'openai');
  assert.equal(result.verification.passed, true);
});

test('a failed worker that changed a read-only workspace stops before rate-limit fallback', async (t) => {
  const dir = await temporaryDirectory(t);
  const calls = [];
  const limitCalls = [];
  const snapshots = [
    { applicable: true, reason: null, root: dir, head: 'before', entries: {} },
    {
      applicable: true,
      reason: null,
      root: dir,
      head: 'before',
      entries: {
        'src/mutated.js': {
          status: ' M',
          index: '100644 fixture 0',
          worktree: 'file:changed'
        }
      }
    }
  ];
  const executor = async ({ task }) => {
    calls.push(task);
    const error = new Error('Worker exited with 1');
    error.route = {
      provider: 'anthropic',
      profileId: 'claude-sonnet-general',
      model: 'sonnet',
      effort: 'medium'
    };
    error.result = { stderr: 'usage limit reached, resets at 5pm', stdout: '' };
    throw error;
  };
  let caught;

  await assert.rejects(
    executeLoop({
      task: baseTask({ write: false }),
      config: baseConfig(),
      cwd: dir,
      executeTaskImpl: executor,
      captureGitSnapshotImpl: async () => snapshots.shift(),
      setLimitImpl: async (...args) => limitCalls.push(args)
    }),
    (error) => {
      caught = error;
      assert.match(error.message, /change guard failed/i);
      assert.deepEqual(error.changeGuard.readOnlyFiles, ['src/mutated.js']);
      return true;
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(limitCalls.length, 0);
  const persisted = JSON.parse(await readFile(path.join(caught.runDir, 'verification.json'), 'utf8'));
  assert.equal(persisted.passed, false);
});

test('a non-rate-limit execution error propagates instead of being retried', async (t) => {
  const dir = await temporaryDirectory(t);
  const calls = [];
  const executor = async ({ task, forcedRoute }) => {
    calls.push({ task, forcedRoute });
    const error = new Error('Worker exited with 1');
    error.route = { provider: 'anthropic', profileId: 'claude-sonnet-general', model: 'sonnet', effort: 'medium' };
    error.result = { stderr: 'SyntaxError: unexpected token', stdout: '' };
    throw error;
  };
  await assert.rejects(
    executeLoop({
      task: baseTask(),
      config: baseConfig(),
      cwd: dir,
      executeTaskImpl: executor,
      runVerificationImpl: stubVerifier([]),
      setLimitImpl: async () => { throw new Error('must not be called'); }
    }),
    /Worker exited with 1/
  );
  assert.equal(calls.length, 1);
});

test('dry-run delegates without running verification', async (t) => {
  const dir = await temporaryDirectory(t);
  const calls = [];
  const verifyCalls = [];
  await executeLoop({
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
