import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeTask } from '../src/task-runner.js';

// The worker prompt tells the worker "the wrapper will persist it to
// <receiptPath>", and `aorch exec` returns that path to the caller. These tests
// hold the wrapper to that promise.

const RECEIPT = Object.freeze({
  taskId: 'T-receipt',
  status: 'complete',
  filesInspected: ['src/task-runner.js'],
  filesChanged: [],
  commands: [{ command: 'node --test', exitCode: 0 }],
  confidence: 'high'
});

const emitReceipt = 'process.stdout.write(process.argv[1])';
const emitReceiptThenFail = 'process.stdout.write(process.argv[1]); process.exit(3)';

function task(overrides = {}) {
  return {
    id: 'T-receipt',
    runId: 'receipt-run',
    objective: 'Exercise receipt persistence',
    kind: 'implementation',
    role: 'executor',
    risk: 'standard',
    write: false,
    allowedScope: ['test/**'],
    acceptanceCriteria: ['The receipt is readable from disk after execution'],
    verificationCommands: ['node --test'],
    capabilityIds: [],
    ...overrides
  };
}

function config(script = emitReceipt) {
  return {
    routing: { qualityTolerance: 0.01, tokenTolerance: 0.05, uncertaintyPenalty: 0 },
    providers: [{
      id: 'fixture',
      adapter: 'generic',
      enabled: true,
      executable: process.execPath,
      args: ['-e', script, JSON.stringify(RECEIPT)]
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
    capabilities: []
  };
}

async function temporaryDirectory(t, prefix) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('the worker receipt is persisted to the receipt path the prompt promised', async (t) => {
  // Given
  const cwd = await temporaryDirectory(t, 'aorch-receipt-persist-');

  // When
  const result = await executeTask({ task: task(), config: config(), cwd });

  // Then
  assert.deepEqual(result.receipt, RECEIPT);
  assert.equal(
    result.receiptPath,
    path.join(cwd, '.aorch', 'task-runs', 'receipt-run', 'T-receipt', 'receipt.json')
  );
  const persisted = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.deepEqual(persisted, RECEIPT);
});

test('a worker that exits non-zero leaves no receipt behind, even if it printed one', async (t) => {
  // Given
  const cwd = await temporaryDirectory(t, 'aorch-receipt-failed-');
  const receiptPath = path.join(cwd, '.aorch', 'task-runs', 'receipt-run', 'T-receipt', 'receipt.json');

  // When
  const execution = executeTask({ task: task(), config: config(emitReceiptThenFail), cwd });

  // Then
  await assert.rejects(execution, /Worker exited with 3/);
  await assert.rejects(readFile(receiptPath, 'utf8'), { code: 'ENOENT' });
});

test('a worker that dies before producing output surfaces its stderr as evidence', async (t) => {
  // Given: a worker that rejects its invocation the way a CLI flag error does
  const cwd = await temporaryDirectory(t, 'aorch-receipt-stderr-');
  const dieWithStderr = 'process.stderr.write("Error: --json-schema is not a valid JSON Schema"); process.exit(1)';

  // When
  const execution = executeTask({ task: task(), config: config(dieWithStderr), cwd });

  // Then: the failure message carries the stderr tail so `aorch exec` output is diagnosable
  await assert.rejects(execution, /Worker exited with 1[\s\S]*--json-schema is not a valid JSON Schema/);
});
