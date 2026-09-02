import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchPlan } from '../src/dispatch.js';
import { validateConfig } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = validateConfig(JSON.parse(await readFile(path.join(root, 'config/aorch.config.json'), 'utf8')));

const baseTask = {
  objective: 'Implement the parser', kind: 'implementation', risk: 'standard',
  write: true, allowedScope: ['src/**'], acceptanceCriteria: ['tests pass'],
  verificationCommands: ['npm test']
};

function plan(tasks) {
  return { objective: 'Build the parser', decomposed: tasks.length > 1, tasks };
}

const stubRoute = (provider, profileId) => () => ({
  provider, profileId, model: 'm', effort: 'high', quality: 0.9, tokenIndex: 1, latencyIndex: 1
});

test('dry-run resolves a different agent per agentRole without executing anything', async () => {
  let executed = 0;
  const result = await dispatchPlan({
    plan: plan([
      { ...baseTask, id: 'T1', agentRole: 'worker' },
      { ...baseTask, id: 'T2', write: false, agentRole: 'reviewer' },
      { ...baseTask, id: 'T3', agentRole: 'fixer' }
    ]),
    config,
    dryRun: true,
    selectRouteImpl: stubRoute('anthropic', 'claude-sonnet-general'),
    executeImpl: async () => { executed += 1; return {}; }
  });

  assert.equal(executed, 0);
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((entry) => entry.agent), ['aorch-worker', 'aorch-reviewer', 'aorch-fixer']);
  assert.deepEqual(result.results.map((entry) => entry.status), ['planned', 'planned', 'planned']);
  assert.equal(result.results[0].adapter, 'claude');
});

test('an adapter with no configured agent fails closed before anything runs', async () => {
  let executed = 0;
  const narrowed = { ...config, roleAgents: { ...config.roleAgents, fixer: { claude: 'aorch-fixer' } } };
  const result = await dispatchPlan({
    plan: plan([{ ...baseTask, id: 'T1', agentRole: 'fixer' }]),
    config: narrowed,
    selectRouteImpl: stubRoute('openai', 'codex-terra-general'),
    executeImpl: async () => { executed += 1; return {}; }
  });

  assert.equal(executed, 0);
  assert.equal(result.ok, false);
  assert.equal(result.results[0].status, 'failed');
  assert.match(result.results[0].error, /No codex agent configured for agentRole fixer/);
});

test('a failed task stops the plan so later tasks never run on a half-applied tree', async () => {
  const seen = [];
  const result = await dispatchPlan({
    plan: plan([
      { ...baseTask, id: 'T1', agentRole: 'worker' },
      { ...baseTask, id: 'T2', agentRole: 'worker' },
      { ...baseTask, id: 'T3', agentRole: 'worker' }
    ]),
    config,
    selectRouteImpl: stubRoute('anthropic', 'claude-sonnet-general'),
    executeImpl: async ({ task }) => {
      seen.push(task.id);
      if (task.id === 'T2') {
        const error = new Error('verification failed');
        error.runDir = '/runs/T2';
        throw error;
      }
      return { route: { provider: 'anthropic', profileId: 'p', model: 'm', effort: 'high' }, runDir: `/runs/${task.id}` };
    }
  });

  assert.deepEqual(seen, ['T1', 'T2']);   // T3 never dispatched
  assert.equal(result.ok, false);
  assert.deepEqual(result.results.map((entry) => entry.status), ['complete', 'failed']);
  assert.equal(result.results[1].runDir, '/runs/T2');
});

test('every task passes through plan validation, so a hand-written role is refused', async () => {
  await assert.rejects(
    dispatchPlan({
      plan: plan([{ ...baseTask, id: 'T1', agentRole: 'worker', role: 'executor' }]),
      config,
      dryRun: true,
      selectRouteImpl: stubRoute('anthropic', 'claude-sonnet-general')
    }),
    /role must not be set/i
  );
});

test('rate-limited providers are excluded for every task, not just the first', async () => {
  const forbidden = [];
  await dispatchPlan({
    plan: plan([
      { ...baseTask, id: 'T1', agentRole: 'worker' },
      { ...baseTask, id: 'T2', agentRole: 'worker' }
    ]),
    config,
    dryRun: true,
    forbiddenProviders: ['openai'],
    selectRouteImpl: ({ task }) => {
      forbidden.push(task.forbiddenProviders);
      return { provider: 'anthropic', profileId: 'p', model: 'm', effort: 'high' };
    }
  });
  assert.deepEqual(forbidden, [['openai'], ['openai']]);
});

test('tasks run in declared order because order is the plan\'s only sequencing signal', async () => {
  const seen = [];
  const result = await dispatchPlan({
    plan: plan([
      { ...baseTask, id: 'Impl', agentRole: 'worker' },
      { ...baseTask, id: 'Review', write: false, agentRole: 'reviewer' }
    ]),
    config,
    selectRouteImpl: stubRoute('anthropic', 'claude-sonnet-general'),
    executeImpl: async ({ task }) => {
      seen.push(task.id);
      return { route: { provider: 'anthropic', profileId: 'p', model: 'm', effort: 'high' }, runDir: `/runs/${task.id}` };
    }
  });
  assert.deepEqual(seen, ['Impl', 'Review']);
  assert.equal(result.ok, true);
});

