// Subscription-local access policy. Pure decision logic only: nothing in this
// module spawns a provider CLI or performs network IO. Callers (doctor, CLI,
// task runner) supply environment snapshots and evidence records.

export const ACCESS_PROFILES = ['subscription-local', 'explicit-api'];
export const OVERFLOW_POLICIES = ['reroute-or-wait', 'block'];
export const USAGE_POOL_STATES = ['unknown', 'green', 'yellow', 'red', 'exhausted'];
export const USAGE_SOURCES = ['provider-output', 'provider-snapshot', 'limit-error', 'user'];
export const USAGE_POOLS = ['openai-agentic', 'anthropic-subscription'];
export const HOST_SURFACES = ['codex-app', 'codex-cli', 'claude-code-cli'];
export const ENFORCEMENT_LEVELS = ['strict', 'advisory', 'unsupported', 'unknown'];

const SUBSCRIPTION_TRANSPORTS = {
  anthropic: ['claude-native-subagent', 'claude-print', 'interactive'],
  openai: ['codex-cli']
};

// Credentials that outrank subscription OAuth in the documented precedence
// order, or that reroute traffic away from the subscription endpoint. Presence
// blocks subscription-local execution outright.
const CONFLICT_ENV = {
  anthropic: [
    { name: 'ANTHROPIC_API_KEY', class: 'api-credential' },
    { name: 'ANTHROPIC_AUTH_TOKEN', class: 'api-credential' },
    { name: 'ANTHROPIC_BASE_URL', class: 'custom-endpoint' },
    { name: 'CLAUDE_CODE_USE_BEDROCK', class: 'cloud-provider' },
    { name: 'CLAUDE_CODE_USE_VERTEX', class: 'cloud-provider' },
    { name: 'CLAUDE_CODE_USE_FOUNDRY', class: 'cloud-provider' }
  ],
  openai: [
    { name: 'OPENAI_API_KEY', class: 'api-credential' },
    { name: 'OPENAI_BASE_URL', class: 'custom-endpoint' },
    { name: 'OPENAI_API_BASE', class: 'custom-endpoint' },
    { name: 'AZURE_OPENAI_API_KEY', class: 'api-credential' },
    { name: 'AZURE_OPENAI_ENDPOINT', class: 'custom-endpoint' }
  ]
};

// Automation credentials are legitimate subscription credentials but differ
// from the interactive login path, so they require an explicit policy choice
// rather than silent acceptance or a silent block.
const AUTOMATION_ENV = {
  anthropic: ['CLAUDE_CODE_OAUTH_TOKEN'],
  openai: []
};

// Variables a local subscription client legitimately needs: process basics,
// locale/terminal, and the documented credential-store location overrides.
const WORKER_ENV_ALLOW = [
  'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP',
  'LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'SHELL', 'USER', 'LOGNAME',
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT',
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME'
];
const WORKER_ENV_ALLOW_PREFIXES = ['LC_'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function knownProvider(provider) {
  const normalized = provider === 'claude' ? 'anthropic' : provider === 'codex' ? 'openai' : provider;
  if (!(normalized in CONFLICT_ENV)) throw new Error(`Unknown subscription provider: ${provider}`);
  return normalized;
}

export function validateAccessProfile(input) {
  const source = input ?? {};
  if (!isObject(source)) throw new TypeError('access must be an object');
  const profile = source.profile ?? 'subscription-local';
  if (!ACCESS_PROFILES.includes(profile)) {
    throw new Error(`access.profile must be one of ${ACCESS_PROFILES.join(', ')}`);
  }
  if (profile === 'explicit-api') {
    throw new Error('access.profile explicit-api is a reserved fail-closed boundary and is not implemented in v0.7.0');
  }
  for (const field of ['allowDirectApi', 'allowApiFallback', 'allowCloudDelegation', 'allowPaidCredits']) {
    const value = source[field] ?? false;
    if (value !== false) {
      throw new Error(`access.${field} must remain false under subscription-local`);
    }
  }
  const localOnly = source.localOnly ?? true;
  if (localOnly !== true) throw new Error('access.localOnly must remain true under subscription-local');
  const overflowPolicy = source.overflowPolicy ?? 'reroute-or-wait';
  if (!OVERFLOW_POLICIES.includes(overflowPolicy)) {
    throw new Error(`access.overflowPolicy must be one of ${OVERFLOW_POLICIES.join(', ')}`);
  }
  return {
    profile,
    localOnly: true,
    allowDirectApi: false,
    allowApiFallback: false,
    allowCloudDelegation: false,
    allowPaidCredits: false,
    overflowPolicy
  };
}

export function inspectSubscriptionEnvironment({ env = {}, provider, settings = {}, policy = {} } = {}) {
  const normalized = knownProvider(provider);
  const conflicts = [];
  for (const entry of CONFLICT_ENV[normalized]) {
    const value = env[entry.name];
    if (typeof value === 'string' && value.trim() !== '') {
      conflicts.push({ name: entry.name, class: entry.class });
    }
  }

  const automation = [];
  for (const name of AUTOMATION_ENV[normalized]) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') {
      automation.push({ name, class: 'automation-credential' });
    }
  }
  if (normalized === 'anthropic' && typeof settings.apiKeyHelper === 'string' && settings.apiKeyHelper.trim() !== '') {
    automation.push({ name: 'apiKeyHelper', class: 'automation-credential' });
  }

  let status = 'pass';
  if (conflicts.length > 0) status = 'blocked';
  else if (automation.length > 0 && policy.allowAutomationCredential !== true) status = 'policy-required';

  return {
    provider: normalized,
    status,
    conflicts,
    automationCredentials: automation,
    warnings: status === 'blocked'
      ? [`${conflicts.map((c) => c.name).join(', ')} would take precedence over subscription OAuth; unset before running subscription workers`]
      : []
  };
}

