import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRoute } from '../src/router.js';

const baseRouting = {
  qualityTolerance: 0.005,
  tokenTolerance: 0.05,
  observationHalfLifeDays: 30,
  priorWeight: 3,
  uncertaintyPenalty: 0,
  criticalMinimumSamples: 3
};

function model(overrides) {
  return {
    id: overrides.id,
    provider: overrides.provider ?? 'anthropic',
    model: overrides.model ?? overrides.id,
    enabled: true,
    roles: ['executor'],
    taskKinds: ['implementation'],
    quality: { default: 0.8, implementation: 0.8 },
    tokenIndex: 1,
    latencyIndex: 1,
    maturity: 'stable',
    efforts: [{ name: 'medium', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1 }],
    ...overrides
  };
}

const task = {
  id: 'T-quota',
  kind: 'implementation',
  role: 'executor',
  risk: 'standard',
  tags: []
};

// Two equivalent-quality profiles on different providers; the anthropic one is
// cheaper on tokens, so without a quota signal it wins the default routing.
function twoProviderCatalog(routing = baseRouting) {
  return {
    routing,
    models: [
      model({ id: 'claude-exec', provider: 'anthropic', tokenIndex: 1 }),
      model({ id: 'codex-exec', provider: 'openai', tokenIndex: 2 })
    ]
  };
}

test('without a quota map, routing and decision metadata are unchanged', () => {
  const route = selectRoute({ task, catalog: twoProviderCatalog(), observations: [] });
  assert.equal(route.profileId, 'claude-exec');
  assert.equal(route.decision.quota, null);
  assert.ok(route.decision.stageCounts.every((stage) => stage.metric !== 'quota'));
});

test('a depleted provider is excluded when an alternative survives', () => {
  const route = selectRoute({
    task,
    catalog: twoProviderCatalog(),
    observations: [],
    quota: { anthropic: 4, openai: 80 }
  });
  assert.equal(route.provider, 'openai');
  assert.deepEqual(route.decision.quota.excludedProviders, ['anthropic']);
});

test('exclusion rolls back when every candidate provider is depleted', () => {
  const route = selectRoute({
    task,
    catalog: twoProviderCatalog(),
    observations: [],
    quota: { anthropic: 3, openai: 2 }
  });
  // Quota must degrade to a preference, never produce an empty candidate set.
  assert.equal(route.profileId, 'claude-exec');
  assert.deepEqual(route.decision.quota.excludedProviders, []);
});

test('soft preference picks the comfortable provider inside the quality tie', () => {
  const route = selectRoute({
    task,
    catalog: twoProviderCatalog(),
    observations: [],
    quota: { anthropic: 25, openai: 80 }
  });
  // Tokens alone would keep claude-exec; the quota preference fires first,
  // inside the quality-equivalent tier, so the pricier-but-comfortable
  // provider wins without breaching the quality floor.
  assert.equal(route.provider, 'openai');
  assert.equal(route.decision.quota.softPreferenceApplied, true);
  assert.ok(route.decision.stageCounts.some((stage) => stage.metric === 'quota'));
});

test('soft preference is a no-op when every provider is low or every provider is comfortable', () => {
  const bothLow = selectRoute({
    task,
    catalog: twoProviderCatalog(),
    observations: [],
    quota: { anthropic: 20, openai: 15 }
  });
  assert.equal(bothLow.profileId, 'claude-exec');
  assert.equal(bothLow.decision.quota.softPreferenceApplied, false);

  const bothComfortable = selectRoute({
    task,
    catalog: twoProviderCatalog(),
    observations: [],
    quota: { anthropic: 90, openai: 80 }
  });
  assert.equal(bothComfortable.profileId, 'claude-exec');
  assert.equal(bothComfortable.decision.quota.softPreferenceApplied, false);
});

test('unknown quota is no signal: absent and non-finite entries leave routing alone', () => {
  for (const quota of [{}, { anthropic: null }, { anthropic: 'lots' }, { openai: Number.NaN }]) {
    const route = selectRoute({ task, catalog: twoProviderCatalog(), observations: [], quota });
    assert.equal(route.profileId, 'claude-exec', `quota ${JSON.stringify(quota)} should not move the route`);
    assert.equal(route.decision.quota.softPreferenceApplied, false);
    assert.deepEqual(route.decision.quota.excludedProviders, []);
  }
});

test('routing.quota thresholds override the 40/10 defaults', () => {
  const catalog = twoProviderCatalog({
    ...baseRouting,
    quota: { softThresholdPercent: 60, hardThresholdPercent: 30 }
  });
  const route = selectRoute({
    task,
    catalog,
    observations: [],
    quota: { anthropic: 45, openai: 80 }
  });
  // 45% is comfortable under the defaults but low under the raised threshold.
  assert.equal(route.provider, 'openai');
  assert.equal(route.decision.quota.softThresholdPercent, 60);
  assert.equal(route.decision.quota.hardThresholdPercent, 30);
});

test('with tokens-first priorities the preference fires inside the token tie instead', () => {
  const catalog = {
    routing: baseRouting,
    models: [
      model({ id: 'claude-exec', provider: 'anthropic', tokenIndex: 1 }),
      model({ id: 'codex-exec', provider: 'openai', tokenIndex: 1.02 })
    ]
  };
  const route = selectRoute({
    task: { ...task, routingPriorities: ['tokens', 'quality', 'latency'], minimumQuality: 0.5 },
    catalog,
    observations: [],
    quota: { anthropic: 25, openai: 80 }
  });
  assert.equal(route.provider, 'openai');
  assert.equal(route.decision.quota.softPreferenceApplied, true);
});

test('the decision snapshot echoes the quota map it was given', () => {
  const route = selectRoute({
    task,
    catalog: twoProviderCatalog(),
    observations: [],
    quota: { anthropic: 55, openai: 12 }
  });
  assert.deepEqual(route.decision.quota.remainingByProvider, { anthropic: 55, openai: 12 });
});
