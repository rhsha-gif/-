import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE_METRICS = ['quality', 'tokens', 'latency'];
const TASK_COMPLEXITIES = ['low', 'standard', 'high', 'critical'];
const RISK_TIERS = ['low', 'standard', 'high', 'critical'];
const ADAPTER_MATURITIES = ['stable', 'experimental'];
const QUOTA_GATES = ['premium', 'soft'];
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

function positiveNumber(value, name, fallback) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new RangeError(`${name} must be positive`);
  return resolved;
}

function nonNegativeNumber(value, name, fallback) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) throw new RangeError(`${name} must be finite and non-negative`);
  return resolved;
}



function adapterMaturity(value, name, fallback) {
  const resolved = value ?? fallback;
  if (!ADAPTER_MATURITIES.includes(resolved)) {
    throw new Error(`${name} must be one of ${ADAPTER_MATURITIES.join(', ')}`);
  }
  return resolved;
}

// Which role agent each agentRole spawns, keyed by adapter rather than by
// provider id: the presets live in integrations/<adapter>/agents/, so the agent
// belongs to the CLI that runs it, not to the subscription account behind it.
// Absent means "the shipped presets", so an existing .aorch/config.json written
// before this block existed keeps loading. Present means it is checked strictly:
// a half-declared block is a mistake, not a partial override. Dispatch still
// fails closed when it needs a pair this map does not carry.
const AGENT_ROLE_KEYS = [
  'worker', 'reviewer', 'fixer', 'researcher', 'analyst', 'license-reviewer', 'ponytail',
  'writer', 'editor', 'qa-analyst', 'invest-analyst', 'refactorer', 'paper-researcher'
];
const preset = (name) => Object.freeze({ claude: name, codex: name });
const DEFAULT_ROLE_AGENTS = Object.freeze({
  worker: preset('aorch-worker'),
  reviewer: preset('aorch-reviewer'),
  fixer: preset('aorch-fixer'),
  researcher: preset('aorch-researcher'),
  analyst: preset('aorch-analyst'),
  'license-reviewer': preset('aorch-license-reviewer'),
  ponytail: preset('aorch-ponytail'),
  writer: preset('aorch-writer'),
  editor: preset('aorch-editor'),
  'qa-analyst': preset('aorch-qa-analyst'),
  'invest-analyst': preset('aorch-invest-analyst'),
  refactorer: preset('aorch-refactorer'),
  'paper-researcher': preset('aorch-paper-researcher')
});

function validateRoleAgents(input, providers) {
  if (input === undefined) return structuredClone(DEFAULT_ROLE_AGENTS);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('config.roleAgents must be an object');
  }
  const adapters = [...new Set(providers.map((provider) => provider.adapter))];
  const result = {};
  for (const key of AGENT_ROLE_KEYS) {
    const entry = input[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`config.roleAgents.${key} must be an object keyed by adapter`);
    }
    for (const adapter of adapters) {
      if (typeof entry[adapter] !== 'string' || entry[adapter].trim() === '') {
        throw new TypeError(`config.roleAgents.${key}.${adapter} must be a non-empty agent name`);
      }
    }
    result[key] = { ...entry };
  }
  for (const key of Object.keys(input)) {
    if (!AGENT_ROLE_KEYS.includes(key)) {
      throw new Error(`Unsupported config.roleAgents key: ${key}`);
    }
  }
  return result;
}

function validateControlPlane(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('controlPlane must be an object');
  }
  const experimentalAdapterMaxRisk = input.experimentalAdapterMaxRisk ?? 'standard';
  if (!RISK_TIERS.includes(experimentalAdapterMaxRisk)) {
    throw new Error('controlPlane.experimentalAdapterMaxRisk must be low, standard, high, or critical');
  }
  return {
    ...input,
    experimentalAdapterMaxRisk
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

  const quota = validateRoutingQuota(input.quota);

  return {
    ...input,
    ...tolerances,
    observationHalfLifeDays,
    priorWeight,
    uncertaintyPenalty,
    criticalMinimumSamples,
    quota,
    defaultPriorities: [...defaultPriorities],
    selectionPolicy: input.selectionPolicy ?? 'task-specific-priority-order'
  };
}

