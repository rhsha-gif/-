import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeWithVerification } from '../src/run-loop.js';
import { dispatchPlan } from '../src/dispatch.js';
import { continuationPlan, planFingerprint, resumeOnce } from '../src/continuation.js';
import { normalizeReceiptInputRequest, strictReceiptSchema } from '../src/receipts.js';
import { selectRoute, forceRoute } from '../src/router.js';
import { loadConfig } from '../src/config.js';

const request = { kind: 'approval', questions: [{ id: 'scope', prompt: 'May the pending operation proceed?' }] };
const blocked = { status: 'blocked', summary: 'Inspection complete; pending authorization.', filesChanged: [], criteria: [], inputRequest: request };
const task = { id: 'ask', kind: 'implementation', agentRole: 'worker', role: 'executor', risk: 'standard', objective: 'Inspect, then ask before the pending operation.', acceptanceCriteria: ['Use explicit authorization'], allowedScope: ['src'], verificationCommands: ['verify'] };
const route = { provider: 'anthropic', profileId: 'fixture', model: 'fixture', effort: 'high' };

test('input waits only after the change guard and never verifies, escalates or records model failure', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-input-'));
  const events = [];
  const execution = await executeWithVerification({ task, cwd, config: { escalation: { maxAttempts: 3 } }, observationsPath: path.join(cwd, 'observations'),
    executeTaskImpl: async () => { events.push('execute'); return { route, runDir: cwd, receipt: blocked }; },
    captureGitSnapshotImpl: async () => ({}), evaluateChangeGuardImpl: () => { events.push('guard'); return { passed: true }; },
    runVerificationImpl: async () => { throw new Error('must not verify'); }, appendObservationImpl: async () => { throw new Error('must not grade'); }
  });
  assert.equal(execution.status, 'awaiting-input');
  assert.deepEqual(events, ['execute', 'guard']);
  assert.equal(execution.attempts.length, 1);
  assert.equal(execution.attempts[0].passed, null);
  await assert.rejects(executeWithVerification({ task, cwd, config: {}, executeTaskImpl: async () => ({ route, runDir: cwd, receipt: blocked }), captureGitSnapshotImpl: async () => ({}), evaluateChangeGuardImpl: () => ({ passed: false }) }), /Change guard failed/);
});

test('dispatch stops for input and continuation runs only the waiting task and untouched suffix', async () => {
  const config = { providers: [{ id: 'anthropic', adapter: 'claude' }], roleAgents: { worker: { claude: 'worker' } } };
  const { role: _role, ...declared } = task;
  const plan = { objective: 'Three bounded stages', decomposed: true, tasks: ['done', 'ask', 'later'].map((id) => ({ ...declared, id })) };
  const calls = [];
  const first = await dispatchPlan({ plan, config, selectRouteImpl: () => route, executeImpl: async ({ task: current }) => {
    calls.push(current.id);
    return { route, status: current.id === 'ask' ? 'awaiting-input' : 'complete', receipt: current.id === 'ask' ? blocked : { status: 'complete', summary: 'done evidence' }, inputRequest: current.id === 'ask' ? request : undefined };
  } });
  assert.equal(first.status, 'awaiting-input');
  assert.deepEqual(calls, ['done', 'ask']);
  const resumed = continuationPlan(plan, first, { taskId: 'ask', answers: { scope: 'Denied. Report the pending action without executing it.' } });
  assert.deepEqual(resumed.tasks.map((entry) => entry.id), ['ask', 'later']);
  assert.deepEqual(resumed.tasks[0].allowedScope, ['src']);
  assert.match(resumed.tasks[0].objective, /done evidence/);
  assert.match(resumed.tasks[0].objective, /Denied/);
  await dispatchPlan({ plan: resumed, config, selectRouteImpl: () => route, executeImpl: async ({ task: current }) => { calls.push(current.id); return { route }; } });
  assert.deepEqual(calls, ['done', 'ask', 'ask', 'later']);
  for (const input of [{ taskId: 'wrong', answers: { scope: 'yes' } }, { taskId: 'ask', answers: {} }, { taskId: 'ask', answers: { scope: 'yes', extra: 'yes' } }]) assert.throws(() => continuationPlan(plan, first, input));
  assert.throws(() => continuationPlan({ ...plan, objective: 'changed' }, first, { taskId: 'ask', answers: { scope: 'yes' } }), /unchanged plan/);
  assert.equal(first.planFingerprint, planFingerprint(plan));
});

