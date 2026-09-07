import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverCapabilities, getInventory, mergeCapabilities } from '../src/inventory.js';
import { selectCapabilities } from '../src/capabilities.js';
import { buildTaskPrompt } from '../src/providers/base.js';

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
  const merged = mergeCapabilities([], discovered);
  for (const [provider, base] of [['anthropic', '.claude'], ['openai', '.agents']]) {
    const selected = selectCapabilities({ requestedIds: ['test-first'], inventory: merged, provider }).skills[0];
    assert.equal(selected.path, path.join(root, base, 'skills/test-first'));
    assert.deepEqual(selected.paths, [selected.path]);
  }
});

test('Codex user skills and explicitly active nested installs preserve IDs and provider paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-active-'));
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'aorch-active-home-'));
  const put = async (relative, value) => {
    const file = path.join(homeDir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  await put('.codex/skills/local/SKILL.md', '---\nname: local\n---\n');
  const registry = { version: 2, plugins: {} };
  for (const name of ['active', 'disabled', 'cache-only', 'id-only', 'malformed', 'marker']) {
    const location = `cache/market/${name}/1.2.3`;
    await put(`.codex/plugins/${location}/.codex-plugin/plugin.json`, { name, description: 'test metadata' });
    await put(`.codex/plugins/${location}/skills/check/SKILL.md`, '---\nname: check\n---\n');
    if (name === 'active' || name === 'disabled') registry.plugins[`${name}@market`] = [
      { installPath: location, enabled: name === 'active' },
      { installPath: location, enabled: name === 'active' }
    ];
    if (name === 'id-only') await put(`.codex/plugins/${location}/.codex-remote-plugin-install.json`, { remote_plugin_id: 'id-only' });
    if (name === 'malformed') await put(`.codex/plugins/${location}/.codex-remote-plugin-install.json`, '{bad');
    if (name === 'marker') await put(`.codex/plugins/${location}/.codex-marketplace-install.json`, { id: 'marker@market', active: true });
  }
  registry.plugins.bad = [null, { enabled: true, installPath: 3 }];
  await put('.codex/plugins/installed_plugins.json', registry);
  await put('.claude/plugins/installed_plugins.json', { plugins: {
    'active@market': [{ enabled: true, installPath: 'cache/market/active/2' }]
  } });
  await put('.claude/plugins/cache/market/active/2/.claude-plugin/plugin.json', { name: 'active' });
  const found = await discoverCapabilities({ cwd: root, homeDir });
  assert.deepEqual(found.map(e => e.id).sort(), ['active:check', 'active@market', 'local', 'marker:check', 'marker@market']);
  const inventory = mergeCapabilities([{ id: 'active@market', type: 'plugin', enabled: false }], found);
  const plugin = selectCapabilities({ requestedIds: ['active@market'], inventory, provider: 'openai' }).plugins[0];
  assert.equal(plugin.path, path.join(homeDir, '.codex/plugins/cache/market/active/1.2.3'));
  assert.equal(plugin.paths.length, 1);
  const prompt = buildTaskPrompt({ task: { id: 'paths', objective: 'Read the plugin' }, route: { provider: 'openai' },
    capabilities: { plugins: [plugin] }, receiptPath: 'receipt.json' });
  assert.ok(prompt.includes(JSON.stringify(plugin.path)));
  assert.ok(!prompt.includes('.claude'));
  const second = await discoverCapabilities({ cwd: root, homeDir, includeUser: false });
  assert.deepEqual(second, []);
  await put('.codex/plugins/installed_plugins.json', '{broken');
  const malformed = await discoverCapabilities({ cwd: root, homeDir });
  assert.equal(malformed.some(e => e.id === 'active:check'), false);
});

test('an actually discovered capability enables a disabled catalog template', () => {
  const merged = mergeCapabilities(
    [{ id: 'browser-qa', type: 'plugin', providers: ['*'], enabled: false }],
    [{ id: 'browser-qa', type: 'plugin', providers: ['anthropic'], enabled: true, path: '/plugin' }]
  );
  assert.equal(merged[0].enabled, true);
  assert.deepEqual(merged[0].providers, ['anthropic']);
});

