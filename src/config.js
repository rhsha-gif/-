import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE_METRICS = ['quality', 'tokens', 'latency'];
const TASK_COMPLEXITIES = ['low', 'standard', 'high', 'critical'];
const RISK_TIERS = ['low', 'standard', 'high', 'critical'];
const TRUST_TIERS = ['trusted', 'reviewed', 'untrusted'];
const ADAPTER_MATURITIES = ['stable', 'experimental'];
export const DEFAULT_CONFIG_PATH = path.join(PACKAGE_ROOT, 'config', 'aorch.config.json');

function assertArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
}

function assertUnique(entries, name) {
  const seen = new Set();
  for (const entry of entries) {
    if (!entry?.id || typeof entry.id !== 'string') throw new TypeError(`${name} entries require string id`);
    if (seen.has(entry.id)) throw new Error(`Duplicate ${name} id: ${entry.id}`);
    seen.add(entry.id);
  }
}

function assertNonEmptyStrings(entries, name) {
  assertArray(entries, name);
  if (entries.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new TypeError(`${name} must contain non-empty strings`);
  }
}

function exactProjectFiles(entries, name) {
  assertNonEmptyStrings(entries, name);
  const normalized = entries.map((entry) => {
    const raw = entry.trim().replaceAll('\\', '/').replace(/^\.\//, '');
    if (!raw || raw.endsWith('/') || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)
      || /[*?[]/.test(raw) || raw.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`${name} must contain exact project-relative files`);
    }
    return raw;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error(`${name} must not contain duplicates`);
  return normalized;
}

function positiveNumber(value, name, fallback) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new RangeError(`${name} must be positive`);
  return resolved;
}

function assertOptionalBoolean(value, name) {
  // A string like "false" is truthy everywhere it is read, so an operator who
  // sets enabled:"false" to disable an entry would silently keep it enabled.
  if (value !== undefined && typeof value !== 'boolean') {
    throw new TypeError(`${name} must be a boolean`);
  }
}

function nonNegativeNumber(value, name, fallback) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) throw new RangeError(`${name} must be finite and non-negative`);
  return resolved;
}



function trustTier(value, name, fallback) {
  const resolved = value ?? fallback;
  if (!TRUST_TIERS.includes(resolved)) {
    throw new Error(`${name} must be one of ${TRUST_TIERS.join(', ')}`);
  }
  return resolved;
}

function adapterMaturity(value, name, fallback) {
  const resolved = value ?? fallback;
  if (!ADAPTER_MATURITIES.includes(resolved)) {
    throw new Error(`${name} must be one of ${ADAPTER_MATURITIES.join(', ')}`);
  }
  return resolved;
}

function validateTrustMap(value, name, fallback) {
  const source = value ?? fallback;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError(`${name} must be an object`);
  }
  const result = {};
  for (const risk of RISK_TIERS) {
    const tiers = source[risk];
    if (!Array.isArray(tiers) || tiers.length === 0 || new Set(tiers).size !== tiers.length
      || tiers.some((tier) => !TRUST_TIERS.includes(tier))) {
      throw new TypeError(`${name}.${risk} must be a unique non-empty array of trust tiers`);
    }
    result[risk] = [...tiers];
  }
  return result;
}

function validateControlPlane(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('controlPlane must be an object');
  }
  const defaultProviders = {
    low: ['trusted', 'reviewed', 'untrusted'],
    standard: ['trusted', 'reviewed'],
    high: ['trusted', 'reviewed'],
    critical: ['trusted']
  };
  const defaultCapabilities = {
    low: ['trusted', 'reviewed', 'untrusted'],
    standard: ['trusted', 'reviewed'],
    high: ['trusted', 'reviewed'],
    critical: ['trusted']
  };
  const experimentalAdapterMaxRisk = input.experimentalAdapterMaxRisk ?? 'standard';
  if (!RISK_TIERS.includes(experimentalAdapterMaxRisk)) {
    throw new Error('controlPlane.experimentalAdapterMaxRisk must be low, standard, high, or critical');
  }
  const defaultProtectedFiles = [
    '.aorch/config.json',
    '.aorch/hooks/gate.mjs',
    '.aorch/hooks/user-prompt-submit.mjs',
    '.aorch/hooks/session-review.mjs',
    '.claude/settings.json',
    '.codex/hooks.json',
    '.claude/skills/adaptive-orchestrate/SKILL.md',
    '.claude/skills/post-run-reflection/SKILL.md',
    '.agents/skills/adaptive-orchestrate/SKILL.md',
    '.agents/skills/post-run-reflection/SKILL.md'
  ];
  return {
    ...input,
    providerTrustByRisk: validateTrustMap(input.providerTrustByRisk, 'controlPlane.providerTrustByRisk', defaultProviders),
    capabilityTrustByRisk: validateTrustMap(input.capabilityTrustByRisk, 'controlPlane.capabilityTrustByRisk', defaultCapabilities),
    experimentalAdapterMaxRisk,
    protectedFiles: exactProjectFiles(input.protectedFiles ?? defaultProtectedFiles, 'controlPlane.protectedFiles')
  };
}
function boundedInteger(value, name, fallback, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}