test('portable input is optional; strict wire schema makes it nullable and validates requests', () => {
  const strict = strictReceiptSchema({ type: 'object', properties: { status: { type: 'string' }, inputRequest: { type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'] } }, required: ['status'] });
  assert.deepEqual(strict.required, ['status', 'inputRequest']);
  assert.deepEqual(strict.properties.inputRequest.anyOf[1], { type: 'null' });
  assert.equal(normalizeReceiptInputRequest({ status: 'complete', inputRequest: null }).inputRequest, undefined);
  assert.throws(() => normalizeReceiptInputRequest({ ...blocked, status: 'complete' }), /blocked receipt/);
  assert.throws(() => normalizeReceiptInputRequest({ ...blocked, inputRequest: { kind: 'approval', questions: [{ id: '../bad', prompt: 'yes?' }] } }), /question/);
});

test('replaying the same continuation returns its evidence without re-executing writes', async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-replay-'));
  const previous = { runId: 'previous-run', planFingerprint: 'fingerprint' };
  const input = { taskId: 'ask', answers: { scope: 'Denied' } };
  let calls = 0;
  const execute = async () => { calls += 1; return { status: 'complete', results: [{ taskId: 'ask', status: 'complete' }] }; };
  const first = await resumeOnce({ stateRoot, previous, input, execute });
  assert.deepEqual(await resumeOnce({ stateRoot, previous, input, execute }), first);
  assert.equal(calls, 1);
  await assert.rejects(resumeOnce({ stateRoot, previous, input: { ...input, answers: { scope: 'Different answer' } }, execute }), /different answers/);
  await assert.rejects(resumeOnce({ stateRoot, previous: { ...previous, runId: '../escape' }, input, execute }), /runId/);
});

test('agent compatibility routes Claude before execution and survives forced escalation', async () => {
  const config = await loadConfig({ cwd: await mkdtemp(path.join(os.tmpdir(), 'aorch-route-input-')) });
  config.capabilities.push({ id: 'claude-only', type: 'agent', enabled: true, providers: ['anthropic'], executionProviders: ['anthropic'], bindings: { openai: { mode: 'bridge' } } });
  const selected = { ...task, agentId: 'claude-only', complexity: 'high' };
  assert.equal(selectRoute({ task: selected, catalog: config }).provider, 'anthropic');
  const codex = config.models.find((entry) => entry.provider === 'openai');
  assert.throws(() => forceRoute({ catalog: config, task: selected, profileId: codex.id, effort: codex.efforts[0].name }), /requirements/);
  config.providers.find((entry) => entry.id === 'anthropic').enabled = false;
  assert.throws(() => selectRoute({ task: selected, catalog: config }), /No eligible route/);
});

test('forced routes preserve explicit profile pins and custom read-only constraints', async () => {
  const config = await loadConfig({ cwd: await mkdtemp(path.join(os.tmpdir(), 'aorch-pin-')) });
  const profile = config.models.find((entry) => entry.provider === 'openai');
  const forced = { catalog: config, profileId: profile.id, effort: profile.efforts[0].name };
  assert.throws(() => forceRoute({ ...forced, task: { ...task, allowedProfileIds: ['another-profile'] } }), /requirements/);
  config.capabilities.push({ id: 'read-only', type: 'agent', providers: ['openai'], bindings: { openai: { settings: { sandbox_mode: 'read-only' } } } });
  assert.throws(() => forceRoute({ ...forced, task: { ...task, agentId: 'read-only', write: true } }), /requirements/);
});

test('a failed continuation can explicitly resume its new result without replaying its completed prefix', async () => {
  const config = { providers: [{ id: 'anthropic', adapter: 'claude' }], roleAgents: { worker: { claude: 'worker' } } };
  const { role: _role, ...declared } = task;
  const plan = { objective: 'Recover remaining work', decomposed: true, tasks: ['done', 'ask', 'later'].map((id) => ({ ...declared, id })) };
  const calls = [];
  const result = await dispatchPlan({ plan, config, selectRouteImpl: () => route, executeImpl: async ({ task: current }) => {
    calls.push(current.id);
    if (current.id === 'later') throw new Error('Provider temporarily unavailable');
    return { route, receipt: { status: 'complete', summary: 'Completed work evidence' } };
  } });
  assert.equal(result.status, 'failed');
  const retry = continuationPlan(plan, result, null);
  assert.deepEqual(retry.tasks.map((entry) => entry.id), ['later']);
  assert.match(retry.tasks[0].objective, /Completed work evidence/);
  assert.match(retry.tasks[0].objective, /Provider temporarily unavailable/);
  await dispatchPlan({ plan: retry, config, selectRouteImpl: () => route, executeImpl: async ({ task: current }) => { calls.push(current.id); return { route }; } });
  assert.deepEqual(calls, ['done', 'ask', 'later', 'later']);
});

test('a second provider account uses its adapter capability binding while preserving account limits', async () => {
  const config = await loadConfig({ cwd: await mkdtemp(path.join(os.tmpdir(), 'aorch-provider-alias-')) });
  const original = config.models.find((entry) => entry.provider === 'anthropic' && entry.taskKinds.includes('implementation'));
  config.providers.push({ id: 'second-account', adapter: 'claude', enabled: true });
  config.models.push({ ...original, id: 'second-model', provider: 'second-account' });
  config.capabilities.push({ id: 'claude-agent', type: 'agent', providers: ['anthropic'], bindings: { anthropic: { mode: 'native', enabled: true } } });
  const selected = { ...task, agentId: 'claude-agent', complexity: 'standard', allowedProviders: ['second-account'] };
  assert.equal(selectRoute({ task: selected, catalog: config }).provider, 'second-account');
  assert.throws(() => selectRoute({ task: { ...selected, forbiddenProviders: ['second-account'] }, catalog: config }), /No eligible route/);
});
