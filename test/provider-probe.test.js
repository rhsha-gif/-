import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chooseProbeTask, probeProviders } from '../src/provider-probe.js';
import { selectRoute } from '../src/router.js';

const provider = { id: 'openai', adapter: 'codex', enabled: true };
const profile = (id, taskKinds, tokenIndex) => ({ id, provider: 'openai', model: id, automatic: false, enabled: true,
  roles: ['executor'], taskKinds, quality: { default: 0.9 }, maturity: 'stable', tokenIndex, latencyIndex: 1,
  efforts: [{ name: 'low', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1, complexities: ['low'] }] });
const config = { providers: [provider], capabilities: [], routing: { uncertaintyPenalty: 0 },
  models: [profile('incompatible', ['implementation'], 0.1), profile('read', ['exploration'], 1)] };

test('probe fallback skips cheap but incompatible profiles without changing promotion policy', () => {
  const task = chooseProbeTask(config, provider, null);
  assert.deepEqual(task.allowedProfileIds, ['read']);
  assert.equal(selectRoute({ task, catalog: config, observations: [] }).model, 'read');
  assert.equal(config.models[1].automatic, false);
});

test('explicit probe supports profiles whose minimum effort is standard', () => {
  const catalog = structuredClone(config);
  catalog.models = [catalog.models[1]];
  catalog.models[0].efforts[0].complexities = ['standard', 'high'];
  const task = chooseProbeTask(catalog, provider, null);
  assert.equal(task.complexity, 'standard');
  assert.equal(selectRoute({ task, catalog, observations: [] }).model, 'read');
});

test('parent verifies actual file value and detects unclaimed writes', async () => {
  for (const mode of ['correct', 'wrong-value', 'changed']) {
    const results = await probeProviders({ config, diagnoseImpl: async () => [{ id: 'openai', readiness: 'ready', version: 'fixture', models: ['read'] }],
      executeImpl: async ({ cwd, task, config: scoped, timeoutMs }) => {
        assert.equal(timeoutMs, 120000);
        assert.equal(scoped.learning.enabled, false);
        assert.equal(task.agentId, 'aorch-probe-reader');
        const value = (await readFile(path.join(cwd, 'evidence.txt'), 'utf8')).trim();
        assert.equal(task.objective.includes(value), false);
        if (mode === 'changed') await writeFile(path.join(cwd, 'unexpected.txt'), 'write');
        return { route: { model: 'read', profileId: 'read', effort: 'low' }, receipt: {
          status: 'complete', summary: mode === 'wrong-value' ? 'guessed' : value, filesChanged: [], filesInspected: ['evidence.txt'],
          criteria: [{ status: 'pass', evidence: value }]
        } };
      } });
    assert.equal(results[0].executionStatus, mode === 'correct' ? 'passed' : 'failed');
  }
});

test('blocked diagnostics do not launch a model', async () => {
  const results = await probeProviders({ config, diagnoseImpl: async () => [{ id: 'openai', readiness: 'blocked', executionStatus: 'not-probed' }],
    executeImpl: async () => { throw new Error('must not launch'); } });
  assert.equal(results[0].executionStatus, 'not-probed');
});
