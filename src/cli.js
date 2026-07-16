#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { readObservations, appendObservation } from './observations.js';
import { selectRoute } from './router.js';
import { executeTask } from './task-runner.js';
import { discoverCapabilities, getInventory, mergeCapabilities } from './inventory.js';
import { calculateProgress } from './progress.js';
import {
  createRun,
  finishRun,
  loadRun,
  resolveActiveRun,
  updateTaskState
} from './state.js';
import {
  appendUserFeedback,
  decideProposal,
  lintLessons,
  loadLessons,
  loadRetrospective,
  saveRetrospective
} from './learning.js';
import { installProject } from './install.js';
import { inspectStateHealth, runDoctor } from './doctor.js';
import { validateTask } from './task.js';
import { validateReceipt } from './receipt.js';
import { verifyTaskClaim } from './verifier.js';

const HELP = `Adaptive Orchestrator (aorch)\n\n` +
  `Commands:\n` +
  `  route     Select provider, model, and effort for a task JSON file\n` +
  `  exec      Route and execute one bounded task\n` +
  `  verify    Independently replay checks and attest a worker claim\n` +
  `  record    Append an independently reviewed model-performance observation\n` +
  `  inventory Print configured providers, models, skills, plugins, and hooks\n` +
  `  progress  Calculate weighted estimated progress from a run state file\n` +
  `  lessons   Show advisory prevention rules; add --lint to inspect memory governance\n` +
  `  run       Manage run lifecycle, reflection, feedback, and proposal consent\n` +
  `  install   Install project-local Claude Code and/or Codex integration\n` +
  `  doctor    Validate config, CLIs, and durable state; add --repair to repair JSONL tails and stale locks\n\n` +
  `Run actions:\n` +
  `  start     --input <manifest.json>\n` +
  `  task      [--run active|id|path] --task <id> --status <status> [--fraction <0..1>]\n` +
  `  finish    [--run active|id|path] --status completed|partial|blocked|failed|cancelled\n` +
  `  show      [--run active|id|path]\n` +
  `  reflect   [--run active|id|path] --input <retrospective.json>\n` +
  `  feedback  [--run active|id|path] --input <feedback.json>\n` +
  `  decide    [--run active|id|path] --proposal <id> --decision approved|rejected\n\n` +
  `Common options:\n` +
  `  --config <path>       Config JSON; defaults to .aorch/config.json or packaged config\n` +
  `  --cwd <path>          Project working directory\n` +
  `  --observations <path> Reviewed outcomes JSONL\n` +
  `  --verification-timeout-ms <n> Independent verification timeout per command\n`;

const BOOLEAN_FLAGS = new Set(['dry-run', 'repair', 'force-config', 'lint', 'project-only', 'help', 'h']);

const COMMON_FLAGS = ['config', 'cwd', 'project-only', 'help', 'h'];
const COMMAND_FLAGS = Object.freeze({
  route: [...COMMON_FLAGS, 'task', 'observations'],
  exec: [...COMMON_FLAGS, 'task', 'observations', 'timeout-ms', 'verification-timeout-ms', 'dry-run'],
  verify: [...COMMON_FLAGS, 'task', 'receipt', 'run-dir', 'isolation', 'verification-timeout-ms'],
  record: [...COMMON_FLAGS, 'input', 'observations'],
  inventory: [...COMMON_FLAGS],
  lessons: [...COMMON_FLAGS, 'lint', 'query', 'limit'],
  progress: [...COMMON_FLAGS, 'tasks', 'run'],
  run: [...COMMON_FLAGS, 'action', 'input', 'run', 'task', 'status', 'fraction', 'note', 'proposal', 'decision', 'comment'],
  install: ['cwd', 'help', 'h', 'target', 'project', 'force-config'],
  doctor: [...COMMON_FLAGS, 'repair']
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
    providerTrustTier: route.providerTrustTier,
    adapterMaturity: route.adapterMaturity,
    decision: route.decision
  };
}

function stateRoot(config, cwd) {
  return path.resolve(cwd, config.paths?.stateDir ?? '.aorch');
}

async function resolveRunReference({ root, cwd, ref = 'active' }) {
  if (!ref || ref === true || ref === 'active') {
    const active = await resolveActiveRun(root);
    if (!active) throw new Error('No active orchestration run');
    return active;
  }
  const candidate = String(ref);
  if (!candidate.includes('/') && !candidate.includes('\\') && !candidate.endsWith('.json')
    && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate)) {
    throw new Error('run reference must be a path-safe id or a state-root path');
  }
  const runPath = candidate.includes('/') || candidate.includes('\\') || candidate.endsWith('.json')
    ? path.resolve(cwd, candidate)
    : path.join(root, 'runs', candidate, 'run.json');
  // Compare realpaths like state.js/doctor.js so symlinked state roots behave
  // consistently across every containment check.
  const resolveReal = async (target) => {
    try { return await realpath(target); }
    catch { return path.resolve(target); }
  };
  const relative = path.relative(await resolveReal(root), await resolveReal(runPath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('run reference resolves outside the configured state root');
  }
  return { ...(await loadRun(runPath)), path: runPath, dir: path.dirname(runPath) };
}

