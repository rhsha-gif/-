#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { readObservations, appendObservation } from './observations.js';
import { selectRoute } from './router.js';
import { executeWithVerification } from './run-loop.js';
import { discoverCapabilities, getInventory, mergeCapabilities } from './inventory.js';
import { installProject } from './install.js';
import { updateInstalls } from './update.js';
import { validateTask } from './task.js';
import { validateTaskPlan } from './decompose.js';
import { dispatchPlan } from './dispatch.js';
import { classifyDifficulty } from './difficulty.js';
import { clearLimits, readLimits, setLimit } from './limits.js';

import { computeBranchStatus } from './branch-status.js';
import { applyBranchAction } from './branch-apply.js';
import { readAllProviderQuotas } from './quota.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASK_PLAN_SCHEMA_PATH = path.join(PACKAGE_ROOT, 'schemas', 'task-plan.schema.json');

const HELP = `Adaptive Orchestrator (aorch)\n\n` +
  `Commands:\n` +
  `  route     Select provider, model, and effort for a task JSON file\n` +
  `  exec      Route and dispatch one bounded task\n` +
  `  classify  Map a raw objective to a difficulty and a concrete route\n` +
  `  decompose Print the task-plan contract (--print-schema) or validate a plan (--plan <path>)\n` +
  `  dispatch  Route and run every task in a plan, in order, stopping at the first failure\n` +
  `  record    Append an independently reviewed model-performance observation\n` +
  `  limits    Show, set, or clear provider usage limits (limits [set <provider> --minutes N | clear [provider]])\n` +
  `  branch    Branch lifecycle: status | apply --action <start|finish|cleanup|sync>\n` +
  `  inventory Print configured providers, models, skills, plugins, and hooks\n` +
  `  quota     Report each provider's remaining subscription quota via its usageProbe\n` +
  `  install   Install project-local Claude Code and/or Codex integration\n` +
  `  update    Refresh installed integrations (update [--project <path>] [--check])\n\n` +
  `Common options:\n` +
  `  --config <path>       Config JSON; defaults to .aorch/config.json or packaged config\n` +
  `  --cwd <path>          Project working directory\n` +
  `  --observations <path> Reviewed outcomes JSONL\n`;

const BOOLEAN_FLAGS = new Set(['dry-run', 'force-config', 'project-only', 'help', 'h', 'approved', 'confirm-unmerged', 'check', 'print-schema']);

const COMMON_FLAGS = ['config', 'cwd', 'project-only', 'help', 'h'];
const COMMAND_FLAGS = Object.freeze({
  route: [...COMMON_FLAGS, 'task', 'observations'],
  exec: [...COMMON_FLAGS, 'task', 'observations', 'timeout-ms', 'dry-run'],
  classify: [...COMMON_FLAGS, 'objective', 'role', 'risk', 'providers', 'observations'],
  decompose: [...COMMON_FLAGS, 'plan', 'print-schema'],
  dispatch: [...COMMON_FLAGS, 'plan', 'observations', 'timeout-ms', 'dry-run'],
  record: [...COMMON_FLAGS, 'input', 'observations'],
  limits: [...COMMON_FLAGS, 'minutes', 'note'],
  inventory: [...COMMON_FLAGS],
  quota: [...COMMON_FLAGS],
  branch: [...COMMON_FLAGS, 'action', 'approved', 'confirm-unmerged', 'name', 'observations', 'task'],
  install: ['cwd', 'help', 'h', 'target', 'project', 'force-config'],
  update: ['cwd', 'help', 'h', 'project', 'check']
});

