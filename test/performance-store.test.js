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