test('every task in one dispatch shares the same task-runs directory', async () => {
  const runDirs = [];
  const result = await dispatchPlan({
    plan: plan([
      { ...baseTask, id: 'T1', agentRole: 'worker' },
      { ...baseTask, id: 'T2', agentRole: 'worker' }
    ]),
    config,
    selectRouteImpl: stubRoute('anthropic', 'claude-sonnet-general'),
    executeImpl: async ({ task }) => {
      runDirs.push(path.join('/state', 'task-runs', task.runId, task.id));
      return { route: { provider: 'anthropic', profileId: 'p', model: 'm', effort: 'high' }, runDir: runDirs.at(-1) };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(new Set(runDirs.map((runDir) => path.dirname(runDir))).size, 1);
});

test('codex presets are parsed for developer_instructions without a TOML dependency', async () => {
  const { extractCodexInstructions, resolveRoleAgent } = await import('../src/role-agent.js');

  assert.equal(extractCodexInstructions('name = "x"\n'), '');
  assert.equal(
    extractCodexInstructions('name = "x"\ndeveloper_instructions = """\nLine one.\nLine two.\n"""\n'),
    'Line one.\nLine two.'
  );

  // Claude resolves to a name; codex resolves to the shipped preset's text.
  assert.deepEqual(
    await resolveRoleAgent({ config, agentRole: 'reviewer', adapter: 'claude', cwd: root }),
    { agent: 'aorch-reviewer', maxTurns: 60 }
  );
  const codex = await resolveRoleAgent({ config, agentRole: 'fixer', adapter: 'codex', cwd: root });
  assert.match(codex.agentInstructions, /State the cause before changing anything/);

  // A task with no agentRole keeps the pre-pipeline behaviour exactly.
  assert.deepEqual(await resolveRoleAgent({ config, agentRole: undefined, adapter: 'claude', cwd: root }), {});

  // A generic adapter cannot apply a role, and pretending it did would be worse.
  await assert.rejects(
    resolveRoleAgent({ config, agentRole: 'worker', adapter: 'generic', cwd: root }),
    /cannot apply agentRole/
  );
});

test('the verify gate gets an observations path, or every dispatched task loses its evidence', async () => {
  const seen = [];
  await dispatchPlan({
    plan: plan([
      { ...baseTask, id: 'T1', agentRole: 'worker' },
      { ...baseTask, id: 'T2', agentRole: 'worker' }
    ]),
    config,
    observationsPath: '/ledger/observations.jsonl',
    selectRouteImpl: stubRoute('anthropic', 'claude-sonnet-general'),
    executeImpl: async ({ task, observationsPath }) => {
      seen.push(observationsPath);
      return { route: { provider: 'anthropic', profileId: 'p', model: 'm', effort: 'high' }, runDir: `/runs/${task.id}` };
    }
  });
  // run-loop skips the observation append when this is undefined, so a missing
  // path is not a cosmetic omission — it is the ledger never filling up.
  assert.deepEqual(seen, ['/ledger/observations.jsonl', '/ledger/observations.jsonl']);
});

test('a Claude preset is resolved for existence and its turn budget, before anything spawns', async () => {
  const { resolveRoleAgent, parseFrontmatterNumber } = await import('../src/role-agent.js');

  // Shipped presets carry their own budgets; the flag would otherwise override
  // them to a single value for every role.
  const worker = await resolveRoleAgent({ config, agentRole: 'worker', adapter: 'claude', cwd: root });
  assert.equal(worker.agent, 'aorch-worker');
  assert.equal(worker.maxTurns, 80);

  const reviewer = await resolveRoleAgent({ config, agentRole: 'reviewer', adapter: 'claude', cwd: root });
  assert.equal(reviewer.maxTurns, 60);

  assert.equal(parseFrontmatterNumber('---\nname: x\nmaxTurns: 25\n---\nbody\n', 'maxTurns'), 25);
  assert.equal(parseFrontmatterNumber('---\nname: x\n---\nmaxTurns: 25\n', 'maxTurns'), undefined);
  assert.equal(parseFrontmatterNumber('no frontmatter', 'maxTurns'), undefined);

  // Only paper-researcher carries an MCP server; the config it points at is
  // checked in, and the tool list names each tool instead of a wildcard.
  const papers = await resolveRoleAgent({ config, agentRole: 'paper-researcher', adapter: 'claude', cwd: root });
  assert.equal(papers.agent, 'aorch-paper-researcher');
  assert.equal(path.basename(papers.mcpConfig), 'paper-researcher.mcp.json');
  const mcpJson = JSON.parse(await readFile(papers.mcpConfig, 'utf8'));
  assert.deepEqual(Object.keys(mcpJson.mcpServers), ['paper-search']);
  assert.ok(papers.mcpTools.includes('mcp__paper-search__search_openalex'));
  assert.ok(papers.mcpTools.includes('mcp__paper-search__download_arxiv'));
  assert.equal(papers.mcpTools.includes('mcp__paper-search__download_scihub'), false);
  assert.equal(papers.mcpTools.some((tool) => tool.includes('*')), false);
  const researcher = await resolveRoleAgent({ config, agentRole: 'researcher', adapter: 'claude', cwd: root });
  assert.equal('mcpConfig' in researcher, false);
  const codexPapers = await resolveRoleAgent({ config, agentRole: 'paper-researcher', adapter: 'codex', cwd: root });
  assert.deepEqual(codexPapers.mcpServers, { 'paper-search': { command: 'uvx', args: ['paper-search-mcp'] } });
  const codexResearcher = await resolveRoleAgent({ config, agentRole: 'researcher', adapter: 'codex', cwd: root });
  assert.equal('mcpServers' in codexResearcher, false);

  // A project that never ran `aorch install` must be told that, not handed an
  // opaque exit 1 from the CLI after the worker process has already started.
  const missing = { ...config, roleAgents: { ...config.roleAgents, worker: { claude: 'aorch-nonexistent', codex: 'aorch-worker' } } };
  await assert.rejects(
    resolveRoleAgent({ config: missing, agentRole: 'worker', adapter: 'claude', cwd: root }),
    /aorch-nonexistent\.md not found.*aorch install/s
  );
});
