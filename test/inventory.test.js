import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverCapabilities, getInventory, mergeCapabilities } from '../src/inventory.js';

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

test('an actually discovered capability enables a disabled catalog template', () => {
  const merged = mergeCapabilities(
    [{ id: 'browser-qa', type: 'plugin', providers: ['*'], enabled: false }],
    [{ id: 'browser-qa', type: 'plugin', providers: ['anthropic'], enabled: true, path: '/plugin' }]
  );
  assert.equal(merged[0].enabled, true);
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
