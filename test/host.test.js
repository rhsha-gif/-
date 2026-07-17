import test from 'node:test';
import assert from 'node:assert/strict';
import { hostMatchesRoute, normalizeHostContext } from '../src/host.js';

test('normalizes explicit host identity and selection mode', () => {
  const host = normalizeHostContext({
    provider: 'anthropic', requestedModel: 'sonnet', resolvedModel: 'claude-sonnet-5',
    requestedEffort: 'high', effectiveEffort: 'high', selectionMode: 'preferred', source: 'explicit'
  }, {});
  assert.deepEqual(host, {
    provider: 'anthropic', requestedModel: 'sonnet', resolvedModel: 'claude-sonnet-5',
    requestedEffort: 'high', effectiveEffort: 'high', selectionMode: 'preferred',
    executionMode: 'bootstrap-only', allowHostProductEdits: false, source: 'explicit',
    subagentModelOverride: null, identityKnown: true
  });
});

test('documented Claude effort environment override becomes the effective effort', () => {
  const host = normalizeHostContext({
    provider: 'anthropic', requestedModel: 'sonnet', requestedEffort: 'medium', selectionMode: 'preferred'
  }, { CLAUDE_CODE_EFFORT_LEVEL: 'xhigh', CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' });
  assert.equal(host.effectiveEffort, 'xhigh');
  assert.equal(host.subagentModelOverride, 'haiku');
  assert.equal(host.source, 'environment');
});

test('unknown host identity remains explicit rather than guessed', () => {
  const host = normalizeHostContext({}, {});
  assert.equal(host.provider, null);
  assert.equal(host.resolvedModel, null);
  assert.equal(host.identityKnown, false);
  assert.equal(host.selectionMode, 'preferred');
  assert.equal(host.source, 'unknown');
});

test('host mode and effort values fail closed when invalid', () => {
  assert.throws(() => normalizeHostContext({ selectionMode: 'magic' }, {}), /selectionMode/i);
  assert.throws(() => normalizeHostContext({ requestedEffort: 'infinite' }, {}), /effort/i);
});

test('host matching accepts requested or resolved model but requires provider identity', () => {
  const host = normalizeHostContext({ provider: 'anthropic', requestedModel: 'sonnet', resolvedModel: 'claude-sonnet-5' }, {});
  assert.equal(hostMatchesRoute(host, { provider: 'anthropic', model: 'claude-sonnet-5' }), true);
  assert.equal(hostMatchesRoute(host, { provider: 'anthropic', model: 'sonnet' }), true);
  assert.equal(hostMatchesRoute(host, { provider: 'openai', model: 'sonnet' }), false);
});
