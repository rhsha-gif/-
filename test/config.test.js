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
    progress: { intervalMinutes: 30 },
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

test('provider and capability trust metadata are validated and normalized', () => {
  const config = minimalConfig();
  config.providers[0].trustTier = 'trusted';
  config.providers[0].adapterMaturity = 'stable';
  config.capabilities = [{ id: 'safe-skill', type: 'skill', providers: ['newco'], enabled: true, trustTier: 'reviewed' }];
  const validated = validateConfig(config);
  assert.equal(validated.providers[0].trustTier, 'trusted');
  assert.equal(validated.providers[0].adapterMaturity, 'stable');
  assert.equal(validated.capabilities[0].trustTier, 'reviewed');

  config.providers[0].trustTier = 'root';
  assert.throws(() => validateConfig(config), /trustTier/i);
});

test('control-plane trust policy rejects unsupported risk tiers and trust values', () => {
  const config = minimalConfig();
  config.controlPlane = {
    providerTrustByRisk: { low: ['trusted'], standard: ['trusted'], high: ['trusted'], critical: ['trusted'] },
    capabilityTrustByRisk: { low: ['trusted'], standard: ['trusted'], high: ['trusted'], critical: ['trusted'] },
    experimentalAdapterMaxRisk: 'standard'
  };
  assert.equal(validateConfig(config).controlPlane.experimentalAdapterMaxRisk, 'standard');
  config.controlPlane.providerTrustByRisk.critical = ['mystery'];
  assert.throws(() => validateConfig(config), /providerTrustByRisk/i);
});

test('standard-risk verification defaults to an isolated Git worktree', () => {
  const validated = validateConfig(minimalConfig());
  assert.equal(validated.verification.isolationByRisk.standard, 'git-worktree');
  assert.equal(validated.verification.isolationByRisk.low, 'same-workspace');
});

test('host and lane policies normalize conservative defaults', () => {
  const validated = validateConfig(minimalConfig());
  assert.equal(validated.hostPolicy.selectionMode, 'preferred');
  assert.equal(validated.hostPolicy.executionMode, 'bootstrap-only');
  assert.equal(validated.hostPolicy.allowHostProductEdits, false);
  assert.equal(validated.lanePolicy['single-worker'].maxExternalModelCalls, 1);
  assert.equal(validated.lanePolicy.bundled.maxExternalModelCalls, 1);
  assert.equal(validated.lanePolicy.orchestrated.maxTasks, 24);
});

test('host and lane policies reject unsafe or ambiguous values', () => {
  const invalidMode = minimalConfig();
  invalidMode.hostPolicy = { selectionMode: 'magic' };
  assert.throws(() => validateConfig(invalidMode), /hostPolicy\.selectionMode/i);

  const invalidBudget = minimalConfig();
  invalidBudget.lanePolicy = { 'single-worker': { maxTasks: 0 } };
  assert.throws(() => validateConfig(invalidBudget), /lanePolicy\.single-worker\.maxTasks/i);
});

test('model revisions and observation freshness defaults are explicit', () => {
  const config = minimalConfig();
  const validated = validateConfig(config);
  assert.equal(validated.models[0].revision, 'new-model');
  assert.equal(validated.routing.maxObservationAgeDays, 180);
  assert.equal(validated.routing.maxFutureSkewMinutes, 5);

  config.routing.maxObservationAgeDays = 0;
  assert.throws(() => validateConfig(config), /maxObservationAgeDays/i);
});

test('model prompt profile references are explicit non-empty IDs', () => {
  const config = minimalConfig();
  config.models[0].promptProfileIds = ['openai-codex-terra-v1'];
  assert.deepEqual(validateConfig(config).models[0].promptProfileIds, ['openai-codex-terra-v1']);

  config.models[0].promptProfileIds = [''];
  assert.throws(() => validateConfig(config), /promptProfileIds/i);
});

test('prompt compilation policy bounds generated prompts and keeps official-source enforcement enabled', () => {
  const validated = validateConfig(minimalConfig());
  assert.equal(validated.promptCompilation.maxChars, 40000);
  assert.equal(validated.promptCompilation.officialSourcesOnly, true);

  const invalid = minimalConfig();
  invalid.promptCompilation = { maxChars: 0 };
  assert.throws(() => validateConfig(invalid), /promptCompilation\.maxChars/i);
  const unsafe = minimalConfig();
  unsafe.promptCompilation = { officialSourcesOnly: false };
  assert.throws(() => validateConfig(unsafe), /officialSourcesOnly/i);
});

