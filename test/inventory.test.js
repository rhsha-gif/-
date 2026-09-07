import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverCapabilities, getInventory, mergeCapabilities } from '../src/inventory.js';
import { loadDefinitions, renderDefinitions } from '../src/definitions.js';
import { syncGeneratedFiles } from '../src/definition-sync.js';

async function put(root, relative, content) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), content);
}

test('inventory distinguishes cached, enabled and observed plugin capabilities and legacy Codex skills', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-inventory-cache-'));
  for (const name of ['enabled', 'disabled', 'unknown']) {
    const base = `.codex/plugins/cache/market/${name}/1.0`;
    await put(root, `${base}/.codex-plugin/plugin.json`, JSON.stringify({ name, version: '1.0' }));
    await put(root, `${base}/skills/check/SKILL.md`, '---\nname: check\ndescription: Inspect fixtures\n---\n');
  }
  await put(root, '.codex/config.toml', '[plugins."enabled@market"]\nenabled=true\n[plugins."disabled@market"]\nenabled=false\n');
  await put(root, '.codex/skills/legacy/SKILL.md', '---\nname: legacy\ndescription: >\n  Legacy skill with\n  folded metadata.\n---\n');
  const capabilities = await discoverCapabilities({ cwd: root, includeUser: false });
  assert.equal(capabilities.find((entry) => entry.id === 'enabled@market').enabled, true);
  assert.equal(capabilities.find((entry) => entry.id === 'disabled@market').enabled, false);
  assert.equal(capabilities.find((entry) => entry.id === 'unknown@market').configuredEnabled, null);
  assert.equal(capabilities.find((entry) => entry.id === 'unknown@market').available, null);
  assert.equal(capabilities.find((entry) => entry.id === 'legacy').description, 'Legacy skill with folded metadata.');
  const observed = getInventory({ providers: [], models: [], capabilities }, { runtime: ['enabled:check'] });
  assert.equal(observed.capabilities.find((entry) => entry.id === 'enabled:check').available, true);
});

test('canonical inventory reports agents, bridges and asset edits without leaking native server configuration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-inventory-bindings-'));
  await put(root, '.agents/aorch/review.md', 'Review only.');
  await put(root, '.agents/aorch/proof/SKILL.md', '---\nname: proof\ndescription: Inspect proof\n---\n');
  await put(root, '.agents/aorch/proof/reference.md', 'Evidence');
  await put(root, '.agents/aorch/definitions.json', JSON.stringify({ version: 1,
    agents: [{ id: 'only-claude', description: 'A native Claude task', instructions: 'review.md', providers: { anthropic: { mcpServers: { example: { command: 'private-local-command' } } } } }],
    skills: [{ id: 'proof', description: 'Inspect proof', source: 'proof', providers: ['anthropic', 'openai'] }]
  }));
  await syncGeneratedFiles({ root, files: await renderDefinitions({ definitions: await loadDefinitions({ cwd: root, includeShared: false }) }) });
  let found = await discoverCapabilities({ cwd: root, includeUser: false });
  const agent = found.find((entry) => entry.id === 'only-claude');
  assert.equal(agent.type, 'agent');
  assert.deepEqual(agent.executionProviders, ['anthropic']);
  assert.equal(agent.bindings.openai.mode, 'bridge');
  assert.equal(agent.syncStatus, 'current');
  assert.equal(JSON.stringify(getInventory({ providers: [], models: [], capabilities: found })).includes('private-local-command'), false);
  await put(root, '.agents/skills/proof/reference.md', 'User edit');
  found = await discoverCapabilities({ cwd: root, includeUser: false });
  assert.equal(found.find((entry) => entry.id === 'proof').bindings.openai.syncStatus, 'conflict');
});

test('a same-name project definition does not borrow an unrelated global provider binding', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-inventory-project-'));
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'aorch-inventory-home-'));
  await put(root, '.claude/skills/local-only/SKILL.md', '---\nname: local-only\ndescription: Project-specific purpose\n---\n');
  await put(homeDir, '.agents/skills/local-only/SKILL.md', '---\nname: local-only\ndescription: Different global purpose\n---\n');
  const found = await discoverCapabilities({ cwd: root, homeDir });
  const entry = found.find((candidate) => candidate.id === 'local-only');
  assert.deepEqual(entry.providers, ['anthropic']);
  assert.equal(entry.origins[1].shadowed, true);
});

