import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeTask as realExecuteTask } from '../src/task-runner.js';
import { createReadinessContext } from '../src/provider-readiness.js';
const executeTask = (options) => realExecuteTask({ readinessContext: createReadinessContext({ diagnose: async ({ providers }) => providers.map(p => ({ id: p.id, readiness: 'ready', models: null })) }), ...options });

function task() {
  return {
    id: 'T-codex-isolated-launch',
    runId: 'codex-isolated-launch',
    objective: 'Review files without loading project Codex configuration',
    kind: 'review',
    role: 'reviewer',
    agentRole: 'reviewer',
    agentId: 'restricted-review',
    risk: 'standard',
    write: false,
    allowedScope: ['src/**'],
    acceptanceCriteria: ['The review uses scoped read-only file access'],
    verificationCommands: [],
    capabilityIds: []
  };
}

function config(presetPath) {
  return {
    routing: { qualityTolerance: 0.01, tokenTolerance: 0.05, uncertaintyPenalty: 0 },
    providers: [{ id: 'openai', adapter: 'codex', enabled: true, executable: 'codex' }],
    models: [{
      id: 'codex-review', provider: 'openai', model: 'gpt-test', enabled: true,
      roles: ['reviewer'], taskKinds: ['review'], maturity: 'stable',
      quality: { default: 0.8, review: 0.8 }, tokenIndex: 1, latencyIndex: 1,
      efforts: [{
        name: 'low', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1,
        complexities: ['standard']
      }]
    }],
    capabilities: [{
      id: 'restricted-review', type: 'agent', enabled: true,
      providers: ['openai'], executionProviders: ['openai'],
      bindings: { openai: {
        name: 'restricted-review', mode: 'native', syncStatus: 'current', path: presetPath,
        instructions: 'Review only the requested project evidence.',
        settings: { sandbox_mode: 'read-only', features: { shell_tool: false } }
      } }
    }]
  };
}

test('restricted Codex launches from a fresh empty temp cwd and removes it after failure', async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'aorch-codex-project-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const presetPath = path.join(project, '.codex', 'agents', 'restricted-review.toml');
  await mkdir(path.dirname(presetPath), { recursive: true });
  await writeFile(presetPath, [
    'developer_instructions = "Review only."',
    'sandbox_mode = "read-only"',
    'features.shell_tool = false'
  ].join('\n'));

  let launchCwd;
  await assert.rejects(executeTask({
    task: task(),
    config: config(presetPath),
    cwd: project,
    forcedRoute: { profileId: 'codex-review', effort: 'low' },
    resolveCommandSpecImpl: (spec) => spec,
    runCommandImpl: async (spec, options) => {
      launchCwd = options.cwd;
      assert.notEqual(launchCwd, project);
      assert.equal(path.dirname(launchCwd), path.resolve(os.tmpdir()));
      assert.deepEqual(await readdir(launchCwd), []);
      const mcpArgs = spec.args.find((arg) => arg.startsWith('mcp_servers.aorch_files.args='));
      assert.equal(JSON.parse(mcpArgs.slice(mcpArgs.indexOf('=') + 1)).at(-1), project);
      const outputPath = spec.args[spec.args.indexOf('-o') + 1];
      assert.equal(path.relative(project, outputPath).startsWith('..'), false);
      throw new Error('fixture provider failure');
    }
  }), /fixture provider failure/u);

  assert.ok(launchCwd);
  await assert.rejects(access(launchCwd), { code: 'ENOENT' });
});
