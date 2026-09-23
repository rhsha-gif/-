import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadinessContext, selectReadyRoute } from '../src/provider-readiness.js';
import { diagnoseProviders } from '../src/provider-diagnostics.js';
import { executeTask } from '../src/task-runner.js';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const task = { id: 'ready', kind: 'implementation', role: 'executor', risk: 'standard' };
const config = {
  routing: { qualityTolerance: 0, uncertaintyPenalty: 0 },
  providers: [{ id: 'a', adapter: 'claude' }, { id: 'b', adapter: 'codex' }],
  models: ['a', 'b'].map((id, i) => ({ id, provider: id, model: id, modelFamily: i ? 'gpt' : 'claude', enabled: true,
    roles: ['executor'], taskKinds: ['implementation'], quality: { default: i ? 0.85 : 0.9 }, maturity: 'stable',
    tokenIndex: 1, latencyIndex: 1, efforts: [{ name: 'medium', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1 }] }))
};
const run = (context, overrides = {}) => selectReadyRoute({ task, config, observations: [], quota: null, cwd: '.', context, ...overrides });

test('generic adapters do not claim an authentication preflight', async () => {
  const [status] = await diagnoseProviders({ providers: [{ id: 'custom', adapter: 'generic', executable: process.execPath }] });
  assert.equal(status.readiness, 'unknown');
  assert.equal(status.readinessReason, 'custom-protocol');
  assert.equal(status.executionStatus, 'not-probed');
});

test('real generic execution does not require version or authentication commands', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-generic-contract-'));
  const catalog = structuredClone(config);
  catalog.providers = [{ id: 'a', adapter: 'generic', enabled: true, executable: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify({status:"complete", summary:"custom", filesChanged:[]}))'] }];
  catalog.models = [catalog.models[0]];
  catalog.capabilities = [];
  const context = createReadinessContext({ diagnose: async () => { throw new Error('generic must not run native preflight'); } });
  const result = await executeTask({ task: { ...task, objective: 'Run custom protocol', write: false,
    acceptanceCriteria: ['Receipt returned'], verificationCommands: [] }, config: catalog, cwd, readinessContext: context });
  assert.equal(result.receipt.summary, 'custom');
  assert.equal(context.evidence[0].readinessReason, 'custom-protocol');
});
function fixture() {
  return createReadinessContext({ diagnose: async ({ providers }) => providers.map(p => ({ id: p.id,
    readiness: p.id === 'a' ? 'blocked' : 'ready', readinessReason: p.id === 'a' ? 'authentication' : null })) });
}

test('preflight switches only before execution and keeps constraints on every candidate', async () => {
  const context = fixture();
  assert.equal((await run(context)).provider, 'b');
  assert.deepEqual([...context.excluded], ['a']);
  assert.equal((await run(context)).provider, 'b');
  for (const constraint of [ { allowedProfileIds: ['a'] }, { allowedProviders: ['a'] }, { forbiddenProviders: ['b'] },
    { minimumQuality: 0.89 }, { forbiddenModelFamilies: ['gpt'] }, { capabilityIds: ['missing'] } ]) {
    await assert.rejects(run(fixture(), { task: { ...task, ...constraint } }), /No ready route/);
  }
  await assert.rejects(run(fixture(), { forcedRoute: { profileId: 'a', effort: 'medium' } }), /No ready route/);
});

test('successful preflight is reused for five minutes and failure is invocation-local', async () => {
  let now = 0, calls = 0;
  const context = createReadinessContext({ now: () => now, diagnose: async () => { calls++; return [{ readiness: 'ready', models: ['a'] }]; } });
  await context.check(config.providers[0], 'a', '.');
  now = 299999; await context.check(config.providers[0], 'a', '.'); assert.equal(calls, 1);
  now = 300000; await context.check(config.providers[0], 'a', '.'); assert.equal(calls, 2);
  assert.equal((await context.check(config.providers[0], 'absent', '.')).readinessReason, 'model-unavailable');
  assert.ok(context.excluded.has('a'));
  assert.equal(fixture().excluded.size, 0);
});

test('timeout/network retries once, authentication does not retry, and version success is not readiness', async () => {
  for (const [failure, expected] of [['timeout', 2], ['network', 2], ['authentication', 1]]) {
    let calls = 0;
    const [result] = await diagnoseProviders({ providers: [{ id: 'a', adapter: 'grok', executable: 'grok' }], platform: 'linux',
      runCommandImpl: async (spec, options) => {
        if (spec.args[0] === '--version') { assert.equal(options.timeoutMs, 5000); return { exitCode: 0, stdout: 'v1' }; }
        calls++; assert.equal(options.timeoutMs, 15000);
        return { exitCode: 1, timedOut: failure === 'timeout', stderr: failure === 'network' ? 'network error' : 'authentication required' };
      } });
    assert.equal(calls, expected);
    assert.equal(result.available, true);
    assert.notEqual(result.readiness, 'ready');
    assert.equal(result.readinessReason, failure);
    assert.equal(result.executionStatus, 'not-probed');
  }
});

test('native auth status requires recognized login evidence and never returns account data', async () => {
  for (const adapter of ['claude', 'codex']) {
    const [result] = await diagnoseProviders({ providers: [{ id: adapter, adapter, executable: adapter }], platform: 'linux',
      runCommandImpl: async (spec) => ({ exitCode: 0, stdout: spec.args[0] === '--version' ? 'v1'
        : adapter === 'claude' ? JSON.stringify({ loggedIn: true, email: 'private@example.test' }) : 'Logged in using ChatGPT' }) });
    assert.equal(result.readiness, 'ready');
    assert.equal(JSON.stringify(result).includes('private@example'), false);
  }
});
