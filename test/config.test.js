import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, validateConfig } from '../src/config.js';

function minimalConfig() {
  return {
    version: 1,
    routing: { qualityTolerance: 0.01, tokenTolerance: 0.05 },
    providers: [
      { id: 'newco', adapter: 'generic', enabled: true, executable: 'newcli', args: ['run', '--model', '{model}', '-'] }
    ],
    models: [
      {
        id: 'newco-best', provider: 'newco', model: 'new-model', enabled: true,
        roles: ['executor'], taskKinds: ['implementation'], maturity: 'challenger',
        quality: { default: 0.8, implementation: 0.82 }, tokenIndex: 1, latencyIndex: 1,
        efforts: [{ name: 'high', qualityDelta: 0.02, tokenMultiplier: 1.2, latencyMultiplier: 1.2 }]
      }
    ],
    capabilities: [],
    paths: { stateDir: '.aorch' }
  };
}

test('a new provider and model can be added through configuration only', () => {
  const config = validateConfig(minimalConfig());
  assert.equal(config.providers[0].id, 'newco');
  assert.equal(config.models[0].provider, 'newco');
});

test('loadConfig reads a project-supplied catalog without core changes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aorch-config-'));
  const configPath = path.join(dir, 'custom.json');
  await writeFile(configPath, JSON.stringify(minimalConfig()));
  const config = await loadConfig({ configPath });
  assert.equal(config.models[0].model, 'new-model');
});

test('invalid provider references are rejected early', () => {
  const config = minimalConfig();
  config.models[0].provider = 'missing';
  assert.throws(() => validateConfig(config), /unknown provider/i);
});

test('independent verification timeout must be positive', () => {
  const config = minimalConfig();
  config.verification = { commandTimeoutMs: 0 };
  assert.throws(() => validateConfig(config), /verification\.commandTimeoutMs/i);
});


test('routing defaults require a unique supported priority order', () => {
  const config = minimalConfig();
  config.routing.defaultPriorities = ['quality', 'quality'];
  assert.throws(() => validateConfig(config), /routing\.defaultPriorities/i);

  config.routing.defaultPriorities = ['quality', 'cost'];
  assert.throws(() => validateConfig(config), /routing\.defaultPriorities/i);
});

test('routing tolerances must be finite and non-negative', () => {
  for (const field of ['qualityTolerance', 'tokenTolerance', 'latencyTolerance']) {
    const config = minimalConfig();
    config.routing[field] = -0.01;
    assert.throws(() => validateConfig(config), new RegExp(`routing\\.${field}`, 'i'));
  }
});

test('routing defaults are normalized without imposing a task-specific objective', () => {
  const config = minimalConfig();
  delete config.routing.defaultPriorities;
  const validated = validateConfig(config);
  assert.deepEqual(validated.routing.defaultPriorities, ['quality', 'tokens', 'latency']);
  assert.equal(validated.routing.selectionPolicy, 'task-specific-priority-order');
});

test('model cost indices and effort variants reject malformed catalog entries', () => {
  const badToken = minimalConfig();
  badToken.models[0].tokenIndex = 0;
  assert.throws(() => validateConfig(badToken), /tokenIndex/i);

  const badLatency = minimalConfig();
  badLatency.models[0].latencyIndex = -1;
  assert.throws(() => validateConfig(badLatency), /latencyIndex/i);

  const duplicateEffort = minimalConfig();
  duplicateEffort.models[0].efforts.push({ ...duplicateEffort.models[0].efforts[0] });
  assert.throws(() => validateConfig(duplicateEffort), /effort.*duplicate|duplicate.*effort/i);

  const badMultiplier = minimalConfig();
  badMultiplier.models[0].efforts[0].tokenMultiplier = 0;
  assert.throws(() => validateConfig(badMultiplier), /tokenMultiplier/i);
});

test('routing evidence controls reject values that make adaptation unstable', () => {
  const cases = [
    ['observationHalfLifeDays', 0],
    ['priorWeight', -1],
    ['uncertaintyPenalty', -0.1],
    ['criticalMinimumSamples', -1]
  ];
  for (const [field, value] of cases) {
    const config = minimalConfig();
    config.routing[field] = value;
    assert.throws(() => validateConfig(config), new RegExp(`routing\\.${field}`, 'i'));
  }
});

test('effort profiles can declare supported task complexities', () => {
  const config = minimalConfig();
  config.models[0].efforts[0].complexities = ['standard', 'high'];
  assert.deepEqual(validateConfig(config).models[0].efforts[0].complexities, ['standard', 'high']);

  config.models[0].efforts[0].complexities = ['standard', 'unknown'];
  assert.throws(() => validateConfig(config), /complexities/i);
});

test('escalation defaults exist without configuration', () => {
  const validated = validateConfig(minimalConfig());
  assert.equal(validated.escalation.maxAttempts, 3);
  assert.deepEqual(validated.escalation.ladders, {});
});

test('escalation ladders must reference known providers, profiles, and efforts', () => {
  const config = minimalConfig();
  config.escalation = { maxAttempts: 3, ladders: { newco: [{ profileId: 'newco-best', effort: 'high' }] } };
  const validated = validateConfig(config);
  assert.deepEqual(validated.escalation.ladders.newco, [{ profileId: 'newco-best', effort: 'high' }]);

  config.escalation = { ladders: { newco: [{ profileId: 'newco-best', effort: 'mystery' }] } };
  assert.throws(() => validateConfig(config), /unknown effort/i);

  config.escalation = { ladders: { ghost: [] } };
  assert.throws(() => validateConfig(config), /unknown provider/i);

  config.escalation = { ladders: { newco: [{ profileId: 'ghost-model', effort: 'high' }] } };
  assert.throws(() => validateConfig(config), /unknown profile/i);

  config.escalation = { maxAttempts: 0 };
  assert.throws(() => validateConfig(config), /escalation\.maxAttempts/i);
});

test('escalation ladder steps must stay on their own provider', () => {
  const config = minimalConfig();
  config.providers.push({ id: 'otherco', adapter: 'generic', enabled: true, executable: 'other', args: ['run'] });
  config.escalation = { ladders: { otherco: [{ profileId: 'newco-best', effort: 'high' }] } };
  assert.throws(() => validateConfig(config), /belongs to provider/i);
});

test('control-plane validates the experimental adapter risk ceiling', () => {
  const config = minimalConfig();
  config.controlPlane = { experimentalAdapterMaxRisk: 'standard' };
  assert.equal(validateConfig(config).controlPlane.experimentalAdapterMaxRisk, 'standard');
  config.controlPlane.experimentalAdapterMaxRisk = 'mystery';
  assert.throws(() => validateConfig(config), /experimentalAdapterMaxRisk/i);
});