// Thresholds for the quota routing signal. Always normalized (defaults apply
// even when the block is absent) so the router and the cache layer never need
// their own fallbacks to agree on.
function validateRoutingQuota(input) {
  if (input === undefined) {
    return { softThresholdPercent: 40, hardThresholdPercent: 10, premiumThresholdPercent: 60, cacheTtlMinutes: 5 };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('routing.quota must be an object');
  }
  const softThresholdPercent = input.softThresholdPercent ?? 40;
  const hardThresholdPercent = input.hardThresholdPercent ?? 10;
  for (const [field, value] of Object.entries({ softThresholdPercent, hardThresholdPercent })) {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new RangeError(`routing.quota.${field} must be a number between 0 and 100`);
    }
  }
  if (hardThresholdPercent > softThresholdPercent) {
    throw new RangeError('routing.quota.hardThresholdPercent must not exceed softThresholdPercent');
  }
  // The default tracks a raised soft threshold so an implicit premium floor
  // can never sit below the explicit soft one.
  const premiumThresholdPercent = input.premiumThresholdPercent ?? Math.max(60, softThresholdPercent);
  if (!Number.isFinite(premiumThresholdPercent) || premiumThresholdPercent < 0 || premiumThresholdPercent > 100) {
    throw new RangeError('routing.quota.premiumThresholdPercent must be a number between 0 and 100');
  }
  if (premiumThresholdPercent < softThresholdPercent) {
    throw new RangeError('routing.quota.premiumThresholdPercent must not be below softThresholdPercent');
  }
  const cacheTtlMinutes = nonNegativeNumber(input.cacheTtlMinutes, 'routing.quota.cacheTtlMinutes', 5);
  return { ...input, softThresholdPercent, hardThresholdPercent, premiumThresholdPercent, cacheTtlMinutes };
}

