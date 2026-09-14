import { mkdir, mkdtemp, readFile, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { forceRoute, selectRoute } from './router.js';
import { readAllProviderQuotas } from './quota.js';
import { writeJsonAtomic } from './fs-util.js';
import { selectCapabilities } from './capabilities.js';
import { providerById } from './config.js';
import { buildTaskPrompt } from './providers/base.js';
import { buildClaudeCommand } from './providers/claude-cli.js';
import { buildCodexCommand } from './providers/codex-cli.js';
import { buildAntigravityCommand, parseAntigravityOutput } from './providers/antigravity-cli.js';
import {
  buildGrokCommand,
  buildGrokFinalizeCommand,
  GROK_FINALIZE_PROMPT,
  extractGrokUsage,
  parseGrokOutput,
  parseGrokWorkOutput
} from './providers/grok-cli.js';
import { buildGenericCommand } from './providers/generic-cli.js';
import { runCommand } from './executor.js';
import { classifyProviderFailure, resolveProviderCommandSpec } from './provider-diagnostics.js';
import { validateTask } from './task.js';
import { resolveRoleAgent } from './role-agent.js';
import { runGit } from './change-guard.js';
import { strictReceiptSchema, normalizeReceiptInputRequest } from './receipts.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_SCHEMA_PATH = path.join(PACKAGE_ROOT, 'schemas', 'worker-receipt.schema.json');
const GROK_FINALIZE_MIN_MS = 30_000;
const GROK_FINALIZE_MAX_MS = 120_000;

function grokWorkTimeoutMs(timeoutMs) {
  if (timeoutMs === 0) return 0;
  if (timeoutMs < GROK_FINALIZE_MIN_MS * 2) return Math.max(1, Math.ceil(timeoutMs / 2));
  const finalizeReserve = Math.min(
    GROK_FINALIZE_MAX_MS,
    Math.max(GROK_FINALIZE_MIN_MS, Math.floor(timeoutMs * 0.2))
  );
  return Math.max(1, timeoutMs - finalizeReserve);
}

async function withProviderLaunchCwd({ isolated, cwd }, operation) {
  if (!isolated) return operation(cwd);
  const launchCwd = await mkdtemp(path.join(tmpdir(), 'aorch-codex-launch-'));
  try { return await operation(launchCwd); }
  finally { await rmdir(launchCwd); }
}

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

function sanitizeUsage(usage, fields) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const sanitized = {};
  for (const [source, target] of Object.entries(fields)) {
    const value = usage[source];
    if (Number.isFinite(value) && value >= 0) sanitized[target] = value;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function addUsage(first, second) {
  if (!first && !second) return undefined;
  const combined = {};
  for (const usage of [first, second]) {
    for (const [key, value] of Object.entries(usage ?? {})) {
      if (Number.isFinite(value) && value >= 0) combined[key] = (combined[key] ?? 0) + value;
    }
  }
  return Object.keys(combined).length > 0 ? combined : undefined;
}

function promptDigest({ prompt, route, agent }) {
  return createHash('sha256').update(JSON.stringify({ prompt, route, agent: agent ?? null })).digest('hex');
}

async function readGrokWorkState(statePath, expectedDigest) {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (state?.version !== 1 || state.promptDigest !== expectedDigest
      || typeof state.sessionId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(state.sessionId)) return null;
    return state;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function parseClaudeOutput(stdout) {
  const parsed = JSON.parse(stdout);
  return {
    receipt: parsed.structured_output ?? parsed.result?.structured_output ?? parsed,
    usage: sanitizeUsage(parsed.usage ?? parsed.result?.usage, {
      input_tokens: 'inputTokens',
      output_tokens: 'outputTokens',
      cache_read_input_tokens: 'cacheReadTokens',
      cache_creation_input_tokens: 'cacheCreationTokens'
    })
  };
}

function parseCodexUsage(stdout) {
  const events = String(stdout ?? '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; }
    catch { return []; }
  });
  const completed = events.findLast((event) => event?.type === 'turn.completed');
  return sanitizeUsage(completed?.usage, {
    input_tokens: 'inputTokens',
    cached_input_tokens: 'cacheReadTokens',
    output_tokens: 'outputTokens'
  });
}

async function parseWorkerOutput({ provider, stdout, outputPath }) {
  if (provider.adapter === 'codex') {
    return { receipt: JSON.parse(await readFile(outputPath, 'utf8')), usage: parseCodexUsage(stdout) };
  }
  if (provider.adapter === 'claude') return parseClaudeOutput(stdout);
  if (provider.adapter === 'antigravity') return parseAntigravityOutput(stdout);
  if (provider.adapter === 'grok') return parseGrokOutput(stdout);
  return { receipt: JSON.parse(stdout) };
}

function valueHasType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return Number.isFinite(value);
  return typeof value === type;
}

function assertJsonSchema(value, schema, location = '$') {
  if (schema.anyOf) {
    const matched = schema.anyOf.some((candidate) => {
      try { assertJsonSchema(value, candidate, location); return true; }
      catch { return false; }
    });
    if (!matched) throw new Error(`${location} does not match any allowed schema`);
    return;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => valueHasType(value, type))) {
      throw new Error(`${location} must be ${types.join(' or ')}`);
    }
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${location} has an unsupported value`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${location} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(`${location} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) throw new Error(`${location} has an invalid format`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${location} is below its minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${location} is above its maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${location} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${location} has too many items`);
    if (schema.items) value.forEach((entry, index) => assertJsonSchema(entry, schema.items, `${location}[${index}]`));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) throw new Error(`${location}.${required} is required`);
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find((key) => !Object.hasOwn(schema.properties, key));
      if (extra) throw new Error(`${location}.${extra} is not allowed`);
    }
    for (const [key, entry] of Object.entries(value)) {
      if (schema.properties[key]) assertJsonSchema(entry, schema.properties[key], `${location}.${key}`);
    }
  }
}

function assertStructuredReceipt(receipt, schema, adapter) {
  try { assertJsonSchema(receipt, schema); }
  catch (cause) {
    const error = new Error(`${adapter} protocol error: structured output violates the receipt schema (${cause.message})`);
    error.failureKind = 'protocol';
    throw error;
  }
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
  forcedRoute,
  runCommandImpl = runCommand,
  resolveCommandSpecImpl = resolveProviderCommandSpec
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
  const provider = providerById(config, route.provider);
  const capabilities = selectCapabilities({
    requestedIds: task.capabilityIds ?? [],
    inventory: config.capabilities,
    provider,
    limits: config.capabilityLimits
  });
  const runId = task.runId ?? randomUUID();
  const runDir = path.join(stateRoot, 'task-runs', runId, task.id);
  const receiptPath = path.join(runDir, 'receipt.json');
  const outputPath = path.join(runDir, 'worker-output.json');
  const promptPath = path.join(runDir, 'worker-prompt.md');
  const finalizePromptPath = path.join(runDir, 'grok-finalize-prompt.md');
  const grokWorkStatePath = path.join(runDir, 'grok-work-phase.json');
  const schema = JSON.parse(await readFile(RECEIPT_SCHEMA_PATH, 'utf8'));
  const strictSchema = strictReceiptSchema(schema);
  const schemaPath = path.join(runDir, 'receipt-schema.json');
  const prompt = buildTaskPrompt({ task, route, capabilities, receiptPath });
  // A task without agentRole keeps the pre-pipeline behaviour exactly: no
  // preset is resolved and the adapters build the same command as before.
  const nativeAdapter = provider.adapter === 'antigravity' || provider.adapter === 'grok';
  const rolePreset = await resolveRoleAgent({
    config,
    agentRole: task.agentRole ?? (nativeAdapter ? 'worker' : undefined),
    agentId: task.agentId,
    adapter: provider.adapter,
    cwd
  });
  if (task.write === true && rolePreset.sandboxMode === 'read-only') {
    throw new Error('Selected agent is read-only; choose a writing agent or a read-only task before execution');
  }

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
      schemaPath,
      outputPath,
      ...(rolePreset.agentInstructions ? { agentInstructions: rolePreset.agentInstructions } : {}),
      ...(rolePreset.mcpServers ? { mcpServers: rolePreset.mcpServers } : {}),
      ...(rolePreset.codexFeatures ? { codexFeatures: rolePreset.codexFeatures } : {}),
      executable: provider.executable ?? 'codex'
    });
  } else if (provider.adapter === 'antigravity') {
    commandSpec = buildAntigravityCommand({
      prompt,
      route,
      write: task.write === true,
      schemaPath,
      cwd,
      ...(rolePreset.agent ? { agent: rolePreset.agent } : {}),
      ...(rolePreset.agentInstructions ? { agentInstructions: rolePreset.agentInstructions } : {}),
      executable: provider.executable ?? 'agy'
    });
  } else if (provider.adapter === 'grok') {
    commandSpec = buildGrokCommand({
      route,
      write: task.write === true,
      promptPath,
      cwd,
      ...(rolePreset.agent ? { agent: rolePreset.agent } : {}),
      executable: provider.executable ?? 'grok',
      maxTurns: task.maxTurns ?? 80
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
  commandSpec = resolveCommandSpecImpl(commandSpec, { provider, cwd });

  if (dryRun) return { task, route, capabilities, provider, commandSpec, receiptPath, runDir };

  await assertWriteIsolation(task, cwd);
  await mkdir(runDir, { recursive: true });
  if (provider.adapter === 'codex') await writeJsonAtomic(schemaPath, strictSchema);
  if (provider.adapter === 'antigravity') await writeJsonAtomic(schemaPath, schema);
  let grokPrompt;
  if (provider.adapter === 'grok') {
    grokPrompt = rolePreset.agentInstructions
      ? `${rolePreset.agentInstructions.trim()}\n\n${prompt}`
      : prompt;
    await writeFile(promptPath, grokPrompt, { encoding: 'utf8', mode: 0o600 });
    await writeFile(finalizePromptPath, GROK_FINALIZE_PROMPT, { encoding: 'utf8', mode: 0o600 });
  }
  const isolateCodexLaunch = provider.adapter === 'codex'
    && rolePreset.codexFeatures?.shell_tool === false;
  const runWorker = async (spec, budgetMs, phase = 'Worker') => {
    let execution;
    try {
      execution = await withProviderLaunchCwd(
        { isolated: isolateCodexLaunch, cwd },
        (launchCwd) => runCommandImpl(spec, { cwd: launchCwd, timeoutMs: budgetMs })
      );
    }
    catch (error) {
      error.route = route;
      error.runDir = runDir;
      error.failureKind = classifyProviderFailure({ error });
      if (error.code === 'ENOENT') error.message = `Provider executable ${provider.executable ?? provider.adapter} is unavailable; install or enable ${provider.id} before retrying`;
      throw error;
    }
    if (execution.exitCode !== 0 || execution.timedOut) {
      // Keep only a bounded stream tail in the thrown message. The full result
      // remains attached for the parent run loop's local evidence handling.
      const evidence = [execution.stderr, execution.stdout]
        .map((stream) => (stream ?? '').trim())
        .filter(Boolean)
        .map((stream) => stream.slice(-400))
        .join('\n');
      const error = new Error(execution.timedOut
        ? `${phase} timed out after ${budgetMs}ms${evidence ? `\n${evidence}` : ''}`
        : `${phase} exited with ${execution.exitCode}${evidence ? `\n${evidence}` : ''}`);
      error.route = route;
      error.runDir = runDir;
      error.result = execution;
      error.failureKind = classifyProviderFailure({ error, result: execution });
      throw error;
    }
    return execution;
  };

  let result;
  let grokWork;
  if (provider.adapter === 'grok') {
    const digest = promptDigest({ prompt: grokPrompt, route, agent: rolePreset.agent });
    const saved = await readGrokWorkState(grokWorkStatePath, digest);
    let workResult;
    if (saved) {
      grokWork = { sessionId: saved.sessionId, turns: saved.turns, usage: saved.usage };
    } else {
      workResult = await runWorker(commandSpec, grokWorkTimeoutMs(timeoutMs), 'Grok work phase');
      try { grokWork = parseGrokWorkOutput(workResult.stdout); }
      catch (error) {
        error.route = route;
        error.runDir = runDir;
        error.result = workResult;
        error.failureKind = classifyProviderFailure({ error, result: workResult });
        throw error;
      }
      if (grokWork.turns !== undefined && grokWork.turns >= 2) {
        await writeJsonAtomic(grokWorkStatePath, {
          version: 1,
          promptDigest: digest,
          sessionId: grokWork.sessionId,
          turns: grokWork.turns,
          ...(grokWork.usage ? { usage: grokWork.usage } : {}),
          execution: {
            ...(workResult.startedAt ? { startedAt: workResult.startedAt } : {}),
            ...(workResult.endedAt ? { endedAt: workResult.endedAt } : {}),
            ...(Number.isFinite(workResult.durationMs) ? { durationMs: workResult.durationMs } : {})
          }
        });
      }
    }
    let finalizeSpec = buildGrokFinalizeCommand({
      route,
      write: task.write === true,
      sessionId: grokWork.sessionId,
      promptPath: finalizePromptPath,
      cwd,
      jsonSchema: strictSchema,
      ...(rolePreset.agent ? { agent: rolePreset.agent } : {}),
      executable: provider.executable ?? 'grok'
    });
    finalizeSpec = resolveCommandSpecImpl(finalizeSpec, { provider, cwd });
    const workDuration = workResult?.durationMs ?? saved?.execution?.durationMs ?? 0;
    const remainingMs = timeoutMs > 0 ? Math.max(1, timeoutMs - workDuration) : 0;
    let finalized;
    try { finalized = await runWorker(finalizeSpec, remainingMs, 'Grok finalization'); }
    catch (error) {
      const usage = addUsage(grokWork.usage, extractGrokUsage(error.result?.stdout));
      if (usage && error.result) error.result = { ...error.result, usage };
      throw error;
    }
    result = {
      ...finalized,
      startedAt: workResult?.startedAt ?? saved?.execution?.startedAt ?? finalized.startedAt,
      durationMs: workDuration + (finalized.durationMs ?? 0),
      stderr: [workResult?.stderr, finalized.stderr].filter(Boolean).join('\n'),
      phaseCount: 2,
      reusedWorkPhase: Boolean(saved)
    };
  } else {
    result = await runWorker(commandSpec, timeoutMs);
  }
  let receipt;
  let parsed;
  try {
    parsed = await parseWorkerOutput({ provider, stdout: result.stdout, outputPath });
    if (provider.adapter === 'antigravity' || provider.adapter === 'grok') {
      assertStructuredReceipt(
        parsed.receipt,
        provider.adapter === 'grok' ? strictSchema : schema,
        provider.adapter
      );
    }
    receipt = normalizeReceiptInputRequest(parsed.receipt);
    if (provider.adapter === 'grok' && grokWork?.turns !== undefined && grokWork.turns < 2
      && receipt.status !== 'blocked') {
      const error = new Error('Grok protocol error: work phase completed without a tool turn');
      error.failureKind = 'protocol';
      throw error;
    }
    const usage = provider.adapter === 'grok' ? addUsage(grokWork?.usage, parsed.usage) : parsed.usage;
    if (usage) result = { ...result, usage };
  } catch (error) {
    error.route = route;
    error.runDir = runDir;
    const phaseUsage = parsed?.usage ?? error.usage;
    const usage = provider.adapter === 'grok' ? addUsage(grokWork?.usage, phaseUsage) : phaseUsage;
    error.result = usage ? { ...result, usage } : result;
    error.failureKind = classifyProviderFailure({ error, result });
    throw error;
  }
  // The worker prompt promises the wrapper persists the receipt here, and the
  // CLI hands this path back to the caller. Keep both true.
  await writeJsonAtomic(receiptPath, receipt);
  return { task, route, capabilities, receipt, result, receiptPath, runDir };
}