function coerceBoolean(rawKey, value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`--${rawKey} is a boolean flag; pass it without a value or as --${rawKey}=true|false`);
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args[0]?.startsWith('-') ? null : args.shift();
  const flags = {};
  const positionals = [];
  while (args.length) {
    const item = args.shift();
    if (!item.startsWith('--')) {
      positionals.push(item);
      continue;
    }
    const [rawKey, inline] = item.slice(2).split('=', 2);
    if (BOOLEAN_FLAGS.has(rawKey)) {
      // Never let a boolean flag silently swallow a value: `--dry-run true`
      // must not degrade to a real execution because 'true' !== true.
      if (inline !== undefined) flags[rawKey] = coerceBoolean(rawKey, inline);
      else if (args[0] === 'true' || args[0] === 'false') flags[rawKey] = coerceBoolean(rawKey, args.shift());
      else flags[rawKey] = true;
      continue;
    }
    if (inline !== undefined) flags[rawKey] = inline;
    else if (args[0] && !args[0].startsWith('--')) flags[rawKey] = args.shift();
    else flags[rawKey] = true;
  }
  return { command, flags, positionals };
}

function validateCommandArgs(command, flags, positionals) {
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) return;
  // `limits` takes an action and an optional provider as positionals.
  const positionalBudget = command === 'limits' || command === 'branch' ? 2 : 0;
  if (positionals.length > positionalBudget) {
    throw new Error(`Unexpected argument for ${command}: ${positionals[positionalBudget]}`);
  }
  const allowedSet = new Set(allowed);
  for (const name of Object.keys(flags)) {
    if (!allowedSet.has(name)) {
      throw new Error(`Unknown option for ${command}: --${name}`);
    }
  }
}

function requireFlag(flags, name) {
  const value = flags[name];
  if (!value || value === true) throw new Error(`--${name} is required`);
  return value;
}

function numericFlag(flags, name) {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (value === true) throw new Error(`--${name} requires a numeric value`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new RangeError(`--${name} must be a non-negative number of milliseconds`);
  }
  return number;
}

async function readJson(filePath, cwd) {
  return JSON.parse(await readFile(path.resolve(cwd, filePath), 'utf8'));
}

function resolveObservationPath(config, flags, cwd) {
  return path.resolve(cwd, flags.observations || config.paths.observationsFile || '.aorch/observations.jsonl');
}

function resolveStateRoot(config, cwd) {
  return path.resolve(cwd, config.paths?.stateDir ?? '.aorch');
}

// Route and exec must not pick a provider that is known to be limited: merge
// active limits into the task's forbiddenProviders. When that forbids every
// candidate, the router's normal "no eligible route" error surfaces — there
// is no silent bypass.
async function applyActiveLimits(task, config, cwd) {
  const limits = await readLimits(resolveStateRoot(config, cwd));
  const limited = Object.keys(limits);
  if (limited.length === 0) return task;
  task.forbiddenProviders = [...new Set([...(task.forbiddenProviders ?? []), ...limited])];
  return task;
}

function cleanRoute(route) {
  return {
    provider: route.provider,
    profileId: route.profileId,
    model: route.model,
    effort: route.effort,
    predictedQuality: route.quality,
    tokenIndex: route.tokenIndex,
    latencyIndex: route.latencyIndex,
    maturity: route.maturity,
    adapterMaturity: route.adapterMaturity,
    decision: route.decision
  };
}