// Ladders are same-provider by design: cross-provider fallback is a separate
// mechanism (route reselection under forbiddenProviders), while a ladder only
// climbs quality tiers inside the provider that already owns the task.
function validateEscalation(input = {}, providers, models) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('escalation must be an object');
  }
  const maxAttempts = input.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('escalation.maxAttempts must be a positive integer');
  }
  const ladders = input.ladders ?? {};
  if (!ladders || typeof ladders !== 'object' || Array.isArray(ladders)) {
    throw new TypeError('escalation.ladders must be an object');
  }
  const providerIds = new Set(providers.map((provider) => provider.id));
  const modelById = new Map(models.map((model) => [model.id, model]));
  for (const [providerId, steps] of Object.entries(ladders)) {
    if (!providerIds.has(providerId)) {
      throw new Error(`escalation.ladders references unknown provider ${providerId}`);
    }
    assertArray(steps, `escalation.ladders.${providerId}`);
    for (const step of steps) {
      const profile = modelById.get(step?.profileId);
      if (!profile) {
        throw new Error(`escalation.ladders.${providerId} references unknown profile ${step?.profileId}`);
      }
      if (profile.provider !== providerId) {
        throw new Error(`escalation.ladders.${providerId} step ${step.profileId} belongs to provider ${profile.provider}`);
      }
      if (!(profile.efforts ?? []).some((effort) => effort.name === step.effort)) {
        throw new Error(`escalation.ladders.${providerId} step ${step.profileId} references unknown effort ${step.effort}`);
      }
    }
  }
  return { ...input, maxAttempts, ladders };
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
    if (provider.adapter === 'generic' && (!provider.executable || !Array.isArray(provider.args))) {
      throw new Error(`Generic provider ${provider.id} requires executable and args`);
    }
    if (provider.usageProbe !== undefined) {
      const p = provider.usageProbe;
      if (typeof p !== 'object' || p === null || Array.isArray(p)) {
        throw new TypeError(`provider ${provider.id}.usageProbe must be an object`);
      }
      if (typeof p.command !== 'string' || p.command.trim() === '') {
        throw new TypeError(`provider ${provider.id}.usageProbe.command must be a non-empty string`);
      }
      if (!Array.isArray(p.args) || p.args.some((arg) => typeof arg !== 'string')) {
        throw new TypeError(`provider ${provider.id}.usageProbe.args must be an array of strings`);
      }
      if (typeof p.remainingField !== 'string' || p.remainingField.trim() === '') {
        throw new TypeError(`provider ${provider.id}.usageProbe.remainingField must be a non-empty string`);
      }
    }
    return {
      ...provider,
      adapterMaturity: adapterMaturity(provider.adapterMaturity, `provider ${provider.id}.adapterMaturity`, provider.adapter === 'generic' ? 'experimental' : 'stable')
    };
  });
  const providerIds = new Set(normalizedProviders.map((provider) => provider.id));
  const normalizedModels = input.models.map((model) => structuredClone(model));

  for (const model of normalizedModels) {
    if (!providerIds.has(model.provider)) throw new Error(`Model ${model.id} references unknown provider ${model.provider}`);
    if (typeof model.model !== 'string' || model.model.trim() === '') throw new Error(`Model ${model.id} requires model`);
    assertNonEmptyStrings(model.roles, `model ${model.id}.roles`);
    assertNonEmptyStrings(model.taskKinds, `model ${model.id}.taskKinds`);
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
      if (effort.taskKinds !== undefined) {
        assertNonEmptyStrings(effort.taskKinds, `model ${model.id} effort ${effort.name}.taskKinds`);
        if (effort.taskKinds.length === 0 || new Set(effort.taskKinds).size !== effort.taskKinds.length) {
          throw new TypeError(`model ${model.id} effort ${effort.name}.taskKinds must be unique non-empty strings`);
        }
      }
      if (effort.quotaGate !== undefined && !QUOTA_GATES.includes(effort.quotaGate)) {
        throw new Error(`model ${model.id} effort ${effort.name}.quotaGate must be one of ${QUOTA_GATES.join(', ')}`);
      }
    }
  }

  const normalizedCapabilities = (input.capabilities ?? []).map((capability) => {
    if (!['skill', 'plugin', 'hook'].includes(capability.type)) {
      throw new Error(`Unsupported capability type for ${capability.id}: ${capability.type}`);
    }
    assertNonEmptyStrings(capability.providers ?? ['*'], `capability ${capability.id}.providers`);
    return {
      ...capability,
      providers: [...(capability.providers ?? ['*'])]
    };
  });
  const routing = validateRouting(input.routing ?? {});
  const roleAgents = validateRoleAgents(input.roleAgents, normalizedProviders);
  const controlPlane = validateControlPlane(input.controlPlane ?? {});
  const escalation = validateEscalation(input.escalation ?? {}, normalizedProviders, normalizedModels);

  const verificationTimeoutMs = input.verification?.commandTimeoutMs ?? 15 * 60 * 1000;
  if (!Number.isFinite(verificationTimeoutMs) || verificationTimeoutMs <= 0) {
    throw new Error('verification.commandTimeoutMs must be positive');
  }

  if (input.branch !== undefined) {
    const b = input.branch;
    if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new TypeError('config.branch must be an object');
    if (b.mainBranch !== undefined && (typeof b.mainBranch !== 'string' || b.mainBranch.trim() === '')) {
      throw new TypeError('config.branch.mainBranch must be a non-empty string');
    }
    if (b.staleDays !== undefined && (!Number.isFinite(b.staleDays) || b.staleDays < 0)) {
      throw new RangeError('config.branch.staleDays must be a non-negative number');
    }
    if (b.integration !== undefined && !['auto', 'pr', 'direct'].includes(b.integration)) {
      throw new Error("config.branch.integration must be 'auto', 'pr', or 'direct'");
    }
    if (b.verificationCommands !== undefined) assertNonEmptyStrings(b.verificationCommands, 'config.branch.verificationCommands');
  }

  return structuredClone({
    ...input,
    providers: normalizedProviders,
    models: normalizedModels,
    capabilities: normalizedCapabilities,
    routing,
    roleAgents,
    controlPlane,
    escalation,
    verification: { ...(input.verification ?? {}), commandTimeoutMs: verificationTimeoutMs },
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
