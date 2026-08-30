import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { forceRoute, selectRoute } from './router.js';
import { readAllProviderQuotas } from './quota.js';
import { writeJsonAtomic } from './fs-util.js';
import { selectCapabilities } from './capabilities.js';
import { providerById } from './config.js';
import { buildTaskPrompt } from './providers/base.js';
import { buildClaudeCommand } from './providers/claude-cli.js';
import { buildCodexCommand } from './providers/codex-cli.js';
import { buildGenericCommand } from './providers/generic-cli.js';
import { resolveWindowsCommandSpec, runCommand } from './executor.js';
import { validateTask } from './task.js';
import { resolveRoleAgent } from './role-agent.js';
import { runGit } from './change-guard.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_SCHEMA_PATH = path.join(PACKAGE_ROOT, 'schemas', 'worker-receipt.schema.json');

// The one safety invariant the judgment layer keeps: writes must not run in the
// live workspace unless deliberately opted in. High/critical writes always need
// an isolated linked worktree. This is blast-radius control, not worker distrust.
async function assertWriteIsolation(task, cwd) {
  if (task.write !== true) return;
  const probe = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  if (probe.exitCode !== 0 || probe.stdout.trim() !== 'true') {
    throw new Error('Write task requires a Git repository and an isolated linked worktree');
  }
  const [gitDir, commonDir] = await Promise.all([
    runGit(['rev-parse', '--git-dir'], cwd),
    runGit(['rev-parse', '--git-common-dir'], cwd)
  ]);
  const linkedWorktree = gitDir.exitCode === 0 && commonDir.exitCode === 0
    && path.resolve(cwd, gitDir.stdout.trim()) !== path.resolve(cwd, commonDir.stdout.trim());
  if (linkedWorktree) return;
  if (['high', 'critical'].includes(task.risk)) {
    throw new Error(`${task.risk}-risk write task must run in an isolated linked worktree`);
  }
  if (task.allowInPlaceWrite !== true) {
    throw new Error('Write task must run in an isolated linked worktree; in-place write requires explicit task.allowInPlaceWrite authorization');
  }
}

function parseClaudeOutput(stdout) {
  const parsed = JSON.parse(stdout);
  return parsed.structured_output ?? parsed.result?.structured_output ?? parsed;
}

async function parseWorkerOutput({ provider, stdout, outputPath }) {
  if (provider.adapter === 'codex') return JSON.parse(await readFile(outputPath, 'utf8'));
  if (provider.adapter === 'claude') return parseClaudeOutput(stdout);
  return JSON.parse(stdout);
}

