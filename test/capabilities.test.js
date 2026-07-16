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

test('untrusted capabilities require explicit low-risk read-only opt-in', () => {
  const risky = [{ id: 'untrusted-plugin', type: 'plugin', providers: ['openai'], enabled: true, trustTier: 'untrusted' }];
  assert.throws(() => selectCapabilities({
    requestedIds: ['untrusted-plugin'], inventory: risky, provider: 'openai',
    task: { risk: 'low', write: false }
  }), /untrusted/i);

  const selected = selectCapabilities({
    requestedIds: ['untrusted-plugin'], inventory: risky, provider: 'openai',
    task: { risk: 'low', write: false, allowUntrustedCapabilities: true }
  });
  assert.equal(selected.plugins[0].id, 'untrusted-plugin');

  assert.throws(() => selectCapabilities({
    requestedIds: ['untrusted-plugin'], inventory: risky, provider: 'openai',
    task: { risk: 'standard', write: false, allowUntrustedCapabilities: true }
  }), /only allowed on low-risk tasks/i);

  assert.throws(() => selectCapabilities({
    requestedIds: ['untrusted-plugin'], inventory: risky, provider: 'openai',
    task: { risk: 'low', write: true, allowUntrustedCapabilities: true }
  }), /not allowed on a write task/i);
});

test('critical tasks accept only trusted capabilities', () => {
  const reviewed = [{ id: 'reviewed-skill', type: 'skill', providers: ['openai'], enabled: true, trustTier: 'reviewed' }];
  assert.throws(() => selectCapabilities({
    requestedIds: ['reviewed-skill'], inventory: reviewed, provider: 'openai',
    task: { risk: 'critical', write: true }
  }), /trust tier/i);
});

test('ambiguous capability IDs fail closed instead of allowing type shadowing', () => {
  const ambiguous = [
    { id: 'review', type: 'skill', providers: ['openai'], enabled: true, trustTier: 'trusted' },
    { id: 'review', type: 'plugin', providers: ['openai'], enabled: true, trustTier: 'untrusted' }
  ];
  assert.throws(() => selectCapabilities({
    requestedIds: ['review'], inventory: ambiguous, provider: 'openai',
    task: { risk: 'low', write: false, allowUntrustedCapabilities: true }
  }), /ambiguous capability id/i);
});