export function sanitizeSubscriptionWorkerEnv({ env = {}, provider, extraAllow = [] } = {}) {
  const normalized = knownProvider(provider);
  const denied = new Set([
    ...CONFLICT_ENV.anthropic.map((entry) => entry.name),
    ...CONFLICT_ENV.openai.map((entry) => entry.name),
    ...AUTOMATION_ENV.anthropic,
    ...AUTOMATION_ENV.openai
  ]);
  const allowed = new Set([...WORKER_ENV_ALLOW, ...extraAllow.filter((name) => !denied.has(name))]);
  const result = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (denied.has(name)) continue;
    if (allowed.has(name) || WORKER_ENV_ALLOW_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      result[name] = value;
    }
  }
  void normalized;
  return result;
}

export function resolveUsagePool(provider, transport) {
  const normalized = knownProvider(provider);
  const transports = SUBSCRIPTION_TRANSPORTS[normalized];
  if (!transports.includes(transport)) {
    throw new Error(`Transport ${transport} is not a subscription-local transport for provider ${normalized}`);
  }
  return normalized === 'anthropic' ? 'anthropic-subscription' : 'openai-agentic';
}

export function validateUsageRecord({ pool, state, source, at, ageMinutes, ...rest } = {}) {
  if (!USAGE_POOLS.includes(pool)) throw new Error(`Unknown usage pool: ${pool}`);
  if (!USAGE_POOL_STATES.includes(state)) {
    throw new Error(`Usage state must be one of ${USAGE_POOL_STATES.join(', ')}`);
  }
  if (!USAGE_SOURCES.includes(source)) {
    throw new Error(`Usage source must be one of ${USAGE_SOURCES.join(', ')}`);
  }
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    throw new Error('Usage record requires an ISO timestamp in at');
  }
  if ('percentRemaining' in rest || 'percent' in rest) {
    throw new Error('percentRemaining is not recordable: providers do not expose a uniform machine-readable percentage');
  }
  if (source === 'provider-snapshot') {
    if (!Number.isFinite(ageMinutes) || ageMinutes < 0) {
      throw new Error('provider-snapshot usage requires a labeled non-negative ageMinutes');
    }
    if (ageMinutes > 60) {
      throw new Error('provider-snapshot usage older than 60 minutes cannot be recorded as current state');
    }
  }
  return {
    pool,
    state,
    source,
    at,
    ...(ageMinutes === undefined ? {} : { ageMinutes })
  };
}

