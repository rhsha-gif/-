import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveRoleAgent } from '../src/role-agent.js';

async function temporaryDirectory(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-native-role-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('Antigravity and Grok resolve their installed native role definitions', async (t) => {
  const cwd = await temporaryDirectory(t);
  const agyPath = path.join(cwd, '.agents', 'agents', 'aorch-worker', 'agent.md');
  const grokPath = path.join(cwd, '.grok', 'agents', 'aorch-worker.md');
  await mkdir(path.dirname(agyPath), { recursive: true });
  await mkdir(path.dirname(grokPath), { recursive: true });
  await writeFile(agyPath, '---\nname: aorch-worker\ntools: ["view_file", "write_to_file", "finish"]\n---\nStay in scope.\n');
  await writeFile(grokPath, '---\nname: aorch-worker\ndisallowedTools: ["Agent"]\n---\nStay in scope.\n');
  const config = {
    roleAgents: { worker: { antigravity: 'aorch-worker', grok: 'aorch-worker' } },
    capabilities: []
  };
  assert.deepEqual(
    await resolveRoleAgent({ config, agentRole: 'worker', adapter: 'antigravity', cwd }),
    { agent: 'aorch-worker' }
  );
  assert.deepEqual(
    await resolveRoleAgent({ config, agentRole: 'worker', adapter: 'grok', cwd }),
    { agent: 'aorch-worker' }
  );
});

test('new native adapters do not emulate the Claude-only paper MCP', async (t) => {
  const cwd = await temporaryDirectory(t);
  const nativePath = path.join(cwd, '.grok', 'agents', 'aorch-paper-researcher.md');
  await mkdir(path.dirname(nativePath), { recursive: true });
  await writeFile(nativePath, '---\nname: aorch-paper-researcher\n---\nBlock if paper MCP is absent.\n');
  const config = {
    roleAgents: { 'paper-researcher': { grok: 'aorch-paper-researcher' } },
    capabilities: []
  };
  await assert.rejects(
    resolveRoleAgent({ config, agentRole: 'paper-researcher', adapter: 'grok', cwd }),
    /cannot apply the Claude-only MCP/
  );
});

test('Antigravity fails closed when its tool-restricted native preset is not installed', async (t) => {
  const cwd = await temporaryDirectory(t);
  const config = { roleAgents: { worker: { antigravity: `missing-${path.basename(cwd)}` } }, capabilities: [] };
  await assert.rejects(
    resolveRoleAgent({ config, agentRole: 'worker', adapter: 'antigravity', cwd }),
    /run `aorch install`/
  );
});

test('Antigravity rejects native profiles that cannot finish or expose shell and delegation tools', async (t) => {
  const cwd = await temporaryDirectory(t);
  const agentPath = path.join(cwd, '.agents', 'agents', 'aorch-worker', 'agent.md');
  await mkdir(path.dirname(agentPath), { recursive: true });
  const config = { roleAgents: { worker: { antigravity: 'aorch-worker' } }, capabilities: [] };
  await writeFile(agentPath, '---\nname: aorch-worker\ntools: [view_file]\n---\nWorker.\n');
  await assert.rejects(resolveRoleAgent({ config, agentRole: 'worker', adapter: 'antigravity', cwd }), /must include finish/);
  await writeFile(agentPath, '---\nname: aorch-worker\ntools: [view_file, finish, run_command]\n---\nWorker.\n');
  await assert.rejects(resolveRoleAgent({ config, agentRole: 'worker', adapter: 'antigravity', cwd }), /unsupported tool run_command/);
});

test('native read-only tool settings expose a hard sandbox gate', async (t) => {
  const cwd = await temporaryDirectory(t);
  const agyPath = path.join(cwd, '.agents', 'agents', 'aorch-reviewer', 'agent.md');
  const grokPath = path.join(cwd, '.grok', 'agents', 'aorch-reviewer.md');
  await mkdir(path.dirname(agyPath), { recursive: true });
  await mkdir(path.dirname(grokPath), { recursive: true });
  await writeFile(agyPath, '---\nname: aorch-reviewer\ntools:\n  - view_file\n  - grep_search\n  - finish\n---\nReview.\n');
  await writeFile(grokPath, '---\nname: aorch-reviewer\ndisallowedTools: ["search_replace", "Agent"]\n---\nReview.\n');
  const config = {
    roleAgents: { reviewer: { antigravity: 'aorch-reviewer', grok: 'aorch-reviewer' } },
    capabilities: []
  };
  assert.equal((await resolveRoleAgent({ config, agentRole: 'reviewer', adapter: 'antigravity', cwd })).sandboxMode, 'read-only');
  assert.equal((await resolveRoleAgent({ config, agentRole: 'reviewer', adapter: 'grok', cwd })).sandboxMode, 'read-only');
});
