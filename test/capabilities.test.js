import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCapabilities } from '../src/capabilities.js';

const inventory = [
  { id: 'tdd', type: 'skill', providers: ['anthropic', 'openai'], enabled: true },
  { id: 'browser', type: 'plugin', providers: ['anthropic'], enabled: true },
  { id: 'quality-gate', type: 'hook', providers: ['*'], enabled: true, phase: 'post' },
  { id: 'disabled', type: 'skill', providers: ['*'], enabled: false }
];

test('selects exact requested capabilities compatible with the provider', () => {
  const selected = selectCapabilities({
    requestedIds: ['tdd', 'quality-gate'], inventory, provider: 'openai'
  });
  assert.deepEqual(selected.skills.map((x) => x.id), ['tdd']);
  assert.deepEqual(selected.hooks.map((x) => x.id), ['quality-gate']);
});

test('maps Antigravity and Grok adapters to their native binding keys', () => {
  const portable = [{ id: 'portable', type: 'skill', providers: ['antigravity', 'grok'], enabled: true,
    bindings: {
      antigravity: { path: '/agy', mode: 'native', syncStatus: 'current' },
      grok: { path: '/grok', mode: 'native', syncStatus: 'current' }
    } }];
  assert.equal(selectCapabilities({ requestedIds: ['portable'], inventory: portable, provider: { id: 'agy-fast', adapter: 'antigravity' } }).skills[0].path, '/agy');
  assert.equal(selectCapabilities({ requestedIds: ['portable'], inventory: portable, provider: { id: 'grok-fast', adapter: 'grok' } }).skills[0].path, '/grok');
});

test('rejects a provider-incompatible plugin', () => {
  assert.throws(() => selectCapabilities({
    requestedIds: ['browser'], inventory, provider: 'openai'
  }), /not compatible/);
});

test('rejects unknown or disabled capabilities instead of silently guessing', () => {
  assert.throws(() => selectCapabilities({ requestedIds: ['missing'], inventory, provider: 'openai' }), /Unknown/);
  assert.throws(() => selectCapabilities({ requestedIds: ['disabled'], inventory, provider: 'openai' }), /disabled/);
});

test('enforces small context limits', () => {
  const many = Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, type: 'skill', providers: ['*'], enabled: true }));
  assert.throws(() => selectCapabilities({
    requestedIds: many.map((x) => x.id), inventory: many, provider: 'openai', limits: { skills: 3, plugins: 2, hooks: 3 }
  }), /skill limit/);
});

test('ambiguous capability IDs fail closed instead of allowing type shadowing', () => {
  const ambiguous = [
    { id: 'review', type: 'skill', providers: ['openai'], enabled: true },
    { id: 'review', type: 'plugin', providers: ['openai'], enabled: true }
  ];
  assert.throws(() => selectCapabilities({
    requestedIds: ['review'], inventory: ambiguous, provider: 'openai'
  }), /ambiguous capability id/i);
});
