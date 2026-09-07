import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, DEFAULT_CONFIG_PATH } from '../src/config.js';
import { selectRoute, forceRoute } from '../src/router.js';
import { buildCodexCommand } from '../src/providers/codex-cli.js';

const config = await loadConfig({ configPath: DEFAULT_CONFIG_PATH });
const task = { id: 'astra', kind: 'implementation', role: 'executor', risk: 'high', complexity: 'high', allowedProfileIds: ['codex-astra-deep'] };

test('Astra copies Sol priors only, stays challenger/high, and ends the OpenAI ladder', () => {
  const sol = config.models.find(m => m.id === 'codex-sol-deep');
  const astra = config.models.find(m => m.id === 'codex-astra-deep');
  assert.equal(astra.model, 'gpt-6-astra');
  assert.equal(astra.maturity, 'challenger');
  assert.deepEqual(astra.quality, sol.quality);
  assert.equal(astra.tokenIndex, sol.tokenIndex);
  assert.equal(astra.latencyIndex, sol.latencyIndex);
  assert.deepEqual(astra.efforts, [sol.efforts.find(e => e.name === 'high')]);
  assert.match(astra.qualityEvidence, /priors, not Astra measurements/);
  assert.match(astra.qualityEvidence, /provisionally; no measured savings/);
  assert.deepEqual(config.escalation.ladders.openai.at(-1), { profileId: astra.id, effort: 'high' });
  for (const id of ['codex-luna-repeatable', 'codex-terra-general', 'codex-sol-deep', 'claude-fable-apex']) {
    assert.ok(config.models.some(m => m.id === id), id);
  }
});

test('equal-prior unpinned deep routing keeps stable Sol ahead of challenger Astra', () => {
  const route = selectRoute({ task: { ...task, allowedProfileIds: undefined, allowedProviders: ['openai'] }, catalog: config });
  assert.equal(route.profileId, 'codex-sol-deep');
  assert.equal(route.effort, 'high');
});

test('sufficient better observations select unpinned Astra without promoting its maturity', () => {
  const now = new Date('2026-09-07T00:00:00Z');
  const observations = Array.from({ length: 12 }, () => ({
    provider: 'openai', model: 'gpt-6-astra', effort: 'high', taskKind: task.kind,
    quality: 1, reviewed: true, recordedAt: now.toISOString()
  }));
  const route = selectRoute({
    task: { ...task, allowedProfileIds: undefined }, catalog: config, observations, now
  });
  assert.equal(route.profileId, 'codex-astra-deep');
  assert.equal(route.maturity, 'challenger');
});

test('maturity breaks only exact metric ties, preserving tolerance and identity ordering otherwise', () => {
  const stable = config.models.find(m => m.id === 'codex-sol-deep');
  for (const metric of ['quality', 'tokenIndex', 'latencyIndex']) {
    const challenger = structuredClone(config.models.find(m => m.id === 'codex-astra-deep'));
    if (metric === 'quality') challenger.quality[task.kind] -= 0.001;
    else challenger[metric] += 0.001;
    const catalog = { ...config, models: [stable, challenger] };
    const route = selectRoute({ task: { ...task, allowedProfileIds: undefined }, catalog });
    assert.equal(route.profileId, 'codex-astra-deep', metric);
  }
});

test('a third unequal metric tuple cannot displace the identity winner exact tie class', () => {
  const stable = config.models.find(m => m.id === 'codex-sol-deep');
  const challenger = config.models.find(m => m.id === 'codex-astra-deep');
  const third = { ...stable, id: 'codex-between', tokenIndex: stable.tokenIndex + 0.001 };
  for (const models of [
    [stable, challenger, third], [third, stable, challenger], [challenger, third, stable]
  ]) {
    const route = selectRoute({ task: { ...task, allowedProfileIds: undefined }, catalog: { ...config, models } });
    assert.equal(route.profileId, stable.id);
  }
});

test('explicit Astra profile pin builds supported Codex CLI flags', () => {
  const route = selectRoute({ task, catalog: config });
  assert.equal(route.profileId, 'codex-astra-deep');
  const spec = buildCodexCommand({ prompt: 'bounded work', route, write: true, schemaPath: 'receipt.json', outputPath: 'out.json' });
  assert.equal(spec.args[spec.args.indexOf('--model') + 1], 'gpt-6-astra');
  assert.ok(spec.args.includes('model_reasoning_effort="high"'));
  for (const arg of ['--sandbox', '--json', '--output-schema']) assert.ok(spec.args.includes(arg));
  assert.equal(spec.env.AORCH_WORKER, '1');
});

test('Astra cannot bypass critical challenger restrictions through selection or escalation', () => {
  for (const role of ['executor', 'reviewer']) {
    const critical = { ...task, risk: 'critical', role };
    assert.throws(() => selectRoute({ task: critical, catalog: config }), /No proven route/);
    assert.throws(() => forceRoute({ task: critical, catalog: config, profileId: 'codex-astra-deep', effort: 'high' }), /No proven route/);
  }
});

test('Astra selection and escalation respect profile pins and provider limits', () => {
  for (const constraints of [
    { forbiddenProviders: ['openai'] }, { allowedProviders: ['anthropic'] },
    { forbiddenProfileIds: ['codex-astra-deep'] }, { allowedProfileIds: ['codex-sol-deep'], forbiddenProviders: ['openai'] }
  ]) {
    assert.throws(() => selectRoute({ task: { ...task, ...constraints }, catalog: config }), /No eligible route/);
    assert.throws(() => forceRoute({ task: { ...task, ...constraints }, catalog: config, profileId: 'codex-astra-deep', effort: 'high' }), /constraints/);
  }
  assert.throws(() => forceRoute({ task, catalog: config, profileId: 'codex-astra-deep', effort: 'ultra' }), /not defined/);
});
