import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyExecutionLane } from '../src/lane.js';
import { normalizeHostContext } from '../src/host.js';

const host = normalizeHostContext({ provider: 'openai', resolvedModel: 'gpt-5.6-terra', selectionMode: 'preferred' }, {});
const base = {
  id: 'T-lane', objective: 'Fix a local bug', kind: 'implementation', role: 'executor', risk: 'low', complexity: 'low',
  write: true, allowedScope: ['src/local.js'], acceptanceCriteria: ['focused test passes'],
  verificationCommands: ['node --test test/local.test.js'], verifierCommands: [], capabilityIds: [],
  signature: {
    ambiguity: 'low', repositoryBreadth: 'local', editBreadth: 'few-files', contextVolume: 'small',
    toolIntensity: 'medium', stateComplexity: 'none', testCoverage: 'good', externalIntegration: 'none',
    language: 'javascript', framework: 'node'
  }
};

test('low-risk simple work uses one delegated single-worker call', () => {
  const decision = classifyExecutionLane({ task: base, host, hostEligible: true });
  assert.equal(decision.lane, 'single-worker');
  assert.equal(decision.budget.maxExternalModelCalls, 1);
  assert.equal(decision.budget.maxLlmReviewers, 0);
  assert.match(decision.reason, /single|coherent|low-risk/i);
});

test('low-risk broader work becomes one bundled specialist call', () => {
  const decision = classifyExecutionLane({
    task: { ...base, signature: { ...base.signature, repositoryBreadth: 'module', editBreadth: 'many-files', contextVolume: 'medium' } },
    host, hostEligible: true
  });
  assert.equal(decision.lane, 'bundled');
  assert.equal(decision.budget.maxExternalModelCalls, 1);
});

test('standard and high-risk work is orchestrated', () => {
  assert.equal(classifyExecutionLane({ task: { ...base, risk: 'standard', complexity: 'standard' }, host, hostEligible: true }).lane, 'orchestrated');
  assert.equal(classifyExecutionLane({ task: { ...base, risk: 'high', complexity: 'high' }, host, hostEligible: true }).lane, 'orchestrated');
});

test('unknown host still uses a delegated single-worker lane for coherent low-risk work', () => {
  const decision = classifyExecutionLane({ task: base, host: normalizeHostContext({}, {}), hostEligible: false });
  assert.equal(decision.lane, 'single-worker');
  assert.match(decision.reason, /single|delegat|worker/i);
});

test('stateful or mutating external work escalates regardless of low declared risk', () => {
  const stateful = { ...base, signature: { ...base.signature, stateComplexity: 'complex' } };
  const external = { ...base, signature: { ...base.signature, externalIntegration: 'mutating' } };
  assert.equal(classifyExecutionLane({ task: stateful, host, hostEligible: true }).lane, 'orchestrated');
  assert.equal(classifyExecutionLane({ task: external, host, hostEligible: true }).lane, 'orchestrated');
});

test('an explicit escalation signal only moves toward stronger orchestration', () => {
  const decision = classifyExecutionLane({ task: { ...base, escalationSignals: ['scope-expanded'] }, host, hostEligible: true });
  assert.equal(decision.lane, 'orchestrated');
  assert.equal(decision.escalated, true);
});

test('tasks whose write scope can touch protected control-plane files cannot use single-worker or bundled lanes', () => {
  const protectedTask = { ...base, allowedScope: ['.aorch/**'] };
  const decision = classifyExecutionLane({
    task: protectedTask,
    host,
    hostEligible: true,
    protectedFiles: ['.aorch/config.json']
  });
  assert.equal(decision.lane, 'orchestrated');
  assert.match(decision.reason, /protected control-plane/i);
});

test('explicit lanes may strengthen but never weaken the classifier result', async () => {
  const { resolveExecutionLane } = await import('../src/lane.js');
  const highRisk = { ...base, risk: 'high', complexity: 'high', executionLane: 'single-worker' };
  const denied = resolveExecutionLane({ task: highRisk, policy: undefined, protectedFiles: [] });
  assert.equal(denied.lane, 'orchestrated');
  assert.equal(denied.requestedLane, 'single-worker');
  assert.match(denied.reason, /denied|downgrade|stronger/i);

  const strengthened = resolveExecutionLane({
    task: { ...base, executionLane: 'orchestrated', laneReason: 'Use independent review.' },
    policy: undefined,
    protectedFiles: []
  });
  assert.equal(strengthened.lane, 'orchestrated');
  assert.equal(strengthened.baseLane, 'single-worker');
  assert.equal(strengthened.requestedLane, 'orchestrated');
});