function validateHostPolicy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('hostPolicy must be an object');
  const selectionMode = input.selectionMode ?? 'preferred';
  if (!['preferred', 'pinned', 'bootstrap-only'].includes(selectionMode)) {
    throw new Error('hostPolicy.selectionMode must be preferred, pinned, or bootstrap-only');
  }
  const executionMode = input.executionMode ?? 'bootstrap-only';
  if (executionMode !== 'bootstrap-only') throw new Error('hostPolicy.executionMode must remain bootstrap-only');
  const allowHostProductEdits = input.allowHostProductEdits ?? false;
  if (allowHostProductEdits !== false) throw new Error('hostPolicy.allowHostProductEdits must remain false');
  if (input.directExecutionWhenUnknown === true) throw new Error('hostPolicy.directExecutionWhenUnknown is no longer supported');
  return {
    ...input,
    selectionMode,
    executionMode,
    allowHostProductEdits: false,
    routerEscalationThreshold: boundedInteger(input.routerEscalationThreshold, 'hostPolicy.routerEscalationThreshold', 6, { minimum: 0, maximum: 20 })
  };
}

function validateLanePolicy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('lanePolicy must be an object');
  if (input.direct !== undefined && input['single-worker'] !== undefined) {
    throw new Error('lanePolicy cannot define both legacy direct and single-worker');
  }
  const defaults = {
    'single-worker': { maxTasks: 1, maxExternalModelCalls: 1, maxLlmReviewers: 0 },
    bundled: { maxTasks: 2, maxExternalModelCalls: 1, maxLlmReviewers: 0 },
    orchestrated: { maxTasks: 24, maxExternalModelCalls: 12, maxLlmReviewers: 3 }
  };
  const source = { ...input, 'single-worker': input['single-worker'] ?? input.direct };
  delete source.direct;
  const result = {};
  for (const lane of ['single-worker', 'bundled', 'orchestrated']) {
    const value = source[lane] ?? {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`lanePolicy.${lane} must be an object`);
    result[lane] = {
      ...value,
      maxTasks: boundedInteger(value.maxTasks, `lanePolicy.${lane}.maxTasks`, defaults[lane].maxTasks, { minimum: 1, maximum: 100 }),
      maxExternalModelCalls: boundedInteger(value.maxExternalModelCalls, `lanePolicy.${lane}.maxExternalModelCalls`, defaults[lane].maxExternalModelCalls, { minimum: 1, maximum: 100 }),
      maxLlmReviewers: boundedInteger(value.maxLlmReviewers, `lanePolicy.${lane}.maxLlmReviewers`, defaults[lane].maxLlmReviewers, { minimum: 0, maximum: 20 })
    };
  }
  return result;
}

function validateShadowRouting(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('shadowRouting must be an object');
  }
  const mode = input.mode ?? 'record-only';
  if (!['off', 'record-only'].includes(mode)) {
    throw new Error('shadowRouting.mode must be off or record-only');
  }
  const execute = input.execute ?? false;
  if (execute !== false) {
    throw new Error('shadowRouting.execute must remain false; P2 shadow routing is record-only');
  }
  return { ...input, mode, execute: false };
}

function validatePromptCompilation(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('promptCompilation must be an object');
  }
  const officialSourcesOnly = input.officialSourcesOnly ?? true;
  if (officialSourcesOnly !== true) {
    throw new Error('promptCompilation.officialSourcesOnly must remain true');
  }
  return {
    ...input,
    maxChars: boundedInteger(input.maxChars, 'promptCompilation.maxChars', 40_000, { minimum: 1, maximum: 1_000_000 }),
    maxProfileAgeDays: boundedInteger(input.maxProfileAgeDays, 'promptCompilation.maxProfileAgeDays', 120, { minimum: 1, maximum: 3650 }),
    maxFutureSkewDays: boundedInteger(input.maxFutureSkewDays, 'promptCompilation.maxFutureSkewDays', 1, { minimum: 0, maximum: 30 }),
    officialSourcesOnly
  };
}

