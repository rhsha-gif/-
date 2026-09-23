import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mergeFourCliConfig } from '../src/config-upgrade.js';
const defaults = JSON.parse(await readFile(new URL('../config/aorch.config.json', import.meta.url), 'utf8'));
test('explicit four-CLI config upgrade adds defaults without replacing user choices', () => {
  const current = structuredClone(defaults);
  current.providers = current.providers.filter((entry) => ['openai', 'anthropic'].includes(entry.id));
  current.models = current.models.filter((entry) => !['antigravity', 'grok'].includes(entry.provider) && entry.id !== 'codex-astra');
  current.providers[0].enabled = false;
  current.models[0].quality.default = 0.123;
  current.routing.qualityTolerance = 0.07;
  delete current.roleAgents.auditor;
  const merged = mergeFourCliConfig(current, defaults);
  assert.equal(merged.providers[0].enabled, false);
  assert.equal(merged.models[0].quality.default, 0.123);
  assert.equal(merged.routing.qualityTolerance, 0.07);
  assert.equal(merged.providers.length, 4);
  assert.deepEqual(merged.roleAgents.auditor, defaults.roleAgents.auditor);
  assert.equal(merged.models.find((entry) => entry.id === 'grok-general').automatic, true);
  assert.deepEqual(merged.models.find((entry) => entry.id === 'grok-general').validatedTaskTags, ['local-evidence']);
  assert.deepEqual(mergeFourCliConfig(merged, defaults), merged);
  assert.equal(current.providers.length, 2);
});

test('config upgrade moves retired model strings, drops removed quota gates and adds missing packaged efforts', () => {
  const current = structuredClone(defaults);
  const stale = (id) => current.models.find((entry) => entry.id === id);
  stale('codex-sol-deep').model = 'gpt-5.6-sol';
  stale('codex-sol-deep').quality.review = 0.5; // user tuning survives
  stale('codex-sol-deep').efforts.push({ name: 'ultra', qualityDelta: 0.06, tokenMultiplier: 4.5, latencyMultiplier: 1.7, quotaGate: 'premium' });
  stale('codex-terra-general').enabled = true;
  stale('claude-opus-deep').efforts = stale('claude-opus-deep').efforts.filter((effort) => effort.name !== 'medium');
  delete current.escalation.diagnosis;

  const merged = mergeFourCliConfig(current, defaults);
  const sol = merged.models.find((entry) => entry.id === 'codex-sol-deep');
  assert.equal(sol.model, 'gpt-6-sol');
  assert.equal(sol.maturity, 'challenger');
  assert.equal(sol.quality.review, 0.5);
  assert.equal(sol.efforts.some((effort) => effort.quotaGate), false);
  assert.equal(merged.models.find((entry) => entry.id === 'codex-terra-general').enabled, false);
  assert.ok(merged.models.find((entry) => entry.id === 'claude-opus-deep').efforts.some((effort) => effort.name === 'medium'));
  assert.deepEqual(merged.escalation.diagnosis, defaults.escalation.diagnosis);
  assert.deepEqual(mergeFourCliConfig(merged, defaults), merged);
});
