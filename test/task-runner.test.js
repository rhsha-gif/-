import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { executeTask } from '../src/task-runner.js';

const execFileAsync = promisify(execFile);
const workerScript = 'require("node:fs").writeFileSync(process.argv[1], "spawned")';

function task(overrides = {}) {
  return {
    id: 'T-thin-exec',
    objective: 'Exercise thin task execution',
    kind: 'implementation',
    role: 'executor',
    risk: 'standard',
    write: false,
    allowedScope: ['test/**'],
    acceptanceCriteria: ['The requested execution behavior is observed'],
    verificationCommands: ['node --test'],
    capabilityIds: ['fixture-skill'],
    ...overrides
  };
}

function config(markerPath) {
  return {
    routing: {
      qualityTolerance: 0.01,
      tokenTolerance: 0.05,
      uncertaintyPenalty: 0
    },
    providers: [{
      id: 'fixture',
      adapter: 'generic',
      enabled: true,
      executable: process.execPath,
      args: ['-e', workerScript, markerPath]
    }],
    models: [{
      id: 'fixture-model',
      provider: 'fixture',
      model: 'fixture-model',
      enabled: true,
      roles: ['executor'],
      taskKinds: ['implementation'],
      maturity: 'stable',
      quality: { default: 0.8, implementation: 0.8 },
      tokenIndex: 1,
      latencyIndex: 1,
      efforts: [{
        name: 'medium',
        qualityDelta: 0,
        tokenMultiplier: 1,
        latencyMultiplier: 1,
        complexities: ['standard', 'high']
      }]
    }],
    capabilities: [{
      id: 'fixture-skill',
      type: 'skill',
      providers: ['fixture'],
      enabled: true
    }]
  };
}

async function temporaryDirectory(t, prefix) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function ordinaryRepository(t, prefix) {
  const cwd = await temporaryDirectory(t, prefix);
  await execFileAsync('git', ['init', '--quiet'], { cwd });
  return cwd;
}

async function assertWorkerWasNotSpawned(markerPath) {
  await assert.rejects(access(markerPath), { code: 'ENOENT' });
}

test('dry-run returns the route, capabilities, and command without spawning a worker', async (t) => {
  // Given
  const cwd = await temporaryDirectory(t, 'aorch-task-runner-dry-');
  const markerPath = path.join(cwd, 'worker-spawned');

  // When
  const result = await executeTask({
    task: task({ id: 'T-dry-run' }),
    config: config(markerPath),
    cwd,
    dryRun: true
  });

  // Then
  assert.equal(result.route.provider, 'fixture');
  assert.equal(result.route.model, 'fixture-model');
  assert.equal(result.route.effort, 'medium');
  assert.deepEqual(result.capabilities.skills.map((entry) => entry.id), ['fixture-skill']);
  assert.deepEqual(result.capabilities.plugins, []);
  assert.deepEqual(result.capabilities.hooks, []);
  assert.equal(result.commandSpec.command, process.execPath);
  assert.deepEqual(result.commandSpec.args, ['-e', workerScript, markerPath]);
  assert.equal(result.commandSpec.env.AORCH_TASK_ID, 'T-dry-run');
  await assertWorkerWasNotSpawned(markerPath);
});

for (const risk of ['high', 'critical']) {
  test(`${risk}-risk write is refused outside a linked worktree`, async (t) => {
    // Given
    const cwd = await ordinaryRepository(t, `aorch-task-runner-${risk}-`);
    const markerPath = path.join(cwd, 'worker-spawned');

    // When
    const execution = executeTask({
      task: task({
        id: `T-${risk}-write`,
        risk,
        write: true,
        allowInPlaceWrite: true
      }),
      config: config(markerPath),
      cwd
    });

    // Then
    await assert.rejects(
      execution,
      new RegExp(`${risk}-risk write task must run in an isolated linked worktree`, 'i')
    );
    await assertWorkerWasNotSpawned(markerPath);
  });
}

test('standard-risk write without explicit in-place authorization is refused', async (t) => {
  // Given
  const cwd = await ordinaryRepository(t, 'aorch-task-runner-standard-');
  const markerPath = path.join(cwd, 'worker-spawned');

  // When
  const execution = executeTask({
    task: task({
      id: 'T-standard-write',
      write: true
    }),
    config: config(markerPath),
    cwd
  });

  // Then
  await assert.rejects(
    execution,
    /in-place write requires explicit task\.allowInPlaceWrite authorization/i
  );
  await assertWorkerWasNotSpawned(markerPath);
});
