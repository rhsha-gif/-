import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateRouteQuality, normalizeObservation } from '../src/performance-store.js';

test('older evidence decays while recent evidence remains influential', () => {
  const now = new Date('2026-07-16T00:00:00Z');
  const route = { provider: 'openai', profileId: 'codex', model: 'gpt', effort: 'high' };
  const task = { kind: 'debugging', role: 'executor' };
  const estimate = estimateRouteQuality({
    route,
    task,
    priorQuality: 0.8,
    observations: [
      normalizeObservation({ ...route, taskKind: 'debugging', role: 'executor', quality: 0.1, recordedAt: '2025-07-16T00:00:00Z' }),
      normalizeObservation({ ...route, taskKind: 'debugging', role: 'executor', quality: 1.0, recordedAt: '2026-07-15T00:00:00Z' })
    ],
    now,
    halfLifeDays: 30,
    priorWeight: 1,
    uncertaintyPenalty: 0
  });

  assert.ok(estimate.mean > 0.85, `expected recent success to dominate, got ${estimate.mean}`);
  assert.ok(estimate.effectiveSamples > 0.9 && estimate.effectiveSamples < 1.1);
});

test('invalid quality observations are rejected', () => {
  assert.throws(() => normalizeObservation({
    provider: 'openai', profileId: 'codex', model: 'gpt', effort: 'high',
    taskKind: 'debugging', role: 'executor', quality: 1.2, recordedAt: new Date().toISOString()
  }), /quality/);
});

test('performance evidence requires a complete route and task identity', () => {
  assert.throws(() => normalizeObservation({
    provider: 'openai', quality: 0.9, recordedAt: new Date().toISOString()
  }), /profileId/i);
});

test('performance evidence is stratified by task risk and complexity', () => {
  const route = { provider: 'openai', profileId: 'codex', model: 'gpt', effort: 'high' };
  const task = { kind: 'implementation', role: 'executor', risk: 'critical', complexity: 'high' };
  const estimate = estimateRouteQuality({
    route,
    task,
    priorQuality: 0.8,
    observations: [
      normalizeObservation({
        ...route,
        taskKind: 'implementation', role: 'executor', risk: 'low', complexity: 'low',
        quality: 1, recordedAt: '2026-07-16T00:00:00Z'
      }),
      normalizeObservation({
        ...route,
        taskKind: 'implementation', role: 'executor', risk: 'critical', complexity: 'high',
        quality: 0.4, recordedAt: '2026-07-16T00:00:00Z'
      })
    ],
    now: new Date('2026-07-16T01:00:00Z'),
    priorWeight: 1,
    uncertaintyPenalty: 0
  });

  assert.equal(estimate.rawSamples, 1);
  assert.ok(estimate.mean < 0.7, `expected only critical/high evidence to apply, got ${estimate.mean}`);
});

test('model revision prevents stale alias evidence from transferring to a replacement model', () => {
  const route = { provider: 'openai', profileId: 'terra', model: 'gpt-5.6-terra', modelRevision: '2026-07', effort: 'high' };
  const estimate = estimateRouteQuality({
    route,
    task: { kind: 'implementation', role: 'executor', risk: 'standard', complexity: 'standard' },
    priorQuality: 0.8,
    observations: [normalizeObservation({
      ...route, modelRevision: '2026-06', taskKind: 'implementation', role: 'executor', risk: 'standard', complexity: 'standard',
      quality: 1, recordedAt: '2026-07-16T00:00:00Z'
    })],
    now: new Date('2026-07-17T00:00:00Z'), priorWeight: 1, uncertaintyPenalty: 0
  });
  assert.equal(estimate.rawSamples, 0);
  assert.equal(estimate.diagnostics.revisionMismatch, 1);
  assert.equal(estimate.mean, 0.8);
});

test('expired and future observations are excluded with diagnostics', () => {
  const route = { provider: 'openai', profileId: 'terra', model: 'gpt-5.6-terra', modelRevision: '2026-07', effort: 'high' };
  const baseObservation = {
    ...route, taskKind: 'implementation', role: 'executor', risk: 'standard', complexity: 'standard', quality: 1
  };
  const estimate = estimateRouteQuality({
    route,
    task: { kind: 'implementation', role: 'executor', risk: 'standard', complexity: 'standard' },
    priorQuality: 0.75,
    observations: [
      normalizeObservation({ ...baseObservation, recordedAt: '2025-01-01T00:00:00Z' }),
      normalizeObservation({ ...baseObservation, recordedAt: '2026-07-18T00:00:00Z' })
    ],
    now: new Date('2026-07-17T00:00:00Z'), maxObservationAgeDays: 180, maxFutureSkewMinutes: 5,
    priorWeight: 1, uncertaintyPenalty: 0
  });
  assert.equal(estimate.rawSamples, 0);
  assert.equal(estimate.diagnostics.stale, 1);
  assert.equal(estimate.diagnostics.future, 1);
});

test('signature-tagged evidence applies only to compatible task signatures', () => {
  const route = { provider: 'openai', profileId: 'terra', model: 'gpt-5.6-terra', modelRevision: '2026-07', effort: 'high' };
  const estimate = estimateRouteQuality({
    route,
    task: {
      kind: 'implementation', role: 'executor', risk: 'standard', complexity: 'standard',
      signature: { repositoryBreadth: 'wide', stateComplexity: 'complex' }
    },
    priorQuality: 0.8,
    observations: [normalizeObservation({
      ...route, taskKind: 'implementation', role: 'executor', risk: 'standard', complexity: 'standard',
      taskSignature: { repositoryBreadth: 'local', stateComplexity: 'none' }, quality: 1,
      recordedAt: '2026-07-16T00:00:00Z'
    })],
    now: new Date('2026-07-17T00:00:00Z'), priorWeight: 1, uncertaintyPenalty: 0
  });
  assert.equal(estimate.rawSamples, 0);
  assert.equal(estimate.diagnostics.signatureMismatch, 1);
});

test('observation complexity defaults by risk so low-risk evidence matches low-risk routing', () => {
  const route = { provider: 'openai', profileId: 'p', model: 'm', modelRevision: 'm', effort: 'high' };
  const task = { kind: 'implementation', role: 'executor', risk: 'low', complexity: 'low', signature: {} };
  const estimate = estimateRouteQuality({
    route,
    task,
    priorQuality: 0.5,
    observations: [{
      provider: 'openai', profileId: 'p', model: 'm', effort: 'high',
      taskKind: 'implementation', role: 'executor', risk: 'low',
      quality: 1, recordedAt: new Date().toISOString()
    }],
    now: new Date()
  });
  assert.equal(estimate.rawSamples, 1);
  assert.ok(estimate.mean > 0.5);
});
