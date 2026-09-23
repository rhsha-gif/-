import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeTask as realExecuteTask } from '../src/task-runner.js';
import { createReadinessContext } from '../src/provider-readiness.js';
const executeTask = (options) => realExecuteTask({ readinessContext: createReadinessContext({ diagnose: async ({ providers }) => providers.map(p => ({ id: p.id, readiness: 'ready', models: null })) }), ...options });

const RECEIPT = {
  status: 'complete', summary: 'done', filesInspected: [], filesChanged: [], commands: [],
  criteria: [], findings: [], unresolvedRisks: [], confidence: 1
};

function fixture(adapter) {
  const provider = adapter === 'claude' ? 'anthropic' : 'openai';
  return {
    task: {
      id: `T-${adapter}-usage`, runId: 'usage-run', objective: 'Measure actual token usage',
      kind: 'implementation', role: 'executor', risk: 'standard', write: false,
      allowedScope: ['src/**'], acceptanceCriteria: ['Usage is measured'], verificationCommands: [], capabilityIds: []
    },
    config: {
      routing: { qualityTolerance: 0.01, tokenTolerance: 0.05, uncertaintyPenalty: 0 },
      providers: [{ id: provider, adapter, enabled: true, executable: adapter }],
      models: [{
        id: `${adapter}-profile`, provider, model: `${adapter}-model`, enabled: true,
        roles: ['executor'], taskKinds: ['implementation'], maturity: 'stable',
        quality: { default: 0.8 }, tokenIndex: 1, latencyIndex: 1,
        efforts: [{ name: 'low', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1, complexities: ['standard'] }]
      }],
      capabilities: []
    },
    forcedRoute: { profileId: `${adapter}-profile`, effort: 'low' }
  };
}

async function temporaryDirectory(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-usage-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('Claude envelope usage is normalized without cost or account metadata', async (t) => {
  const cwd = await temporaryDirectory(t);
  const result = await executeTask({
    ...fixture('claude'), cwd, resolveCommandSpecImpl: (spec) => spec,
    runCommandImpl: async () => ({
      exitCode: 0, timedOut: false, durationMs: 9, stderr: '',
      stdout: JSON.stringify({
        structured_output: RECEIPT,
        usage: {
          input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2, account_id: 'omit'
        }
      })
    })
  });
  assert.deepEqual(result.result.usage, {
    inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheCreationTokens: 2
  });
  assert.equal(result.result.durationMs, 9);
});

test('Codex turn.completed usage is normalized without inventing a total', async (t) => {
  const cwd = await temporaryDirectory(t);
  const result = await executeTask({
    ...fixture('codex'), cwd, resolveCommandSpecImpl: (spec) => spec,
    runCommandImpl: async (spec) => {
      const outputPath = spec.args[spec.args.indexOf('-o') + 1];
      await writeFile(outputPath, JSON.stringify(RECEIPT));
      return {
        exitCode: 0, timedOut: false, durationMs: 12, stderr: '',
        stdout: [
          JSON.stringify({ type: 'thread.started' }),
          JSON.stringify({ type: 'turn.completed', usage: {
            input_tokens: 20, cached_input_tokens: 8, output_tokens: 5, total_cost: 99
          } })
        ].join('\n')
      };
    }
  });
  assert.deepEqual(result.result.usage, {
    inputTokens: 20, cacheReadTokens: 8, outputTokens: 5
  });
  assert.equal('totalTokens' in result.result.usage, false);
  assert.equal(result.result.durationMs, 12);
});