test('plugin agents and hooks are inventoried without treating foreign formats or multiple cached versions as executable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-plugin-details-'));
  for (const version of ['1.0', '2.0']) {
    const base = `.codex/plugins/cache/market/bundle/${version}`;
    await put(root, `${base}/.codex-plugin/plugin.json`, JSON.stringify({ name: 'bundle', version }));
    await put(root, `${base}/agents/reviewer.md`, '---\nname: reviewer\ndescription: Claude reviewer\n---\n');
    await put(root, `${base}/hooks/hooks.json`, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Review' }] }] } }));
  }
  await put(root, '.codex/config.toml', '[plugins."bundle@market"]\nenabled=true\n');
  const found = await discoverCapabilities({ cwd: root, includeUser: false });
  const plugin = found.find((entry) => entry.type === 'plugin');
  assert.equal(plugin.configuredEnabled, true);
  assert.equal(plugin.enabled, false);
  assert.match(plugin.bindings.openai.cacheSelection, /ambiguous/);
  const agent = found.find((entry) => entry.id === 'bundle:reviewer');
  assert.equal(agent.type, 'agent');
  assert.equal(agent.enabled, false);
  assert.deepEqual(agent.executionProviders, []);
  assert.equal(found.find((entry) => entry.type === 'hook').supported, false);
});

test('discovers installed skills from both CLIs and merges provider support', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-inventory-'));
  for (const base of ['.claude/skills/test-first', '.agents/skills/test-first']) {
    await mkdir(path.join(root, base), { recursive: true });
    await writeFile(path.join(root, base, 'SKILL.md'), `---\nname: test-first\ndescription: Write a failing test before behavior changes.\n---\n`);
  }
  const discovered = await discoverCapabilities({ cwd: root, includeUser: false });
  const skill = discovered.find((entry) => entry.id === 'test-first');
  assert.deepEqual(skill.providers.sort(), ['anthropic', 'openai']);
  assert.equal(skill.type, 'skill');
});

test('discovery cannot override an explicitly disabled capability', () => {
  const merged = mergeCapabilities(
    [{ id: 'browser-qa', type: 'plugin', providers: ['*'], enabled: false }],
    [{ id: 'browser-qa', type: 'plugin', providers: ['anthropic'], enabled: true, path: '/plugin' }]
  );
  assert.equal(merged[0].enabled, false);
  assert.deepEqual(merged[0].providers, ['anthropic']);
});

test('inventory treats capability descriptions as bounded metadata', () => {
  const inventory = getInventory({
    providers: [],
    models: [],
    capabilities: [
      {
        id: 'noisy-tool', type: 'skill', enabled: true,
        description: `Useful\nmetadata\u0000 ${'x'.repeat(500)}`
      }
    ]
  });
  const reviewed = inventory.capabilities.find((entry) => entry.id === 'noisy-tool');
  assert.equal(reviewed.description.includes('\n'), false);
  assert.equal(reviewed.description.includes('\u0000'), false);
  assert.ok(reviewed.description.length <= 300);
  assert.equal(reviewed.descriptionUsage, 'metadata-only');
});

test('discovery rejects instruction-like capability names and falls back to the directory ID', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-inventory-safe-id-'));
  await mkdir(path.join(root, '.claude/skills/safe-directory'), { recursive: true });
  await writeFile(path.join(root, '.claude/skills/safe-directory/SKILL.md'), `---\nname: "bad id with spaces"\ndescription: safe metadata\n---\n`);
  await mkdir(path.join(root, '.claude/plugins/safe-plugin/.claude-plugin'), { recursive: true });
  await writeFile(path.join(root, '.claude/plugins/safe-plugin/.claude-plugin/plugin.json'), JSON.stringify({
    name: 'evil\ninstruction',
    description: 'metadata'
  }));

  const discovered = await discoverCapabilities({ cwd: root, includeUser: false });
  assert.ok(discovered.some((entry) => entry.id === 'safe-directory' && entry.type === 'skill'));
  assert.ok(discovered.some((entry) => entry.id === 'safe-plugin' && entry.type === 'plugin'));
  assert.equal(discovered.some((entry) => /\s/.test(entry.id)), false);
});