// Response to an exhausted pool. Candidates must already carry risk/trust/
// entitlement/quality eligibility (meetsQualityFloor); this function only
// applies the subscription-local overflow policy on top.
export function planLimitResponse({ exhaustedPool, candidates = [], pools = {} } = {}) {
  if (!USAGE_POOLS.includes(exhaustedPool)) throw new Error(`Unknown usage pool: ${exhaustedPool}`);
  const rejected = [];
  const eligible = [];
  for (const candidate of candidates) {
    const subscriptionTransport = Object.values(SUBSCRIPTION_TRANSPORTS).some((list) => list.includes(candidate.transport));
    if (!subscriptionTransport || !USAGE_POOLS.includes(candidate.pool)) {
      rejected.push({ ...candidate, reason: 'not a subscription-local transport' });
      continue;
    }
    if (candidate.pool === exhaustedPool) {
      rejected.push({ ...candidate, reason: 'pool exhausted' });
      continue;
    }
    if (pools[candidate.pool] === 'exhausted') {
      rejected.push({ ...candidate, reason: 'pool exhausted' });
      continue;
    }
    if (candidate.meetsQualityFloor !== true) {
      rejected.push({ ...candidate, reason: 'below quality floor' });
      continue;
    }
    eligible.push(candidate);
  }
  if (eligible.length > 0) {
    return { action: 'reroute', candidate: eligible[0], rejected };
  }
  return { action: 'block-or-wait', candidate: null, rejected };
}

export function validateSurfaces(input) {
  const source = input ?? {};
  if (!isObject(source)) throw new TypeError('surfaces must be an object');
  const openai = { ...(source.openai ?? {}) };
  const anthropic = { ...(source.anthropic ?? {}) };

  openai.host = openai.host ?? 'codex-app';
  openai.workerTransport = openai.workerTransport ?? 'codex-cli';
  openai.auth = openai.auth ?? 'chatgpt-oauth';
  anthropic.host = anthropic.host ?? 'claude-code-cli';
  anthropic.sameHostWorkerTransport = anthropic.sameHostWorkerTransport ?? 'claude-native-subagent';
  anthropic.crossHostWorkerTransport = anthropic.crossHostWorkerTransport ?? 'claude-print';
  anthropic.auth = anthropic.auth ?? 'subscription-oauth';

  if (!['codex-app', 'codex-cli'].includes(openai.host)) {
    throw new Error('surfaces.openai.host must be codex-app or codex-cli');
  }
  if (!SUBSCRIPTION_TRANSPORTS.openai.includes(openai.workerTransport)) {
    throw new Error(`surfaces.openai.workerTransport must be a subscription-local transport (${SUBSCRIPTION_TRANSPORTS.openai.join(', ')})`);
  }
  if (anthropic.host !== 'claude-code-cli') {
    throw new Error('surfaces.anthropic.host must be claude-code-cli');
  }
  for (const [field, value] of [
    ['sameHostWorkerTransport', anthropic.sameHostWorkerTransport],
    ['crossHostWorkerTransport', anthropic.crossHostWorkerTransport]
  ]) {
    if (!SUBSCRIPTION_TRANSPORTS.anthropic.includes(value)) {
      throw new Error(`surfaces.anthropic.${field} must be a subscription-local transport (${SUBSCRIPTION_TRANSPORTS.anthropic.join(', ')})`);
    }
  }

  openai.usagePool = resolveUsagePool('openai', openai.workerTransport);
  anthropic.usagePool = resolveUsagePool('anthropic', anthropic.crossHostWorkerTransport);
  return { openai, anthropic };
}

// Enforcement level for a host surface, derived only from supplied evidence.
// Strict is never inferred: it requires either an authenticated fixture that
// proved write-capable tool interception (codex-app / codex-cli) or an
// installed hook policy (claude-code-cli, whose PreToolUse coverage of
// Edit/Write is officially documented).
export function inspectHostSurface({ surface, evidence = [] } = {}) {
  if (!HOST_SURFACES.includes(surface)) throw new Error(`Unknown host surface: ${surface}`);
  const kinds = new Set(evidence.map((entry) => entry?.kind));

  let status = 'unknown';
  if (surface === 'claude-code-cli') {
    status = kinds.has('installed-hook-policy') ? 'strict' : 'advisory';
  } else if (kinds.has('authenticated-fixture')) {
    status = 'strict';
  } else if (kinds.has('official-unsupported')) {
    status = 'unsupported';
  } else if (kinds.has('official-doc') || kinds.has('installed-hook-policy')) {
    status = 'advisory';
  }

  return { surface, status, evidence: [...evidence] };
}