async function cliPluginFixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-cli-project-'));
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'aorch-cli-home-'));
  const put = async (relative, value) => {
    const file = path.join(homeDir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const local = path.join(homeDir, '한글 플러그인', 'local');
  await put('한글 플러그인/local/.codex-plugin/plugin.json', { name: 'local' });
  await put('한글 플러그인/local/skills/check/SKILL.md', '---\nname: check\n---\n');
  const installed = [{ pluginId: 'local@market', name: 'local', marketplaceName: 'market', version: 'local',
    installed: true, enabled: true, source: { source: 'local', path: local } }];
  for (const name of ['remote', 'disabled', 'uninstalled', 'cache-only', 'wrong-id', 'bad-marker', 'no-marker', 'git']) {
    const location = `.codex/plugins/cache/market/${name}/1.2.3`;
    await put(`${location}/.codex-plugin/plugin.json`, { name });
    await put(`${location}/skills/check/SKILL.md`, '---\nname: check\n---\n');
    if (!['no-marker', 'git'].includes(name)) await put(`${location}/.codex-remote-plugin-install.json`,
      name === 'bad-marker' ? '{broken' : { remote_plugin_id: name === 'wrong-id' ? 'wrong' : `plugins~${name}` });
    if (name !== 'cache-only') installed.push({ pluginId: `${name}@market`, name, marketplaceName: 'market', version: '1.2.3',
      installed: name !== 'uninstalled', enabled: name !== 'disabled',
      source: name === 'git' ? { source: 'git', url: 'https://example.invalid/plugin.git', sha: 'abc' }
        : { source: 'remote', id: `plugins~${name}` } });
  }
  return { cwd, homeDir, put, local, list: { installed, available: [] } };
}

test('Codex CLI metadata discovers exact local and remote installs with strict active state', async () => {
  const fixture = await cliPluginFixture();
  const { cwd, homeDir, list, put, local } = fixture;
  // A successful authoritative list must override stale legacy activation records.
  await put('.codex/plugins/installed_plugins.json', { plugins: {
    'disabled@market': [{ enabled: true, installPath: 'cache/market/disabled/1.2.3' }]
  } });
  await put('.codex/plugins/cache/market/remote/9.9.9/.codex-plugin/plugin.json', { name: 'remote' });
  list.installed.push(list.installed[0]);
  await put('.claude/plugins/installed_plugins.json', { plugins: {
    'local@market': [{ enabled: true, installPath: 'cache/local' }]
  } });
  await put('.claude/plugins/cache/local/.claude-plugin/plugin.json', { name: 'local' });
  await put('.claude/plugins/cache/local/skills/check/SKILL.md', '---\nname: check\n---\n');
  const found = await discoverCapabilities({ cwd, homeDir, codexPluginList: JSON.stringify(list) });
  assert.deepEqual(found.filter(e => e.type === 'plugin').map(e => e.id).sort(),
    ['git@market', 'local@market', 'no-marker@market', 'remote@market']);
  const selected = selectCapabilities({ requestedIds: ['local@market', 'local:check', 'remote@market'], inventory: found, provider: 'openai' });
  assert.deepEqual(selected.plugins.find(e => e.id === 'local@market').paths, [local]);
  assert.deepEqual(selected.skills[0].paths, [path.join(local, 'skills/check')]);
  assert.deepEqual(selected.plugins.find(e => e.id === 'remote@market').paths,
    [path.join(homeDir, '.codex/plugins/cache/market/remote/1.2.3')]);
  assert.deepEqual(selectCapabilities({ requestedIds: ['local@market'], inventory: found, provider: 'anthropic' }).plugins[0].paths,
    [path.join(homeDir, '.claude/plugins/cache/local')]);
});

test('Codex CLI rejects malformed records, unsafe paths and missing exact versions', async () => {
  const { cwd, homeDir, list } = await cliPluginFixture();
  const remote = list.installed[1];
  list.installed = [null, {}, { ...remote, installed: 'true' }, { ...remote, enabled: 1 },
    { ...remote, version: '9.9.9' }, { ...remote, version: '..' }, { ...remote, marketplaceName: '../market' },
    { ...remote, source: { source: 'remote', id: {} } },
    { ...list.installed[0], source: { source: 'local', path: 'relative/path' } },
    { ...list.installed[0], source: { source: 'local', path: `${homeDir}\0invalid` } }];
  assert.deepEqual(await discoverCapabilities({ cwd, homeDir, codexPluginList: list }), []);
});

test('Codex local installs fall back from vanished sources to an exact cache with matching manifest identity', async () => {
  const { cwd, homeDir, put } = await cliPluginFixture();
  const installed = [];
  for (const name of ['pyright-lsp', 'typescript-lsp', 'wrong-name', 'wrong-version']) {
    const source = `.codex/.tmp/marketplaces/claude-plugins-official/plugins/${name}`;
    installed.push({ pluginId: `${name}@claude-plugins-official`, name, marketplaceName: 'claude-plugins-official',
      version: '1.0.0', installed: true, enabled: true, source: { source: 'local', path: path.join(homeDir, source) } });
    const version = name === 'wrong-version' ? '2.0.0' : '1.0.0';
    const cache = `.codex/plugins/cache/claude-plugins-official/${name}/${version}`;
    await put(`${cache}/.codex-plugin/plugin.json`, { name: name === 'wrong-name' ? 'different-plugin' : name });
    await put(`${cache}/skills/check/SKILL.md`, '---\nname: check\n---\n');
    if (name === 'typescript-lsp') await put(`${source}/.codex-plugin/plugin.json`, '{broken');
  }
  const found = await discoverCapabilities({ cwd, homeDir, codexPluginList: { installed, available: [] } });
  assert.deepEqual(found.map(e => e.id).sort(), ['pyright-lsp:check', 'pyright-lsp@claude-plugins-official',
    'typescript-lsp:check', 'typescript-lsp@claude-plugins-official']);
  for (const name of ['pyright-lsp', 'typescript-lsp']) {
    const selected = selectCapabilities({ requestedIds: [`${name}@claude-plugins-official`], inventory: found, provider: 'openai' });
    assert.deepEqual(selected.plugins[0].paths, [path.join(homeDir, `.codex/plugins/cache/claude-plugins-official/${name}/1.0.0`)]);
  }
});

test('Codex CLI runner is bounded and failures preserve proven discovery without activating cache', async () => {
  const { cwd, homeDir, list, put } = await cliPluginFixture();
  await put('.codex/skills/proven/SKILL.md', '---\nname: proven\n---\n');
  let calls = 0;
  const codexPluginRunner = async (spec, options) => {
    calls += 1;
    assert.equal(spec.command, 'codex');
    assert.deepEqual(spec.args, ['plugin', 'list', '--json']);
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 5000);
    return { exitCode: 0, timedOut: false, stdout: JSON.stringify(list) };
  };
  const found = await discoverCapabilities({ cwd, homeDir, codexPluginRunner });
  assert.ok(found.some(e => e.id === 'remote@market'));
  assert.equal(calls, 1);
  for (const result of [
    { exitCode: 0, timedOut: true, stdout: JSON.stringify(list) },
    { exitCode: 1, stdout: JSON.stringify(list) },
    { exitCode: 0, stdout: '{broken' }, { exitCode: 0, stdout: '{"installed":{}}' }
  ]) {
    const fallback = await discoverCapabilities({ cwd, homeDir, codexPluginRunner: async () => result });
    assert.deepEqual(fallback.map(e => e.id), ['proven']);
  }
  assert.deepEqual((await discoverCapabilities({ cwd, homeDir, codexPluginRunner: async () => { throw new Error('ENOENT'); } })).map(e => e.id), ['proven']);
});