test('record-only shadow routing is the safe P2 default and executable shadows are rejected', () => {
  const validated = validateConfig(minimalConfig());
  assert.equal(validated.shadowRouting.mode, 'record-only');
  assert.equal(validated.shadowRouting.execute, false);

  const off = minimalConfig();
  off.shadowRouting = { mode: 'off' };
  assert.equal(validateConfig(off).shadowRouting.mode, 'off');

  const unsafe = minimalConfig();
  unsafe.shadowRouting = { mode: 'record-only', execute: true };
  assert.throws(() => validateConfig(unsafe), /shadowRouting\.execute.*false/i);

  const invalid = minimalConfig();
  invalid.shadowRouting = { mode: 'execute' };
  assert.throws(() => validateConfig(invalid), /shadowRouting\.mode/i);
});

test('execution and verification budgets normalize conservative defaults', () => {
  const validated = validateConfig(minimalConfig());
  assert.equal(validated.execution.workerTimeoutMs, 60 * 60 * 1000);
  assert.equal(validated.execution.killGraceMs, 1000);
  assert.equal(validated.execution.maxOutputBytes, 10 * 1024 * 1024);
  assert.equal(validated.execution.maxReceiptBytes, 2 * 1024 * 1024);
  assert.equal(validated.verification.totalTimeoutMs, 30 * 60 * 1000);
  assert.equal(validated.verification.maxOutputBytes, 8 * 1024 * 1024);
  assert.equal(validated.verification.maxChecks, 20);
});

test('execution and verification budgets reject non-positive or ambiguous values', () => {
  const cases = [
    ['execution', 'workerTimeoutMs', -1],
    ['execution', 'killGraceMs', -1],
    ['execution', 'maxOutputBytes', 0],
    ['execution', 'maxReceiptBytes', 0],
    ['verification', 'totalTimeoutMs', 0],
    ['verification', 'maxOutputBytes', 0],
    ['verification', 'maxChecks', 0]
  ];
  for (const [section, field, value] of cases) {
    const config = minimalConfig();
    config[section] = { ...(config[section] ?? {}), [field]: value };
    assert.throws(() => validateConfig(config), new RegExp(`${section}\\.${field}`, 'i'));
  }
});

test('orchestration task budget defaults conservatively and rejects oversized values', () => {
  assert.equal(validateConfig(minimalConfig()).orchestration.maxTasksPerRun, 24);
  const explicit = minimalConfig();
  explicit.orchestration = { maxTasksPerRun: 8 };
  assert.equal(validateConfig(explicit).orchestration.maxTasksPerRun, 8);
  for (const value of [0, 101, 1.5, '24']) {
    const invalid = minimalConfig();
    invalid.orchestration = { maxTasksPerRun: value };
    assert.throws(() => validateConfig(invalid), /maxTasksPerRun/i);
  }
});


test('legacy lanePolicy.direct migrates to single-worker without enabling host edits', () => {
  const config = minimalConfig();
  config.lanePolicy = { direct: { maxTasks: 1, maxExternalModelCalls: 1, maxLlmReviewers: 0 } };
  const validated = validateConfig(config);
  assert.equal(validated.lanePolicy['single-worker'].maxExternalModelCalls, 1);
  assert.equal(validated.lanePolicy.direct, undefined);
  assert.equal(validated.hostPolicy.executionMode, 'bootstrap-only');
});

test('prompt profile freshness policy is explicit and bounded', () => {
  const defaults = validateConfig(minimalConfig()).promptCompilation;
  assert.equal(defaults.maxProfileAgeDays, 120);
  assert.equal(defaults.maxFutureSkewDays, 1);

  for (const [field, value] of [['maxProfileAgeDays', 0], ['maxFutureSkewDays', -1], ['maxProfileAgeDays', '120']]) {
    const config = minimalConfig();
    config.promptCompilation = { [field]: value };
    assert.throws(() => validateConfig(config), new RegExp(`promptCompilation\\.${field}`, 'i'));
  }
});
