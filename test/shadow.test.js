import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRoutePlan } from '../src/router.js';

const task = { id: 'T-shadow', kind: 'implementation', role: 'executor', risk: 'standard', complexity: 'standard', write: true };
const model = (id, provider, modelName, quality) => ({
  id, provider, model: modelName, enabled: true, roles: ['executor'], taskKinds: ['implementation'],
  quality: { implementation: quality }, tokenIndex: 1, latencyIndex: 1, maturity: 'stable',
  efforts: [{ name: 'medium', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1, complexities: ['standard'] }]
});
const catalog = {
  routing: { qualityTolerance: 0.02, tokenTolerance: 0.1, latencyTolerance: 0.1, priorWeight: 3, uncertaintyPenalty: 0 },
  providers: [
    { id: 'anthropic', trustTier: 'trusted', adapterMaturity: 'stable' },
    { id: 'openai', trustTier: 'trusted', adapterMaturity: 'stable' }
  ],
  models: [
    model('sonnet', 'anthropic', 'sonnet', 0.91),
    model('terra', 'openai', 'gpt-5.6-terra', 0.9),
    model('luna', 'openai', 'gpt-5.6-luna', 0.82)
  ]
};

test('record-only shadow selects an eligible alternative without a second write execution', () => {
  const plan = selectRoutePlan({
    task, catalog, observations: [], host: { selectionMode: 'bootstrap-only' },
    lane: { lane: 'orchestrated', budget: {} }, shadowMode: 'record-only'
  });
  assert.ok(plan.shadow);
  assert.notEqual(plan.shadow.profileId, plan.primary.profileId);
  assert.equal(plan.shadow.mode, 'record-only');
  assert.equal(plan.shadow.execute, false);
  assert.equal(plan.shadow.evidenceStatus, 'counterfactual-only');
  assert.match(plan.shadow.reason, /alternative|shadow/i);
});

test('shadow mode off creates no alternative', () => {
  const plan = selectRoutePlan({
    task, catalog, observations: [], host: { selectionMode: 'bootstrap-only' },
    lane: { lane: 'orchestrated', budget: {} }, shadowMode: 'off'
  });
  assert.equal(plan.shadow, null);
});

test('shadow route remains subject to provider and risk eligibility', () => {
  const restricted = {
    ...catalog,
    providers: [
      { id: 'anthropic', trustTier: 'trusted', adapterMaturity: 'stable' },
      { id: 'openai', trustTier: 'untrusted', adapterMaturity: 'stable' }
    ]
  };
  const plan = selectRoutePlan({
    task: { ...task, risk: 'high', complexity: 'high' },
    catalog: { ...restricted, models: restricted.models.map((entry) => ({ ...entry, efforts: [{ ...entry.efforts[0], complexities: ['high'] }] })) },
    observations: [], host: { selectionMode: 'bootstrap-only' },
    lane: { lane: 'orchestrated', budget: {} }, shadowMode: 'record-only'
  });
  assert.equal(plan.primary.provider, 'anthropic');
  assert.equal(plan.shadow, null);
});