test('project-only discovery never calls Codex CLI and explicit fixture homes never invoke user CLI', async () => {
  const { cwd, homeDir, list } = await cliPluginFixture();
  let calls = 0;
  assert.deepEqual(await discoverCapabilities({ cwd, homeDir, includeUser: false, codexPluginList: list,
    codexPluginRunner: async () => { calls += 1; throw new Error('must not run'); } }), []);
  assert.equal(calls, 0);
  assert.deepEqual(await discoverCapabilities({ cwd, homeDir }), []);
});

test('Codex discovery respects CODEX_HOME while explicit fixture homeDir stays isolated', async (t) => {
  const { cwd, homeDir, list, put } = await cliPluginFixture();
  t.mock.method(os, 'homedir', () => homeDir);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(homeDir, '사용자 Codex');
  try {
    await put('사용자 Codex/skills/custom/SKILL.md', '---\nname: custom\n---\n');
    await put('사용자 Codex/plugins/cache/market/remote/1.2.3/.codex-plugin/plugin.json', { name: 'remote' });
    const found = await discoverCapabilities({ cwd, codexPluginList: list, claudePluginList: [] });
    assert.ok(found.some(e => e.id === 'custom'));
    assert.equal(found.find(e => e.id === 'remote@market').path,
      path.join(homeDir, '사용자 Codex/plugins/cache/market/remote/1.2.3'));
    assert.equal((await discoverCapabilities({ cwd, homeDir, codexPluginList: list })).some(e => e.id === 'custom'), false);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

async function claudeCliFixture({ manifestlessLsp = false } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-claude-project-'));
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'aorch-claude-한글-'));
  const put = async (relative, value) => {
    const file = path.join(homeDir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const list = [];
  for (const [name, marketplace, version, enabled] of [
    ['codex', 'openai-codex', '1.0.6', true],
    ['explanatory-output-style', 'claude-plugins-official', '1.0.0', false],
    ['pyright-lsp', 'claude-plugins-official', '1.0.0', true],
    ['security-guidance', 'claude-plugins-official', '2.0.7', true],
    ['superpowers', 'claude-plugins-official', '6.3.0', false],
    ['typescript-lsp', 'claude-plugins-official', '1.0.0', true]
  ]) {
    const relative = `.claude/plugins/cache/${marketplace}/${name}/${version}`;
    if (manifestlessLsp && ['pyright-lsp', 'typescript-lsp'].includes(name)) {
      for (const file of ['LICENSE', 'README.md', '.in_use']) await put(`${relative}/${file}`, 'fixture package metadata');
    } else {
      await put(`${relative}/.claude-plugin/plugin.json`, { name });
      await put(`${relative}/skills/check/SKILL.md`, '---\nname: check\n---\n');
    }
    list.push({ id: `${name}@${marketplace}`, version, scope: 'user', enabled,
      installPath: path.join(homeDir, relative), installedAt: '2026-06-12T06:18:33.517Z', lastUpdated: '2026-07-13T12:52:00.546Z' });
  }
  await put('.claude/plugins/installed_plugins.json', { version: 2, plugins: Object.fromEntries(list.map(({ id, enabled, ...record }) => [id, [record]])) });
  return { cwd, homeDir, list, put };
}

test('Claude CLI array discovers four active plugins and preserves paths across both providers', async () => {
  const { cwd, homeDir, list, put } = await claudeCliFixture();
  const codexRoot = '.codex/plugins/cache/openai-codex/codex/1.0.6';
  await put(`${codexRoot}/.codex-plugin/plugin.json`, { name: 'codex' });
  await put(`${codexRoot}/skills/check/SKILL.md`, '---\nname: check\n---\n');
  // Even explicit stale metadata must not revive a CLI-disabled plugin.
  await put('.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0/.codex-marketplace-install.json',
    { id: 'superpowers@claude-plugins-official', enabled: true });
  const found = await discoverCapabilities({ cwd, homeDir, claudePluginList: JSON.stringify([...list, list[0]]),
    codexPluginList: { installed: [{ pluginId: 'codex@openai-codex', name: 'codex', marketplaceName: 'openai-codex', version: '1.0.6',
      installed: true, enabled: true, source: { source: 'local', path: path.join(homeDir, codexRoot) } }], available: [] } });
  assert.deepEqual(found.filter(e => e.type === 'plugin').map(e => e.id).sort(),
    ['codex@openai-codex', 'pyright-lsp@claude-plugins-official', 'security-guidance@claude-plugins-official', 'typescript-lsp@claude-plugins-official']);
  for (const [provider, expected] of [['anthropic', list[0].installPath], ['openai', path.join(homeDir, codexRoot)]]) {
    const selected = selectCapabilities({ requestedIds: ['codex@openai-codex', 'codex:check'], inventory: found, provider });
    assert.deepEqual(selected.plugins[0].paths, [expected]);
    assert.deepEqual(selected.skills[0].paths, [path.join(expected, 'skills/check')]);
  }
});

test('Claude CLI excludes disabled and malformed records and requires a usable absolute install path', async () => {
  const { cwd, homeDir, list } = await claudeCliFixture();
  const entry = list[0];
  const invalid = [null, {}, { ...entry, enabled: false }, { ...entry, enabled: 'true' }, { ...entry, enabled: undefined },
    { ...entry, installPath: 'relative/path' }, { ...entry, installPath: `${homeDir}\0invalid` },
    { ...entry, installPath: path.join(homeDir, 'missing') }, { ...entry, id: 'invalid id' },
    { ...entry, scope: 'unknown' }, { ...entry, version: {} }];
  assert.deepEqual(await discoverCapabilities({ cwd, homeDir, claudePluginList: invalid }), []);
});

test('Claude CLI keeps active manifestless LSP metadata without inventing skills or bypassing invalid manifests', async () => {
  const { cwd, homeDir, list, put } = await claudeCliFixture({ manifestlessLsp: true });
  const options = { cwd, homeDir, claudePluginList: [...list,
    { ...list[2], id: 'missing@market', installPath: path.join(homeDir, 'missing') },
    { ...list[2], id: 'file@market', installPath: path.join(list[2].installPath, 'README.md') }
  ] };
  const found = await discoverCapabilities(options);
  assert.equal(found.filter(e => e.type === 'plugin').length, 4);
  assert.deepEqual(found.filter(e => e.type === 'skill').map(e => e.id).sort(), ['codex:check', 'security-guidance:check']);
  for (const entry of [list[2], list[5]]) {
    const plugin = found.find(e => e.id === entry.id);
    assert.equal(plugin.description, '');
    assert.deepEqual(plugin.providerPaths, { anthropic: [entry.installPath] });
  }
  const pyright = '.claude/plugins/cache/claude-plugins-official/pyright-lsp/1.0.0';
  const typescript = '.claude/plugins/cache/claude-plugins-official/typescript-lsp/1.0.0';
  await put(`${pyright}/skills/actual/SKILL.md`, '---\nname: actual\n---\n');
  assert.ok((await discoverCapabilities(options)).some(e => e.id === 'pyright-lsp:actual'));
  await put(`${pyright}/.claude-plugin/plugin.json`, '{broken');
  await put(`${typescript}/.claude-plugin/plugin.json`, { name: 'typescript-lsp', enabled: false });
  const rejected = await discoverCapabilities(options);
  assert.deepEqual(rejected.filter(e => e.type === 'plugin').map(e => e.id).sort(),
    ['codex@openai-codex', 'security-guidance@claude-plugins-official']);
  assert.equal(rejected.some(e => e.id === 'pyright-lsp:actual'), false);
});

test('Claude CLI runner is bounded, fixture homes are isolated, and failures retain only explicit fallback activation', async () => {
  const { cwd, homeDir, list, put } = await claudeCliFixture();
  let calls = 0;
  const claudePluginRunner = async (spec, options) => {
    calls += 1;
    assert.equal(spec.command, 'claude');
    assert.deepEqual(spec.args, ['plugin', 'list', '--json']);
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 5000);
    return { exitCode: 0, stdout: JSON.stringify(list), timedOut: false };
  };
  assert.equal((await discoverCapabilities({ cwd, homeDir, claudePluginRunner })).filter(e => e.type === 'plugin').length, 4);
  assert.equal(calls, 1);
  assert.deepEqual(await discoverCapabilities({ cwd, homeDir, includeUser: false, claudePluginRunner }), []);
  assert.equal(calls, 1);
  assert.deepEqual(await discoverCapabilities({ cwd, homeDir }), []);
  await put('.claude/plugins/installed_plugins.json', { plugins: {
    'codex@openai-codex': [{ enabled: true, installPath: list[0].installPath }],
    'pyright-lsp@claude-plugins-official': [{ installPath: list[2].installPath }]
  } });
  for (const runner of [
    async () => ({ exitCode: 0, stdout: '{broken' }),
    async () => ({ exitCode: 0, stdout: '{"installed":[]}' }),
    async () => ({ exitCode: 1, stdout: JSON.stringify(list) }),
    async () => ({ exitCode: 0, timedOut: true, stdout: JSON.stringify(list) }),
    async () => { throw new Error('ENOENT'); }
  ]) {
    const found = await discoverCapabilities({ cwd, homeDir, claudePluginRunner: runner });
    assert.deepEqual(found.map(e => e.id).sort(), ['codex:check', 'codex@openai-codex']);
  }
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
