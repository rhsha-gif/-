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
  return {
    ...input,
    providerTrustByRisk: validateTrustMap(input.providerTrustByRisk, 'controlPlane.providerTrustByRisk', defaultProviders),
    capabilityTrustByRisk: validateTrustMap(input.capabilityTrustByRisk, 'controlPlane.capabilityTrustByRisk', defaultCapabilities),
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

  return {
    ...input,
    ...tolerances,
    observationHalfLifeDays,
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
        if (new Set(effort.complexities).size !== effort.complexities.length
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
    assertNonEmptyStrings(capability.providers ?? ['*'], `capability ${capability.id}.providers`);
    return {
      ...capability,
      providers: [...(capability.providers ?? ['*'])],
      trustTier: trustTier(capability.trustTier, `capability ${capability.id}.trustTier`, 'reviewed')
    };
  });
  const routing = validateRouting(input.routing ?? {});
  const controlPlane = validateControlPlane(input.controlPlane ?? {});

  const progressMinutes = input.progress?.intervalMinutes ?? 30;
  if (!Number.isFinite(progressMinutes) || progressMinutes <= 0) {
    throw new Error('progress.intervalMinutes must be positive');
  }
  const verificationTimeoutMs = input.verification?.commandTimeoutMs ?? 15 * 60 * 1000;
  if (!Number.isFinite(verificationTimeoutMs) || verificationTimeoutMs <= 0) {
    throw new Error('verification.commandTimeoutMs must be positive');
  }
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
    progress: { intervalMinutes: progressMinutes, ...(input.progress ?? {}) },
    verification: { ...(input.verification ?? {}), commandTimeoutMs: verificationTimeoutMs, isolationByRisk },
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
