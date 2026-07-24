import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { selectRoute } from './router.js';
import { selectCapabilities } from './capabilities.js';
import { providerById } from './config.js';
import { buildTaskPrompt } from './providers/base.js';
import { buildClaudeCommand } from './providers/claude-cli.js';
import { buildCodexCommand } from './providers/codex-cli.js';
import { buildGenericCommand } from './providers/generic-cli.js';
import { runCommand } from './executor.js';
import { validateTask } from './task.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_SCHEMA_PATH = path.join(PACKAGE_ROOT, 'schemas', 'worker-receipt.schema.json');

async function git(args, cwd) {
  return runCommand({ command: 'git', args, env: { AORCH_WORKER: '1' } }, { cwd, timeoutMs: 10_000 });
}

// The one safety invariant the judgment layer keeps: writes must not run in the
// live workspace unless deliberately opted in. High/critical writes always need
// an isolated linked worktree. This is blast-radius control, not worker distrust.
async function assertWriteIsolation(task, cwd) {
  if (task.write !== true) return;
  const probe = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  if (probe.exitCode !== 0 || probe.stdout.trim() !== 'true') {
    throw new Error('Write task requires a Git repository and an isolated linked worktree');
  }
  const [gitDir, commonDir] = await Promise.all([
    git(['rev-parse', '--git-dir'], cwd),
    git(['rev-parse', '--git-common-dir'], cwd)
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
// run it, and return the worker's raw receipt. The completion gate, evidence
// plane, and durable run state were part of a different (distributed, distrustful)
// product and were removed; rebuild them on top of these primitives as needed.
export async function executeTask({
  task,
  config,
  observations = [],
  cwd = process.cwd(),
  stateRoot = path.resolve(cwd, config.paths?.stateDir ?? '.aorch'),
  // A hung worker must not hang the orchestrator forever; pass 0 explicitly
  // to disable the watchdog.
  timeoutMs = 60 * 60 * 1000,
  dryRun = false
}) {
  task = validateTask(task, { forExecution: true });
  const route = selectRoute({ task, catalog: config, observations });
  const capabilities = selectCapabilities({
    requestedIds: task.capabilityIds ?? [],
    inventory: config.capabilities,
    provider: route.provider,
    limits: config.capabilityLimits,
    task,
    policy: config.controlPlane ?? {}
  });
  const provider = providerById(config, route.provider);
  const runId = task.runId ?? randomUUID();
  const runDir = path.join(stateRoot, 'task-runs', runId, task.id);
  const receiptPath = path.join(runDir, 'receipt.json');
  const outputPath = path.join(runDir, 'worker-output.json');
  const schema = JSON.parse(await readFile(RECEIPT_SCHEMA_PATH, 'utf8'));
  const prompt = buildTaskPrompt({ task, route, capabilities, receiptPath });

  let commandSpec;
  if (provider.adapter === 'claude') {
    commandSpec = buildClaudeCommand({
      prompt,
      route,
      write: task.write === true,
      jsonSchema: schema,
      pluginDirs: capabilities.plugins.map((plugin) => plugin.path).filter(Boolean),
      maxTurns: task.maxTurns ?? 80,
      executable: provider.executable ?? 'claude'
    });
  } else if (provider.adapter === 'codex') {
    commandSpec = buildCodexCommand({
      prompt,
      route,
      write: task.write === true,
      schemaPath: RECEIPT_SCHEMA_PATH,
      outputPath,
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

  if (dryRun) return { task, route, capabilities, provider, commandSpec, receiptPath, runDir };

  await assertWriteIsolation(task, cwd);
  await mkdir(runDir, { recursive: true });
  const result = await runCommand(commandSpec, { cwd, timeoutMs });
  if (result.exitCode !== 0) {
    throw new Error(`Worker exited with ${result.exitCode}`);
  }
  const receipt = await parseWorkerOutput({ provider, stdout: result.stdout, outputPath });
  return { task, route, capabilities, receipt, result, receiptPath, runDir };
}