// Thin dispatch: route the task, select capabilities, build the provider command,
// run it, and return the worker's raw receipt. Verification gating and
// escalation live one level up in run-loop.js; this module runs exactly one
// worker once.
export async function executeTask({
  task,
  config,
  observations = [],
  cwd = process.cwd(),
  stateRoot = path.resolve(cwd, config.paths?.stateDir ?? '.aorch'),
  // A hung worker must not hang the orchestrator forever; pass 0 explicitly
  // to disable the watchdog.
  timeoutMs = 60 * 60 * 1000,
  dryRun = false,
  // Escalation override: pins profile and effort, bypassing route selection.
  forcedRoute
}) {
  task = validateTask(task, { forExecution: true });
  // Forced routes (escalation) skip the quota read entirely — the ladder
  // bypasses every eligibility signal, so probing would be pure latency.
  // A dry run reads the cache without refreshing it: previewing a command
  // must stay fast and side-effect free.
  const quota = forcedRoute
    ? null
    : await readAllProviderQuotas(config.providers, {
      stateRoot,
      ttlMs: (config.routing?.quota?.cacheTtlMinutes ?? 5) * 60_000,
      refresh: !dryRun,
      cwd
    });
  const route = forcedRoute
    ? forceRoute({ catalog: config, task, profileId: forcedRoute.profileId, effort: forcedRoute.effort })
    : selectRoute({ task, catalog: config, observations, quota });
  const capabilities = selectCapabilities({
    requestedIds: task.capabilityIds ?? [],
    inventory: config.capabilities,
    provider: route.provider,
    limits: config.capabilityLimits
  });
  const provider = providerById(config, route.provider);
  const runId = task.runId ?? randomUUID();
  const runDir = path.join(stateRoot, 'task-runs', runId, task.id);
  const receiptPath = path.join(runDir, 'receipt.json');
  const outputPath = path.join(runDir, 'worker-output.json');
  const schema = JSON.parse(await readFile(RECEIPT_SCHEMA_PATH, 'utf8'));
  const prompt = buildTaskPrompt({ task, route, capabilities, receiptPath });
  // A task without agentRole keeps the pre-pipeline behaviour exactly: no
  // preset is resolved and the adapters build the same command as before.
  const rolePreset = await resolveRoleAgent({
    config,
    agentRole: task.agentRole,
    adapter: provider.adapter,
    cwd
  });

  let commandSpec;
  if (provider.adapter === 'claude') {
    commandSpec = buildClaudeCommand({
      prompt,
      route,
      write: task.write === true,
      jsonSchema: schema,
      pluginDirs: capabilities.plugins.map((plugin) => plugin.path).filter(Boolean),
      // An explicit task budget wins; otherwise the role's own budget applies —
      // a scout should not get a worker's 80 turns just because the flag always
      // overrides the preset.
      maxTurns: task.maxTurns ?? rolePreset.maxTurns ?? 80,
      ...(rolePreset.agent ? { agent: rolePreset.agent } : {}),
      ...(rolePreset.mcpConfig ? { mcpConfig: rolePreset.mcpConfig, mcpTools: rolePreset.mcpTools } : {}),
      executable: provider.executable ?? 'claude'
    });
  } else if (provider.adapter === 'codex') {
    commandSpec = buildCodexCommand({
      prompt,
      route,
      write: task.write === true,
      schemaPath: RECEIPT_SCHEMA_PATH,
      outputPath,
      ...(rolePreset.agentInstructions ? { agentInstructions: rolePreset.agentInstructions } : {}),
      ...(rolePreset.mcpServers ? { mcpServers: rolePreset.mcpServers } : {}),
      executable: provider.executable ?? 'codex'
    });
  } else {
    commandSpec = buildGenericCommand({ prompt, route, provider, write: task.write === true });
  }
  commandSpec.env = {
    ...commandSpec.env,
    AORCH_SELECTED_CAPABILITIES: (task.capabilityIds ?? []).join(','),
    AORCH_SELECTED_SKILLS: capabilities.skills.map((entry) => entry.id).join(','),
    AORCH_SELECTED_PLUGINS: capabilities.plugins.map((entry) => entry.id).join(','),
    AORCH_SELECTED_HOOKS: capabilities.hooks.map((entry) => entry.id).join(','),
    AORCH_TASK_ID: task.id
  };
  if (provider.adapter === 'codex') {
    commandSpec = resolveWindowsCommandSpec(commandSpec);
  }

  if (dryRun) return { task, route, capabilities, provider, commandSpec, receiptPath, runDir };

  await assertWriteIsolation(task, cwd);
  await mkdir(runDir, { recursive: true });
  const result = await runCommand(commandSpec, { cwd, timeoutMs });
  if (result.exitCode !== 0) {
    // The run loop needs the route and raw output to tell a rate-limited
    // provider apart from a genuine worker failure. The message carries a
    // bounded stream tail because a worker that dies before writing its run
    // directory leaves this as the only diagnosable evidence.
    const evidence = [result.stderr, result.stdout]
      .map((stream) => (stream ?? '').trim())
      .filter(Boolean)
      .map((stream) => stream.slice(-400))
      .join('\n');
    const error = new Error(
      `Worker exited with ${result.exitCode}${evidence ? `\n${evidence}` : ''}`
    );
    error.route = route;
    error.result = result;
    throw error;
  }
  const receipt = await parseWorkerOutput({ provider, stdout: result.stdout, outputPath });
  // The worker prompt promises the wrapper persists the receipt here, and the
  // CLI hands this path back to the caller. Keep both true.
  await writeJsonAtomic(receiptPath, receipt);
  return { task, route, capabilities, receipt, result, receiptPath, runDir };
}