async function handleRunCommand({ flags, cwd, config }) {
  const action = requireFlag(flags, 'action');
  const root = stateRoot(config, cwd);

  if (action === 'start') {
    const manifest = await readJson(requireFlag(flags, 'input'), cwd);
    const run = await createRun({
      root,
      prompt: manifest.prompt,
      tasks: manifest.tasks ?? [],
      runId: manifest.runId
    });
    return { action, run };
  }

  const run = await resolveRunReference({ root, cwd, ref: flags.run ?? 'active' });

  if (action === 'task') {
    const patch = { status: requireFlag(flags, 'status') };
    if (flags.fraction !== undefined && flags.fraction !== true) {
      const fraction = Number(flags.fraction);
      if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
        throw new RangeError('--fraction must be between 0 and 1');
      }
      patch.fraction = fraction;
    }
    if (flags.note && flags.note !== true) patch.note = flags.note;
    return { action, run: await updateTaskState(run.path, requireFlag(flags, 'task'), patch), path: run.path };
  }

  if (action === 'finish') {
    return { action, run: await finishRun(run.path, requireFlag(flags, 'status')), path: run.path };
  }

  if (action === 'show') {
    return { action, run, retrospective: run.reviewStatus === 'complete' ? await loadRetrospective({ root, runId: run.id }) : null };
  }

  if (action === 'reflect') {
    const input = await readJson(requireFlag(flags, 'input'), cwd);
    return { action, retrospective: await saveRetrospective({ root, runPath: run.path, input }) };
  }

  if (action === 'feedback') {
    const feedback = await readJson(requireFlag(flags, 'input'), cwd);
    return { action, retrospective: await appendUserFeedback({ root, runId: run.id, feedback }) };
  }

  if (action === 'decide') {
    return {
      action,
      retrospective: await decideProposal({
        root,
        runId: run.id,
        proposalId: requireFlag(flags, 'proposal'),
        decision: requireFlag(flags, 'decision'),
        comment: flags.comment && flags.comment !== true ? flags.comment : ''
      })
    };
  }

  throw new Error(`Unknown run action: ${action}`);
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
    const verificationTimeoutMs = numericFlag(flags, 'verification-timeout-ms');
    const task = validateTask(await readJson(requireFlag(flags, 'task'), cwd), { forExecution: true });
    const observations = await readObservations(resolveObservationPath(config, flags, cwd));
    const result = await executeTask({
      task,
      config,
      observations,
      cwd,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      verificationTimeoutMs,
      dryRun: flags['dry-run'] === true
    });
    const output = flags['dry-run'] === true
      ? { route: cleanRoute(result.route), capabilities: result.capabilities, commandSpec: result.commandSpec, runDir: result.runDir }
      : { route: cleanRoute(result.route), receipt: result.receipt, receiptPath: result.receiptPath, attestation: result.attestation, attestationPath: result.attestationPath, runDir: result.runDir };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  }

  if (command === 'verify') {
    const task = validateTask(await readJson(requireFlag(flags, 'task'), cwd), { forExecution: true });
    const receipt = validateReceipt(await readJson(requireFlag(flags, 'receipt'), cwd), { task });
    const runDir = flags['run-dir'] && flags['run-dir'] !== true
      ? path.resolve(cwd, flags['run-dir'])
      : path.join(stateRoot(config, cwd), 'manual-verifications', randomUUID(), task.id);
    const isolationMode = flags.isolation && flags.isolation !== true
      ? flags.isolation
      : (task.verificationIsolation ?? config.verification?.isolationByRisk?.[task.risk] ?? 'same-workspace');
    const attestation = await verifyTaskClaim({
      task, receipt, cwd, runDir, isolationMode,
      timeoutMs: numericFlag(flags, 'verification-timeout-ms') ?? config.verification?.commandTimeoutMs
    });
    process.stdout.write(`${JSON.stringify({ attestation, attestationPath: attestation.path, runDir }, null, 2)}\n`);
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

  if (command === 'lessons') {
    const root = stateRoot(config, cwd);
    if (flags.lint === true) {
      const result = await lintLessons({ root });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.status === 'pass' ? 0 : 1;
    }
    const limit = flags.limit && flags.limit !== true ? Number(flags.limit) : 10;
    if (!Number.isInteger(limit) || limit < 0 || limit > 50) throw new RangeError('--limit must be an integer from 0 to 50');
    const lessons = await loadLessons({
      root,
      query: flags.query && flags.query !== true ? flags.query : '',
      limit
    });
    process.stdout.write(`${JSON.stringify(lessons, null, 2)}\n`);
    return 0;
  }

  if (command === 'progress') {
    let tasks;
    if (flags.tasks && flags.tasks !== true) {
      const graph = await readJson(flags.tasks, cwd);
      tasks = Array.isArray(graph) ? graph : graph.tasks;
      if (!Array.isArray(tasks)) throw new Error('--tasks must point to an array or an object with tasks');
    } else {
      const run = await resolveRunReference({ root: stateRoot(config, cwd), cwd, ref: flags.run ?? 'active' });
      tasks = run.tasks;
    }
    process.stdout.write(`${JSON.stringify(calculateProgress(tasks), null, 2)}\n`);
    return 0;
  }

  if (command === 'run') {
    const result = await handleRunCommand({ flags, cwd, config });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (command === 'doctor') {
    const root = stateRoot(config, cwd);
    const core = runDoctor(config);
    const state = await inspectStateHealth(root, { repair: flags.repair === true });
    const lessons = await lintLessons({ root });
    const result = {
      ...core,
      state,
      lessons,
      status: core.status === 'pass' && state.status === 'pass' && lessons.status === 'pass' ? 'pass' : 'fail'
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === 'pass' ? 0 : 1;
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

export { handleRunCommand, isCliEntrypoint, main, parseArgs };
