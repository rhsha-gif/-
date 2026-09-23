import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeTask as realExecuteTask } from '../src/task-runner.js';
import { createReadinessContext } from '../src/provider-readiness.js';
const executeTask = (options) => realExecuteTask({ readinessContext: createReadinessContext({ diagnose: async ({ providers }) => providers.map(p => ({ id: p.id, readiness: 'ready', models: null })) }), ...options });

const COMPLETE_RECEIPT = Object.freeze({
  status: 'complete',
  summary: 'fixture complete',
  filesInspected: [],
  filesChanged: [],
  commands: [],
  criteria: [],
  findings: [],
  unresolvedRisks: [],
  confidence: 1
});

const BLOCKED_RECEIPT = Object.freeze({
  ...COMPLETE_RECEIPT,
  status: 'blocked',
  summary: 'approval required',
  inputRequest: {
    kind: 'approval',
    questions: [{ id: 'publish', prompt: 'Publish the prepared artifact?' }]
  }
});

function task(id) {
  return {
    id,
    runId: 'new-provider-run',
    objective: 'Exercise the provider adapter with 한글 paths',
    kind: 'implementation',
    role: 'executor',
    risk: 'standard',
    complexity: 'standard',
    write: false,
    allowedScope: ['src/**'],
    acceptanceCriteria: ['The structured receipt is preserved'],
    verificationCommands: ['node --test'],
    capabilityIds: []
  };
}

function config(adapter) {
  return {
    routing: { qualityTolerance: 0.01, tokenTolerance: 0.05, uncertaintyPenalty: 0 },
    providers: [{ id: adapter, adapter, enabled: true, executable: adapter === 'antigravity' ? 'agy' : 'grok' }],
    models: [{
      id: `${adapter}-fixture`, provider: adapter,
      model: adapter === 'antigravity' ? 'gemini-3.8-flash-high' : 'grok-4.6', enabled: true,
      roles: ['executor'], taskKinds: ['implementation'], maturity: 'stable',
      quality: { default: 0.8, implementation: 0.8 }, tokenIndex: 1, latencyIndex: 1,
      efforts: [{
        name: 'low', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1,
        complexities: ['standard']
      }]
    }],
    capabilities: [],
    roleAgents: {
      worker: { antigravity: 'aorch-worker', grok: 'aorch-worker' },
      reviewer: { antigravity: 'aorch-reviewer', grok: 'aorch-reviewer' }
    }
  };
}

async function koreanDirectory(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aorch-new-provider-'));
  const cwd = path.join(base, '한글 작업 공간');
  await mkdir(cwd);
  const agyAgent = path.join(cwd, '.agents', 'agents', 'aorch-worker', 'agent.md');
  const grokAgent = path.join(cwd, '.grok', 'agents', 'aorch-worker.md');
  await mkdir(path.dirname(agyAgent), { recursive: true });
  await mkdir(path.dirname(grokAgent), { recursive: true });
  await writeFile(agyAgent, '---\nname: aorch-worker\nmainAgent: true\nsubagent: false\ntools: [view_file, grep_search, finish]\n---\nStay in scope.\n');
  await writeFile(grokAgent, '---\nname: aorch-worker\ndisallowedTools: [Agent]\n---\nStay in scope.\n');
  t.after(() => rm(base, { recursive: true, force: true }));
  return cwd;
}

const route = (adapter) => ({ profileId: `${adapter}-fixture`, effort: 'low' });
const noResolution = (spec) => spec;

test('Antigravity execution preserves inputRequest and exposes sanitized usage', async (t) => {
  const cwd = await koreanDirectory(t);
  let observedSpec;
  const result = await executeTask({
    task: task('T-antigravity'),
    config: config('antigravity'),
    cwd,
    forcedRoute: route('antigravity'),
    resolveCommandSpecImpl: noResolution,
    runCommandImpl: async (spec) => {
      observedSpec = spec;
      return {
        exitCode: 0, timedOut: false, durationMs: 23, stderr: '',
        stdout: [
          JSON.stringify({ event: 'init', init: {} }),
          JSON.stringify({ event: 'result', result: {
            status: 'SUCCESS', structured_output: BLOCKED_RECEIPT,
            usage: { input_tokens: 11, output_tokens: 4, thinking_tokens: 2, total_tokens: 15, account_id: 'omit' }
          } })
        ].join('\n')
      };
    }
  });
  assert.deepEqual(result.receipt, BLOCKED_RECEIPT);
  assert.deepEqual(result.result.usage, {
    inputTokens: 11, outputTokens: 4, reasoningTokens: 2, totalTokens: 15
  });
  assert.equal(result.result.durationMs, 23);
  assert.equal(observedSpec.args.includes(task('x').objective), false);
  assert.match(JSON.parse(observedSpec.stdin).message.content, /한글 paths/);
  const schemaPath = observedSpec.args[observedSpec.args.indexOf('--json-schema') + 1];
  assert.match(schemaPath, /한글 작업 공간/);
  assert.equal(observedSpec.args[observedSpec.args.indexOf('--add-dir') + 1], cwd);
  assert.equal(observedSpec.args[observedSpec.args.indexOf('--agent') + 1], 'aorch-worker');
  assert.equal(JSON.parse(await readFile(schemaPath, 'utf8')).type, 'object');
});