async function main(argv = process.argv.slice(2)) {
  const { command, flags, positionals } = parseArgs(argv);
  if (!command || command === 'help' || flags.help || flags.h) {
    process.stdout.write(HELP);
    return 0;
  }
  validateCommandArgs(command, flags, positionals);
  const cwd = path.resolve(flags.cwd || process.cwd());

  if (command === 'install') {
    const result = await installProject({
      projectRoot: path.resolve(cwd, flags.project || '.'),
      target: flags.target || 'both',
      forceConfig: flags['force-config'] === true
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  // Refresh runs before config loading on purpose: it must work from any
  // directory, including one with no .aorch config of its own.
  if (command === 'update') {
    const explicit = typeof flags.project === 'string' ? [path.resolve(cwd, flags.project)] : undefined;
    const result = await updateInstalls({ projects: explicit, check: flags.check === true });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.failed > 0 ? 1 : 0;
  }

  const config = await loadConfig({ cwd, configPath: flags.config });
  config.capabilities = mergeCapabilities(
    config.capabilities,
    await discoverCapabilities({ cwd, includeUser: flags['project-only'] !== true })
  );

  if (command === 'route') {
    const task = await applyActiveLimits(validateTask(await readJson(requireFlag(flags, 'task'), cwd)), config, cwd);
    const observations = await readObservations(resolveObservationPath(config, flags, cwd));
    const quota = await readAllProviderQuotas(config.providers, {
      stateRoot: resolveStateRoot(config, cwd),
      ttlMs: (config.routing?.quota?.cacheTtlMinutes ?? 5) * 60_000,
      cwd
    });
    const route = selectRoute({ task, catalog: config, observations, quota });
    process.stdout.write(`${JSON.stringify(cleanRoute(route), null, 2)}\n`);
    return 0;
  }

  if (command === 'exec') {
    const timeoutMs = numericFlag(flags, 'timeout-ms');
    const task = await applyActiveLimits(
      validateTask(await readJson(requireFlag(flags, 'task'), cwd), { forExecution: true }),
      config,
      cwd
    );
    const observations = await readObservations(resolveObservationPath(config, flags, cwd));
    const result = await executeWithVerification({
      task,
      config,
      observations,
      cwd,
      observationsPath: resolveObservationPath(config, flags, cwd),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      dryRun: flags['dry-run'] === true
    });
    const output = flags['dry-run'] === true
      ? { route: cleanRoute(result.route), capabilities: result.capabilities, commandSpec: result.commandSpec, runDir: result.runDir }
      : { route: cleanRoute(result.route), receipt: result.receipt, receiptPath: result.receiptPath, runDir: result.runDir, verification: result.verification, attempts: result.attempts };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  }

  if (command === 'classify') {
    const objective = requireFlag(flags, 'objective');
    const classification = classifyDifficulty({ objective });
    // Default stays Claude-only: the common caller is the subagent gate, and
    // a Claude Code subagent's model cannot be a Codex model. Cross-provider
    // callers (cross fallback, manual delegation) opt in via --providers.
    const allowedProviders = typeof flags.providers === 'string'
      ? flags.providers.split(',').map((entry) => entry.trim()).filter(Boolean)
      : ['anthropic'];
    const task = validateTask({
      id: 'classify-probe',
      objective,
      role: flags.role ?? 'executor',
      risk: flags.risk ?? 'standard',
      kind: classification.kind,
      complexity: classification.complexity,
      minimumQuality: classification.minimumQuality,
      allowedProviders,
      routingPriorities: classification.routingPriorities
    });
    // Cache-only (refresh: false): classify backs the subagent gate, which is
    // called far too often to ever pay a 10s-per-provider probe on expiry.
    const quota = await readAllProviderQuotas(config.providers, {
      stateRoot: resolveStateRoot(config, cwd),
      ttlMs: (config.routing?.quota?.cacheTtlMinutes ?? 5) * 60_000,
      refresh: false,
      cwd
    });
    // classify used to pass observations: [], which meant the subagent gate —
    // the one routing decision made on nearly every prompt — could never see
    // that a tier had been failing verification. Reading them is what makes
    // "downshift to what actually passes first time" possible at all.
    // Fail-open on a bad ledger: this gate is a cost optimization, and a
    // corrupt observations file must not block a spawn.
    let observations = [];
    try {
      observations = await readObservations(resolveObservationPath(config, flags, cwd));
    } catch (error) {
      process.stderr.write(`aorch classify: ignoring unreadable observations (${error.message})\n`);
    }
    const route = selectRoute({ task, catalog: config, observations, quota });
    process.stdout.write(`${JSON.stringify({
      classification,
      route: { provider: route.provider, model: route.model, effort: route.effort }
    })}\n`);
    return 0;
  }

  if (command === 'decompose') {
    // --print-schema is what the host model reads before it decomposes. Keeping
    // the contract printable means the lead never has to guess the shape, and
    // the shape has exactly one source of truth.
    if (flags['print-schema'] === true) {
      process.stdout.write(`${await readFile(TASK_PLAN_SCHEMA_PATH, 'utf8')}`);
      return 0;
    }
    if (!flags.plan) {
      process.stderr.write('aorch decompose requires --print-schema or --plan <path>\n');
      return 1;
    }
    try {
      const plan = validateTaskPlan(await readJson(requireFlag(flags, 'plan'), cwd));
      process.stdout.write(`${JSON.stringify({
        ok: true,
        decomposed: plan.decomposed,
        taskCount: plan.tasks.length,
        agentRoles: plan.tasks.map((entry) => entry.agentRole)
      }, null, 2)}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`aorch decompose: ${error.message}\n`);
      return 1;
    }
  }

  if (command === 'dispatch') {
    const timeoutMs = numericFlag(flags, 'timeout-ms');
    const plan = await readJson(requireFlag(flags, 'plan'), cwd);
    const observationsPath = resolveObservationPath(config, flags, cwd);
    const result = await dispatchPlan({
      plan,
      config,
      observations: await readObservations(observationsPath),
      cwd,
      dryRun: flags['dry-run'] === true,
      forbiddenProviders: Object.keys(await readLimits(resolveStateRoot(config, cwd))),
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    // A stopped plan must not read as success to a caller checking exit codes.
    return result.ok ? 0 : 1;
  }

  if (command === 'limits') {
    const stateRoot = resolveStateRoot(config, cwd);
    const [action, provider] = positionals;
    if (action === undefined) {
      process.stdout.write(`${JSON.stringify(await readLimits(stateRoot), null, 2)}\n`);
      return 0;
    }
    if (action === 'set') {
      if (!provider) throw new Error('limits set requires a provider id');
      if (!config.providers.some((entry) => entry.id === provider)) {
        throw new Error(`Unknown provider for limits set: ${provider}`);
      }
      const minutes = numericFlag(flags, 'minutes');
      if (minutes === undefined || minutes <= 0) throw new Error('--minutes must be a positive number of minutes');
      const entry = await setLimit(stateRoot, provider, {
        minutes,
        source: 'manual',
        note: typeof flags.note === 'string' ? flags.note : undefined
      });
      process.stdout.write(`${JSON.stringify({ provider, ...entry }, null, 2)}\n`);
      return 0;
    }
    if (action === 'clear') {
      process.stdout.write(`${JSON.stringify(await clearLimits(stateRoot, provider), null, 2)}\n`);
      return 0;
    }
    throw new Error(`Unknown limits action: ${action}`);
  }

  if (command === 'record') {
    const input = await readJson(requireFlag(flags, 'input'), cwd);
    const observation = await appendObservation(resolveObservationPath(config, flags, cwd), input);
    process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
    return 0;
  }

  if (command === 'inventory') {
    process.stdout.write(`${JSON.stringify(getInventory(config), null, 2)}\n`);
    return 0;
  }

  if (command === 'quota') {
    // ttlMs 0: a human asking for quota wants fresh numbers, and the forced
    // probe doubles as a cache refresh for the routing paths.
    const quota = await readAllProviderQuotas(config.providers, {
      stateRoot: resolveStateRoot(config, cwd),
      ttlMs: 0,
      cwd
    });
    const results = (config.providers ?? []).map((provider) => ({
      provider: provider.id,
      remainingPercent: quota[provider.id] ?? null
    }));
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return 0;
  }

  if (command === 'branch') {
    const sub = positionals[0] ?? 'status';
    if (sub === 'status') {
      const status = await computeBranchStatus({ cwd, config });
      process.stdout.write(`${JSON.stringify(status)}\n`);
      return 0;
    }
    if (sub === 'apply') {
      const action = requireFlag(flags, 'action');
      const result = await applyBranchAction({
        cwd,
        config,
        action,
        approved: flags.approved === true,
        options: {
          name: typeof flags.name === 'string' ? flags.name : undefined,
          confirmUnmerged: flags['confirm-unmerged'] === true
        }
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    throw new Error(`Unknown branch subcommand: ${sub}`);
  }

  throw new Error(`Unknown command: ${command}`);
}

function isCliEntrypoint(argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(argvPath) === fileURLToPath(import.meta.url);
  }
}

const isEntry = isCliEntrypoint();
if (isEntry) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`aorch: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export { isCliEntrypoint, main, parseArgs };