function validateRouting(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('routing must be an object');
  }
  const defaultPriorities = input.defaultPriorities ?? ROUTE_METRICS;
  if (!Array.isArray(defaultPriorities) || defaultPriorities.length === 0
    || defaultPriorities.length > ROUTE_METRICS.length
    || defaultPriorities.some((entry) => !ROUTE_METRICS.includes(entry))
    || new Set(defaultPriorities).size !== defaultPriorities.length) {
    throw new TypeError('routing.defaultPriorities must be a unique non-empty array of quality, tokens, and latency');
  }

  const tolerances = {
    qualityTolerance: input.qualityTolerance ?? 0.005,
    tokenTolerance: input.tokenTolerance ?? 0.05,
    latencyTolerance: input.latencyTolerance ?? input.tokenTolerance ?? 0.05
  };
  for (const [field, value] of Object.entries(tolerances)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`routing.${field} must be finite and non-negative`);
    }
  }

  const observationHalfLifeDays = positiveNumber(
    input.observationHalfLifeDays,
    'routing.observationHalfLifeDays',
    30
  );
  const maxObservationAgeDays = positiveNumber(
    input.maxObservationAgeDays,
    'routing.maxObservationAgeDays',
    180
  );
  const maxFutureSkewMinutes = nonNegativeNumber(
    input.maxFutureSkewMinutes,
    'routing.maxFutureSkewMinutes',
    5
  );
  const priorWeight = nonNegativeNumber(input.priorWeight, 'routing.priorWeight', 3);
  const uncertaintyPenalty = nonNegativeNumber(
    input.uncertaintyPenalty,
    'routing.uncertaintyPenalty',
    0.02
  );
  const criticalMinimumSamples = nonNegativeNumber(
    input.criticalMinimumSamples,
    'routing.criticalMinimumSamples',
    3
  );
  if (!Number.isInteger(criticalMinimumSamples)) {
    throw new RangeError('routing.criticalMinimumSamples must be a non-negative integer');
  }

  return {
    ...input,
    ...tolerances,
    observationHalfLifeDays,
    maxObservationAgeDays,
    maxFutureSkewMinutes,
    priorWeight,
    uncertaintyPenalty,
    criticalMinimumSamples,
    defaultPriorities: [...defaultPriorities],
    selectionPolicy: input.selectionPolicy ?? 'task-specific-priority-order'
  };
}

function validateQualityMap(quality, id) {
  if (!quality || typeof quality !== 'object') throw new TypeError(`model ${id} requires quality map`);
  for (const [key, value] of Object.entries(quality)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`model ${id} quality.${key} must be between 0 and 1`);
    }
  }
}