test('Grok execution reads a prompt file with Korean and spaces and parses its structured envelope', async (t) => {
  const cwd = await koreanDirectory(t);
  const observedSpecs = [];
  const observedTimeouts = [];
  const result = await executeTask({
    task: task('T-grok'),
    config: config('grok'),
    cwd,
    timeoutMs: 100_000,
    forcedRoute: route('grok'),
    resolveCommandSpecImpl: noResolution,
    runCommandImpl: async (spec, options) => {
      observedSpecs.push(spec);
      observedTimeouts.push(options.timeoutMs);
      if (observedSpecs.length === 1) {
        const promptPath = spec.args[spec.args.indexOf('--prompt-file') + 1];
        assert.match(promptPath, /한글 작업 공간/);
        assert.match(await readFile(promptPath, 'utf8'), /Exercise the provider adapter with 한글 paths/);
        return {
          exitCode: 0, timedOut: false, durationMs: 7, stderr: '',
          stdout: JSON.stringify({
            text: 'work complete', sessionId: '00000000-0000-0000-0000-000000000001', num_turns: 2,
            usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 }
          })
        };
      }
      return {
        exitCode: 0, timedOut: false, durationMs: 17, stderr: '',
        stdout: JSON.stringify({
          text: JSON.stringify(COMPLETE_RECEIPT),
          structuredOutput: { ...COMPLETE_RECEIPT, inputRequest: null },
          usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11, total_cost_usd: 12 }
        })
      };
    }
  });
  assert.deepEqual(result.receipt, COMPLETE_RECEIPT);
  assert.deepEqual(result.result.usage, { inputTokens: 13, outputTokens: 5, totalTokens: 18 });
  assert.equal(result.result.durationMs, 24);
  assert.equal(result.result.phaseCount, 2);
  assert.equal(result.result.reusedWorkPhase, false);
  assert.equal(observedSpecs.length, 2);
  assert.deepEqual(observedTimeouts, [70_000, 99_993]);
  assert.equal(observedSpecs[0].args.includes('--json-schema'), false);
  assert.equal(observedSpecs[0].args.includes('--no-subagents'), true);
  assert.equal(observedSpecs[0].args[observedSpecs[0].args.indexOf('--agent') + 1], 'aorch-worker');
  assert.equal(observedSpecs[0].stdin, null);
  assert.equal(observedSpecs[1].args[observedSpecs[1].args.indexOf('--resume') + 1], '00000000-0000-0000-0000-000000000001');
  assert.doesNotThrow(() => JSON.parse(observedSpecs[1].args[observedSpecs[1].args.indexOf('--json-schema') + 1]));
});

test('Grok unlimited timeout remains unlimited in both phases', async (t) => {
  const cwd = await koreanDirectory(t);
  const budgets = [];
  await executeTask({
    task: task('T-grok-unlimited'), config: config('grok'), cwd, timeoutMs: 0,
    forcedRoute: route('grok'), resolveCommandSpecImpl: noResolution,
    runCommandImpl: async (_spec, options) => {
      budgets.push(options.timeoutMs);
      return { exitCode: 0, timedOut: false, durationMs: 7, stderr: '', stdout: JSON.stringify(
        budgets.length === 1
          ? { text: 'worked', sessionId: '00000000-0000-0000-0000-000000000003', num_turns: 2 }
          : { text: 'complete', structuredOutput: { ...COMPLETE_RECEIPT, inputRequest: null } }
      ) };
    }
  });
  assert.deepEqual(budgets, [0, 0]);
});

test('successful but malformed provider output is a protocol failure', async (t) => {
  const cwd = await koreanDirectory(t);
  const runMalformed = (id, stdout) => {
    let call = 0;
    return executeTask({
      task: task(id),
      config: config('grok'),
      cwd,
      forcedRoute: route('grok'),
      resolveCommandSpecImpl: noResolution,
      runCommandImpl: async () => {
        call += 1;
        return call === 1
          ? {
              exitCode: 0, timedOut: false, durationMs: 1, stderr: '',
              stdout: JSON.stringify({
                text: 'worked', sessionId: '00000000-0000-0000-0000-000000000002', num_turns: 2
              })
            }
          : { exitCode: 0, timedOut: false, durationMs: 1, stderr: '', stdout };
      }
    });
  };
  await assert.rejects(
    runMalformed('T-grok-malformed-envelope', JSON.stringify({ text: '{}' })),
    (error) => error.failureKind === 'protocol' && /structuredOutput/.test(error.message)
  );
  await assert.rejects(
    runMalformed('T-grok-invalid-receipt', JSON.stringify({ text: '{}', structuredOutput: {} })),
    (error) => error.failureKind === 'protocol' && /receipt schema/.test(error.message)
  );
});

