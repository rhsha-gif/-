import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRoute, forceRoute } from '../src/router.js';
import { validateTaskPlan } from '../src/decompose.js';
import { continuationPlan, planFingerprint } from '../src/continuation.js';
import { dispatchPlan } from '../src/dispatch.js';

const task = { id: 'review', objective: 'Review implementation', kind: 'review', role: 'reviewer', risk: 'standard', acceptanceCriteria: ['Evidence is checked'] };
const profile = (id, provider, model, extra = {}) => ({ id, provider, model, roles: ['reviewer'], taskKinds: ['review'], quality: { default: 0.9 }, efforts: [{ name: 'high' }], ...extra });
const catalog = { providers: [{ id: 'anthropic', adapter: 'claude' }, { id: 'antigravity', adapter: 'antigravity' }, { id: 'openai', adapter: 'codex' }],
  models: [profile('claude', 'anthropic', 'opus'), profile('agy-claude', 'antigravity', 'claude-opus-4-6-thinking'), profile('gpt', 'openai', 'gpt-6-astra')] };

test('independence excludes the same family on another transport and during escalation', () => {
  const independent = { ...task, forbiddenModelFamilies: ['claude'] };
  assert.equal(selectRoute({ task: independent, catalog }).modelFamily, 'gpt');
  assert.throws(() => forceRoute({ task: independent, catalog, profileId: 'agy-claude', effort: 'high' }), /cannot satisfy/);
});
test('new unverified profiles are explicit-only; validated kinds limit automatic routing', () => {
  const unverified = { ...catalog, models: [profile('new', 'openai', 'gpt-6-astra', { automatic: false })] };
  assert.throws(() => selectRoute({ task, catalog: unverified }), /No eligible/);
  assert.equal(selectRoute({ task: { ...task, allowedProfileIds: ['new'] }, catalog: unverified }).profileId, 'new');
  unverified.models[0].automatic = true;
  unverified.models[0].validatedTaskKinds = ['implementation'];
  assert.throws(() => selectRoute({ task, catalog: unverified }), /No eligible/);
});
test('unknown family cannot satisfy an independent review', () => {
  const unknown = { providers: [{ id: 'custom', adapter: 'generic' }], models: [profile('unknown', 'custom', 'custom-model')] };
  assert.throws(() => selectRoute({ task: { ...task, forbiddenModelFamilies: ['claude'] }, catalog: unknown }), /No eligible/);
});
const first = { id: 'build', agentRole: 'worker', kind: 'implementation', objective: 'Build', risk: 'standard', acceptanceCriteria: ['Works'] };
const second = { ...task, role: undefined, agentRole: 'reviewer', independentOfTaskIds: ['build'] };
const plan = { objective: 'Build and review', decomposed: true, tasks: [first, second] };
test('plan independence references must precede the dependent task', () => {
  assert.doesNotThrow(() => validateTaskPlan(plan));
  assert.throws(() => validateTaskPlan({ ...plan, tasks: [second, first] }), /earlier task/);
});
test('resume preserves completed family exclusion without rerunning the completed task', () => {
  const previous = { planFingerprint: planFingerprint(plan), status: 'failed', results: [
    { taskId: 'build', status: 'complete', route: { model: 'opus' }, attempts: [{ route: { model: 'gpt-5.6-sol' } }] },
    { taskId: 'review', status: 'failed', error: 'unavailable' }
  ] };
  const resumed = continuationPlan(plan, previous, null);
  assert.equal(resumed.tasks.length, 1);
  assert.deepEqual(resumed.tasks[0].forbiddenModelFamilies, ['claude', 'gpt']);
  assert.deepEqual(resumed.tasks[0].independentOfTaskIds, []);
  assert.doesNotThrow(() => validateTaskPlan(resumed));
});
test('dispatch uses actual prior route family for a subsequent review', async () => {
  const seen = [];
  const result = await dispatchPlan({ plan, config: { ...catalog, roleAgents: { worker: { claude: 'worker' }, reviewer: { codex: 'reviewer' } } }, dryRun: true,
    selectRouteImpl: ({ task: current }) => { seen.push(current); return current.id === 'build'
      ? { provider: 'anthropic', model: 'opus' } : { provider: 'openai', model: 'gpt-6-astra' }; }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(seen[1].forbiddenModelFamilies, ['claude']);
});

test('forced escalation preserves experimental risk and unvalidated-profile gates', () => {
  const experimental = structuredClone(catalog);
  experimental.providers[1].adapterMaturity = 'experimental';
  assert.throws(() => forceRoute({ task: {...task, risk: 'high'}, catalog: experimental, profileId: 'agy-claude', effort: 'high' }), /cannot satisfy/);
  experimental.models[1].automatic = false;
  assert.throws(() => forceRoute({ task, catalog: experimental, profileId: 'agy-claude', effort: 'high' }), /cannot satisfy/);
  assert.equal(forceRoute({ task: {...task, allowedProfileIds: ['agy-claude']}, catalog: experimental, profileId: 'agy-claude', effort: 'high' }).profileId, 'agy-claude');
});

test('representative activation is limited to the tested complexity and ordinary risk', () => {
  const limited = {...catalog, models: [profile('new', 'openai', 'gpt-6-astra', {validatedComplexities: ['standard'], validatedRisks: ['low','standard']})]};
  assert.equal(selectRoute({task, catalog: limited}).profileId, 'new');
  assert.throws(() => selectRoute({task: {...task, risk: 'high', complexity: 'standard'}, catalog: limited}), /No eligible/);
  assert.throws(() => selectRoute({task: {...task, complexity: 'high'}, catalog: limited}), /No eligible/);
  assert.throws(() => forceRoute({task: {...task, complexity: 'high'}, catalog: limited, profileId: 'new', effort: 'high'}), /cannot satisfy/);
});

test('read-only native default roles are filtered before a write task is dispatched', () => {
  const configured = structuredClone(catalog);
  configured.roleAgents = {reviewer: {antigravity: 'native-reviewer', codex: 'native-reviewer', claude: 'native-reviewer'}};
  configured.capabilities = [{id:'native-reviewer',type:'agent',providers:['*'],bindings:{antigravity:{name:'native-reviewer',mode:'native',settings:{tools:['view_file']}},openai:{name:'native-reviewer',mode:'native',settings:{sandbox_mode:'workspace-write'}},anthropic:{name:'native-reviewer',mode:'native',settings:{permissionMode:'plan'}}}}];
  assert.equal(selectRoute({task:{...task,agentRole:'reviewer',write:true},catalog:configured}).provider, 'openai');
});

test('local-evidence-only profiles cannot be selected for unqualified research', () => {
  const limited={...catalog,models:[profile('local-only','openai','gpt-test',{validatedTaskTags:['local-evidence']})]};
  assert.throws(()=>selectRoute({task,catalog:limited}), /No eligible/);
  assert.equal(selectRoute({task:{...task,tags:['local-evidence']},catalog:limited}).profileId, 'local-only');
});
