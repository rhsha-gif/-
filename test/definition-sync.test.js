import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { syncGeneratedFiles } from '../src/definition-sync.js';
import { loadDefinitions, renderDefinitions } from '../src/definitions.js';
import { extractCodexInstructions } from '../src/role-agent.js';

const temp = () => mkdtemp(path.join(os.tmpdir(), 'aorch-definitions-'));
async function put(root, relative, text) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}
async function fixture() {
  const root = await temp();
  await put(root, '.agents/aorch/worker.md', 'Inspect "quoted" evidence. Do not delegate.\n');
  await put(root, '.agents/aorch/definitions.json', JSON.stringify({ version: 1, agents: [{ id: 'local-review', description: 'Inspect evidence', instructions: 'worker.md', providers: {
    anthropic: { disallowedTools: 'Write, Edit, Agent' }, openai: { sandbox_mode: 'read-only' }
  } }] }));
  return root;
}

test('one body generates equivalent native instructions and preserves provider constraints', async () => {
  const root = await fixture();
  const definitions = await loadDefinitions({ cwd: root, includeShared: false });
  const files = await renderDefinitions({ definitions });
  const claude = files.find((file) => file.provider === 'anthropic');
  const codex = files.find((file) => file.provider === 'openai');
  assert.match(claude.content, /disallowedTools: Write, Edit, Agent/);
  assert.match(codex.content, /sandbox_mode = "read-only"/);
  assert.equal(extractCodexInstructions(codex.content), 'Inspect "quoted" evidence. Do not delegate.');
  const first = await syncGeneratedFiles({ root, files });
  assert.equal(first.status, 'updated');
  const file = path.join(root, codex.path);
  const before = (await stat(file)).mtimeMs;
  assert.equal((await syncGeneratedFiles({ root, files })).status, 'current');
  assert.equal((await stat(file)).mtimeMs, before);
});

test('an edited generated file blocks the entire update before any payload is written', async () => {
  const root = await temp();
  const files = [{ path: '.codex/agents/a.toml', content: 'old' }, { path: '.claude/agents/a.md', content: 'old' }];
  await syncGeneratedFiles({ root, files });
  await put(root, files[1].path, 'user edit');
  const result = await syncGeneratedFiles({ root, files: files.map((file) => ({ ...file, content: 'new' })) });
  assert.equal(result.status, 'conflict');
  assert.equal(result.conflicts[0].reason, 'edited-generated-file');
  assert.equal(await readFile(path.join(root, files[0].path), 'utf8'), 'old');
  assert.equal(await readFile(path.join(root, files[1].path), 'utf8'), 'user edit');
});

test('unknown targets are conflicts; exact copies can be adopted without rewriting', async () => {
  const root = await temp();
  await put(root, 'agent.md', 'mine');
  assert.equal((await syncGeneratedFiles({ root, files: [{ path: 'agent.md', content: 'theirs' }] })).status, 'conflict');
  const before = (await stat(path.join(root, 'agent.md'))).mtimeMs;
  assert.equal((await syncGeneratedFiles({ root, files: [{ path: 'agent.md', content: 'mine' }] })).status, 'updated');
  assert.equal((await stat(path.join(root, 'agent.md'))).mtimeMs, before);
});

test('removing a managed definition preserves unknown files and saves rollback evidence', async () => {
  const root = await temp();
  await syncGeneratedFiles({ root, files: [{ path: '.agents/skills/old/SKILL.md', content: 'managed' }] });
  await put(root, '.agents/skills/old/user.md', 'user asset');
  const result = await syncGeneratedFiles({ root, files: [] });
  assert.equal(await readFile(path.join(root, '.agents/skills/old/user.md'), 'utf8'), 'user asset');
  assert.equal(await readFile(path.join(result.backup, '.agents/skills/old/SKILL.md'), 'utf8'), 'managed');
  await assert.rejects(readFile(path.join(root, '.agents/skills/old/SKILL.md')), /ENOENT/);
});

test('check mode is read-only and rejects traversal, credential paths and symlink escapes', async () => {
  const root = await temp();
  const outside = await temp();
  const result = await syncGeneratedFiles({ root, files: [{ path: 'safe.md', content: 'new' }], check: true });
  assert.equal(result.status, 'stale');
  await assert.rejects(stat(path.join(root, '.aorch')), /ENOENT/);
  for (const relative of ['../escape.md', '.env', 'auth.json', 'C:\\escape.md']) {
    await assert.rejects(syncGeneratedFiles({ root, files: [{ path: relative, content: 'bad' }], check: true }), /scope|relative|Secret/);
  }
  await symlink(outside, path.join(root, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(syncGeneratedFiles({ root, files: [{ path: 'junction/escape.md', content: 'bad' }], check: true }), /Symlink escapes/);
  await assert.rejects(stat(path.join(outside, 'escape.md')), /ENOENT/);
});

test('Claude-only definitions generate explicit Codex bridges and no native execution claim', async () => {
  const root = await fixture();
  const manifest = JSON.parse(await readFile(path.join(root, '.agents/aorch/definitions.json'), 'utf8'));
  delete manifest.agents[0].providers.openai;
  await put(root, '.agents/aorch/definitions.json', JSON.stringify(manifest));
  const definitions = await loadDefinitions({ cwd: root, includeShared: false });
  assert.deepEqual(definitions[0].executionProviders, ['anthropic']);
  const bridge = (await renderDefinitions({ definitions })).find((file) => file.provider === 'openai');
  assert.equal(bridge.mode, 'bridge');
  assert.match(bridge.content, /sandbox_mode = "read-only"/);
  assert.match(bridge.content, /agentId: local-review/);
  assert.match(bridge.content, /Before execution/);
});

test('source path escapes and unknown native settings fail before generation', async () => {
  const root = await fixture();
  const manifest = JSON.parse(await readFile(path.join(root, '.agents/aorch/definitions.json'), 'utf8'));
  manifest.agents[0].providers.openai.hooks = {};
  await put(root, '.agents/aorch/definitions.json', JSON.stringify(manifest));
  await assert.rejects(loadDefinitions({ cwd: root, includeShared: false }), /Unsupported openai agent setting/);
  delete manifest.agents[0].providers.openai.hooks;
  manifest.agents[0].instructions = '../../../../escape.md';
  await put(root, '.agents/aorch/definitions.json', JSON.stringify(manifest));
  await assert.rejects(loadDefinitions({ cwd: root, includeShared: false }), /escapes/);
});

test('project skill links keep pointing to project contracts after native generation changes directory depth', async () => {
  const root = await temp();
  await put(root, 'docs/contract.md', 'Project contract');
  await put(root, '.agents/aorch/skills/local/SKILL.md', '---\nname: local\ndescription: Local skill\n---\n[contract](../../../../docs/contract.md)\n');
  await put(root, '.agents/aorch/skills/local/desktop.ini', 'Operating system metadata');
  await put(root, '.agents/aorch/definitions.json', JSON.stringify({ version: 1, skills: [{ id: 'local', description: 'Local skill', source: 'skills/local', providers: ['anthropic', 'openai'] }] }));
  const generated = await renderDefinitions({ definitions: await loadDefinitions({ cwd: root, includeShared: false }) });
  assert.equal(generated.some((file) => file.path.endsWith('desktop.ini')), false);
  for (const file of generated) assert.match(file.content.toString(), /\[contract\]\(\.\.\/\.\.\/\.\.\/docs\/contract.md\)/);
});