test('Antigravity permission denials are action-required failures', async (t) => {
  const cwd = await koreanDirectory(t);
  await assert.rejects(
    executeTask({
      task: task('T-antigravity-permission'), config: config('antigravity'), cwd,
      forcedRoute: route('antigravity'), resolveCommandSpecImpl: noResolution,
      runCommandImpl: async () => ({
        exitCode: 0, timedOut: false, durationMs: 1, stderr: 'permission required',
        stdout: JSON.stringify({ event: 'result', result: {
          status: 'SUCCESS', response: '', denied_actions: [{ action: 'read_file', display_name: 'ViewFile' }],
          usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 }
        } })
      })
    }),
    (error) => error.failureKind === 'action-required' && error.actionRequired === 'permission'
      && error.deniedActionCount === 1
      && error.result.usage.inputTokens === 9 && error.result.usage.totalTokens === 10
  );
});

test('Grok retries finalization from persisted work without repeating the completed work phase', async (t) => {
  const cwd = await koreanDirectory(t);
  let calls = 0;
  const options = {
    task: task('T-grok-finalize-retry'), config: config('grok'), cwd,
    forcedRoute: route('grok'), resolveCommandSpecImpl: noResolution,
    runCommandImpl: async (spec) => {
      calls += 1;
      if (calls === 1) {
        return {
          exitCode: 0, timedOut: false, durationMs: 5, stderr: '',
          stdout: JSON.stringify({
            text: 'work complete', sessionId: '00000000-0000-0000-0000-000000000003', num_turns: 2,
            usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 }
          })
        };
      }
      assert.equal(spec.args.includes('--resume'), true);
      if (calls === 2) return { exitCode: 1, timedOut: false, durationMs: 2, stderr: 'temporary failure', stdout: '' };
      return {
        exitCode: 0, timedOut: false, durationMs: 3, stderr: '',
        stdout: JSON.stringify({
          text: JSON.stringify(COMPLETE_RECEIPT), structuredOutput: { ...COMPLETE_RECEIPT, inputRequest: null },
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
        })
      };
    }
  };
  await assert.rejects(
    executeTask(options),
    (error) => /Grok finalization exited with 1/.test(error.message)
      && error.result.usage.inputTokens === 4 && error.result.usage.totalTokens === 5
  );
  const result = await executeTask(options);
  assert.equal(calls, 3);
  assert.equal(result.result.reusedWorkPhase, true);
  assert.equal(result.result.durationMs, 8);
  assert.deepEqual(result.result.usage, { inputTokens: 6, outputTokens: 2, totalTokens: 8 });
});

test('provider timeout is distinguished from other execution failures', async (t) => {
  const cwd = await koreanDirectory(t);
  await assert.rejects(
    executeTask({
      task: task('T-antigravity-timeout'),
      config: config('antigravity'),
      cwd,
      timeoutMs: 25,
      forcedRoute: route('antigravity'),
      resolveCommandSpecImpl: noResolution,
      runCommandImpl: async () => ({
        exitCode: null, timedOut: true, durationMs: 26, stderr: '', stdout: ''
      })
    }),
    (error) => error.failureKind === 'timeout' && /timed out after 25ms/.test(error.message)
  );
});

test('a native read-only role cannot be used for a write task', async (t) => {
  const cwd = await koreanDirectory(t);
  const presetPath = path.join(cwd, '.grok', 'agents', 'aorch-reviewer.md');
  await mkdir(path.dirname(presetPath), { recursive: true });
  await writeFile(presetPath, '---\nname: aorch-reviewer\ndisallowedTools: ["search_replace", "Agent"]\n---\nReview only.\n');
  const catalog = config('grok');
  catalog.roleAgents = { reviewer: { grok: 'aorch-reviewer' } };
  await assert.rejects(
    executeTask({
      task: { ...task('T-grok-read-only-role'), write: true, agentRole: 'reviewer' },
      config: catalog,
      cwd,
      forcedRoute: route('grok'),
      resolveCommandSpecImpl: noResolution,
      runCommandImpl: async () => { throw new Error('must not spawn'); }
    }),
    /Selected agent is read-only/
  );
});