export function validateConfig(input) {
  if (!input || typeof input !== 'object') throw new TypeError('config must be an object');
  if (input.version !== 1) throw new Error(`Unsupported config version: ${input.version}`);
  assertArray(input.providers, 'providers');
  assertArray(input.models, 'models');
  assertArray(input.capabilities ?? [], 'capabilities');
  assertUnique(input.providers, 'provider');
  assertUnique(input.models, 'model');
  assertUnique(input.capabilities ?? [], 'capability');

  const normalizedProviders = input.providers.map((provider) => {
    if (!['claude', 'codex', 'generic'].includes(provider.adapter)) {
      throw new Error(`Unsupported adapter for provider ${provider.id}: ${provider.adapter}`);
    }
    assertOptionalBoolean(provider.enabled, `provider ${provider.id}.enabled`);
    if (provider.adapter === 'generic' && (!provider.executable || !Array.isArray(provider.args))) {
      throw new Error(`Generic provider ${provider.id} requires executable and args`);
    }
    return {
      ...provider,
      trustTier: trustTier(provider.trustTier, `provider ${provider.id}.trustTier`, provider.adapter === 'generic' ? 'untrusted' : 'reviewed'),
      adapterMaturity: adapterMaturity(provider.adapterMaturity, `provider ${provider.id}.adapterMaturity`, provider.adapter === 'generic' ? 'experimental' : 'stable')
    };
  });
  const providerIds = new Set(normalizedProviders.map((provider) => provider.id));
  const normalizedModels = input.models.map((model) => structuredClone(model));

  for (const model of normalizedModels) {
    if (!providerIds.has(model.provider)) throw new Error(`Model ${model.id} references unknown provider ${model.provider}`);
    assertOptionalBoolean(model.enabled, `model ${model.id}.enabled`);
    if (typeof model.model !== 'string' || model.model.trim() === '') throw new Error(`Model ${model.id} requires model`);
    model.revision = model.revision ?? model.model;
    if (typeof model.revision !== 'string' || model.revision.trim() === '') {
      throw new Error(`Model ${model.id} requires a non-empty revision`);
    }
    assertNonEmptyStrings(model.roles, `model ${model.id}.roles`);
    assertNonEmptyStrings(model.taskKinds, `model ${model.id}.taskKinds`);
    if (model.promptProfileIds !== undefined) {
      assertNonEmptyStrings(model.promptProfileIds, `model ${model.id}.promptProfileIds`);
      if (model.promptProfileIds.length === 0 || new Set(model.promptProfileIds).size !== model.promptProfileIds.length) {
        throw new TypeError(`model ${model.id}.promptProfileIds must be a unique non-empty array`);
      }
    }
    model.promptProfileIds = [...(model.promptProfileIds ?? [])];
    assertArray(model.efforts, `model ${model.id}.efforts`);
    validateQualityMap(model.quality, model.id);
    positiveNumber(model.tokenIndex, `model ${model.id}.tokenIndex`, 1);
    positiveNumber(model.latencyIndex, `model ${model.id}.latencyIndex`, 1);
    if (!['stable', 'challenger'].includes(model.maturity ?? 'stable')) {
      throw new Error(`model ${model.id}.maturity must be stable or challenger`);
    }
    if (model.efforts.length === 0) throw new Error(`Model ${model.id} requires at least one effort`);
    const effortNames = new Set();
    for (const effort of model.efforts) {
      if (!effort || typeof effort !== 'object' || Array.isArray(effort)) {
        throw new TypeError(`model ${model.id} efforts must be objects`);
      }
      if (typeof effort.name !== 'string' || effort.name.trim() === '') {
        throw new TypeError(`model ${model.id} effort requires a non-empty name`);
      }
      if (effortNames.has(effort.name)) throw new Error(`Duplicate effort name for model ${model.id}: ${effort.name}`);
      effortNames.add(effort.name);
      const qualityDelta = effort.qualityDelta ?? 0;
      if (!Number.isFinite(qualityDelta) || qualityDelta < -1 || qualityDelta > 1) {
        throw new RangeError(`model ${model.id} effort ${effort.name}.qualityDelta must be between -1 and 1`);
      }
      positiveNumber(effort.tokenMultiplier, `model ${model.id} effort ${effort.name}.tokenMultiplier`, 1);
      positiveNumber(effort.latencyMultiplier, `model ${model.id} effort ${effort.name}.latencyMultiplier`, 1);
      if (effort.complexities !== undefined) {
        assertNonEmptyStrings(effort.complexities, `model ${model.id} effort ${effort.name}.complexities`);
        if (effort.complexities.length === 0
          || new Set(effort.complexities).size !== effort.complexities.length
          || effort.complexities.some((value) => !TASK_COMPLEXITIES.includes(value))) {
          throw new TypeError(`model ${model.id} effort ${effort.name}.complexities must be unique values from low, standard, high, critical`);
        }
      }
    }
  }

  const normalizedCapabilities = (input.capabilities ?? []).map((capability) => {
    if (!['skill', 'plugin', 'hook'].includes(capability.type)) {
      throw new Error(`Unsupported capability type for ${capability.id}: ${capability.type}`);
    }
    assertOptionalBoolean(capability.enabled, `capability ${capability.id}.enabled`);
    assertNonEmptyStrings(capability.providers ?? ['*'], `capability ${capability.id}.providers`);
    // Do not inject a default trustTier: only an explicit config tier may
    // override discovery-scope trust when the capability is found on disk.
    // Consumers already treat a missing tier as 'reviewed'.
    return {
      ...capability,
      providers: [...(capability.providers ?? ['*'])],
      ...(capability.trustTier === undefined
        ? {}
        : { trustTier: trustTier(capability.trustTier, `capability ${capability.id}.trustTier`) })
    };
  });
  const routing = validateRouting(input.routing ?? {});
  const controlPlane = validateControlPlane(input.controlPlane ?? {});
  const hostPolicy = validateHostPolicy(input.hostPolicy ?? {});
  const lanePolicy = validateLanePolicy(input.lanePolicy ?? {});
  const promptCompilation = validatePromptCompilation(input.promptCompilation ?? {});
  const shadowRouting = validateShadowRouting(input.shadowRouting ?? {});
  const orchestration = { ...(input.orchestration ?? {}), maxTasksPerRun: boundedInteger(input.orchestration?.maxTasksPerRun, 'orchestration.maxTasksPerRun', 24, { minimum: 1, maximum: 100 }) };

  const progressMinutes = input.progress?.intervalMinutes ?? 30;
  if (!Number.isFinite(progressMinutes) || progressMinutes <= 0) {
    throw new Error('progress.intervalMinutes must be positive');
  }
  const execution = {
    ...(input.execution ?? {}),
    workerTimeoutMs: nonNegativeNumber(input.execution?.workerTimeoutMs, 'execution.workerTimeoutMs', 60 * 60 * 1000),
    killGraceMs: nonNegativeNumber(input.execution?.killGraceMs, 'execution.killGraceMs', 1000),
    maxOutputBytes: boundedInteger(input.execution?.maxOutputBytes, 'execution.maxOutputBytes', 10 * 1024 * 1024, { minimum: 1 }),
    maxReceiptBytes: boundedInteger(input.execution?.maxReceiptBytes, 'execution.maxReceiptBytes', 2 * 1024 * 1024, { minimum: 1 })
  };
  const verificationTimeoutMs = input.verification?.commandTimeoutMs ?? 15 * 60 * 1000;
  if (!Number.isFinite(verificationTimeoutMs) || verificationTimeoutMs <= 0) {
    throw new Error('verification.commandTimeoutMs must be positive');
  }
  const verificationTotalTimeoutMs = positiveNumber(input.verification?.totalTimeoutMs, 'verification.totalTimeoutMs', 30 * 60 * 1000);
  const verificationMaxOutputBytes = boundedInteger(input.verification?.maxOutputBytes, 'verification.maxOutputBytes', 8 * 1024 * 1024, { minimum: 1 });
  const verificationMaxChecks = boundedInteger(input.verification?.maxChecks, 'verification.maxChecks', 20, { minimum: 1, maximum: 100 });
  const defaultIsolationByRisk = {
    low: 'same-workspace', standard: 'git-worktree', high: 'git-worktree', critical: 'git-worktree'
  };
  const isolationByRisk = { ...defaultIsolationByRisk, ...(input.verification?.isolationByRisk ?? {}) };
  for (const risk of RISK_TIERS) {
    if (!['same-workspace', 'git-worktree'].includes(isolationByRisk[risk])) {
      throw new Error(`verification.isolationByRisk.${risk} must be same-workspace or git-worktree`);
    }
  }

  return structuredClone({
    ...input,
    providers: normalizedProviders,
    models: normalizedModels,
    capabilities: normalizedCapabilities,
    routing,
    controlPlane,
    hostPolicy,
    lanePolicy,
    promptCompilation,
    shadowRouting,
    orchestration,
    progress: { intervalMinutes: progressMinutes, ...(input.progress ?? {}) },
    execution,
    verification: {
      ...(input.verification ?? {}),
      commandTimeoutMs: verificationTimeoutMs,
      totalTimeoutMs: verificationTotalTimeoutMs,
      maxOutputBytes: verificationMaxOutputBytes,
      maxChecks: verificationMaxChecks,
      isolationByRisk
    },
    paths: { stateDir: '.aorch', ...(input.paths ?? {}) }
  });
}

async function exists(candidate) {
  try { await access(candidate); return true; } catch { return false; }
}

export async function resolveConfigPath({ cwd = process.cwd(), configPath } = {}) {
  if (configPath) return path.resolve(cwd, configPath);
  const projectConfig = path.join(cwd, '.aorch', 'config.json');
  if (await exists(projectConfig)) return projectConfig;
  return DEFAULT_CONFIG_PATH;
}

export async function loadConfig(options = {}) {
  const resolved = await resolveConfigPath(options);
  const raw = await readFile(resolved, 'utf8');
  const config = validateConfig(JSON.parse(raw));
  Object.defineProperty(config, '_configPath', { value: resolved, enumerable: false });
  return config;
}

export function providerById(config, id) {
  const provider = config.providers.find((entry) => entry.id === id && entry.enabled !== false);
  if (!provider) throw new Error(`Enabled provider not found: ${id}`);
  return provider;
}
