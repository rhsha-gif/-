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
import { validateTask } from './task.js';
import { classifyDifficulty } from './difficulty.js';

const HELP = `Adaptive Orchestrator (aorch)\n\n` +
  `Commands:\n` +
  `  route     Select provider, model, and effort for a task JSON file\n` +
  `  exec      Route and dispatch one bounded task\n` +
  `  classify  Map a raw objective to a difficulty and a concrete route\n` +
  `  record    Append an independently reviewed model-performance observation\n` +
  `  inventory Print configured providers, models, skills, plugins, and hooks\n` +
  `  install   Install project-local Claude Code and/or Codex integration\n\n` +
  `Common options:\n` +
  `  --config <path>       Config JSON; defaults to .aorch/config.json or packaged config\n` +
  `  --cwd <path>          Project working directory\n` +
  `  --observations <path> Reviewed outcomes JSONL\n`;

const BOOLEAN_FLAGS = new Set(['dry-run', 'force-config', 'project-only', 'help', 'h']);

const COMMON_FLAGS = ['config', 'cwd', 'project-only', 'help', 'h'];
const COMMAND_FLAGS = Object.freeze({
  route: [...COMMON_FLAGS, 'task', 'observations'],
  exec: [...COMMON_FLAGS, 'task', 'observations', 'timeout-ms', 'dry-run'],
  classify: [...COMMON_FLAGS, 'objective', 'role', 'risk'],
  record: [...COMMON_FLAGS, 'input', 'observations'],
  inventory: [...COMMON_FLAGS],
  install: ['cwd', 'help', 'h', 'target', 'project', 'force-config']
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
  if (positionals.length > 0) {
    throw new Error(`Unexpected argument for ${command}: ${positionals[0]}`);
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

  const config = await loadConfig({ cwd, configPath: flags.config });
  config.capabilities = mergeCapabilities(
    config.capabilities,
    await discoverCapabilities({ cwd, includeUser: flags['project-only'] !== true })
  );

  if (command === 'route') {
    const task = validateTask(await readJson(requireFlag(flags, 'task'), cwd));
    const observations = await readObservations(resolveObservationPath(config, flags, cwd));
    const route = selectRoute({ task, catalog: config, observations });
    process.stdout.write(`${JSON.stringify(cleanRoute(route), null, 2)}\n`);
    return 0;
  }

  if (command === 'exec') {
    const timeoutMs = numericFlag(flags, 'timeout-ms');
    const task = validateTask(await readJson(requireFlag(flags, 'task'), cwd), { forExecution: true });
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
    const task = validateTask({
      id: 'classify-probe',
      objective,
      role: flags.role ?? 'executor',
      risk: flags.risk ?? 'standard',
      kind: classification.kind,
      complexity: classification.complexity,
      minimumQuality: classification.minimumQuality,
      // arm1 is Claude-only: Codex delegation is a separately-gated later
      // arm, and a Claude Code subagent's model cannot be a Codex model.
      allowedProviders: ['anthropic'],
      routingPriorities: classification.routingPriorities
    });
    const route = selectRoute({ task, catalog: config, observations: [] });
    process.stdout.write(`${JSON.stringify({
      classification,
      route: { provider: route.provider, model: route.model, effort: route.effort }
    })}\n`);
    return 0;
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
