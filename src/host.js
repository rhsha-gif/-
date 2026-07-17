const SELECTION_MODES = new Set(['preferred', 'pinned', 'bootstrap-only']);
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'auto']);
const SOURCES = new Set(['explicit', 'environment', 'config', 'unknown']);

function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`host.${field} must be a non-empty string`);
  return value.trim();
}

function optionalEffort(value, field) {
  const normalized = optionalString(value, field);
  if (normalized !== null && !EFFORTS.has(normalized)) {
    throw new Error(`host.${field} must be a supported effort level`);
  }
  return normalized;
}

export function normalizeHostContext(input = {}, env = process.env, defaults = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('host context must be an object');
  const selectionMode = input.selectionMode ?? defaults.selectionMode ?? 'preferred';
  if (!SELECTION_MODES.has(selectionMode)) throw new Error('host.selectionMode must be preferred, pinned, or bootstrap-only');

  const provider = optionalString(input.provider ?? defaults.provider, 'provider');
  const requestedModel = optionalString(input.requestedModel ?? defaults.requestedModel, 'requestedModel');
  const resolvedModel = optionalString(input.resolvedModel ?? defaults.resolvedModel, 'resolvedModel');
  const requestedEffort = optionalEffort(input.requestedEffort ?? defaults.requestedEffort, 'requestedEffort');
  const envEffort = provider === 'anthropic' ? optionalEffort(env.CLAUDE_CODE_EFFORT_LEVEL, 'effectiveEffort') : null;
  const effectiveEffort = optionalEffort(input.effectiveEffort ?? envEffort ?? defaults.effectiveEffort ?? requestedEffort, 'effectiveEffort');
  const subagentModelOverride = provider === 'anthropic'
    ? optionalString(env.CLAUDE_CODE_SUBAGENT_MODEL ?? input.subagentModelOverride, 'subagentModelOverride')
    : optionalString(input.subagentModelOverride, 'subagentModelOverride');

  let source = input.source ?? defaults.source;
  if (source === undefined) {
    if (envEffort || subagentModelOverride) source = 'environment';
    else if (provider || requestedModel || resolvedModel || requestedEffort) source = 'explicit';
    else source = 'unknown';
  }
  if (!SOURCES.has(source)) throw new Error('host.source must be explicit, environment, config, or unknown');
  const executionMode = input.executionMode ?? defaults.executionMode ?? 'bootstrap-only';
  if (executionMode !== 'bootstrap-only') throw new Error('host.executionMode must remain bootstrap-only');
  const allowHostProductEdits = input.allowHostProductEdits ?? defaults.allowHostProductEdits ?? false;
  if (allowHostProductEdits !== false) throw new Error('host.allowHostProductEdits must remain false');

  return {
    provider,
    requestedModel,
    resolvedModel,
    requestedEffort,
    effectiveEffort,
    selectionMode,
    executionMode,
    allowHostProductEdits: false,
    source,
    subagentModelOverride,
    identityKnown: Boolean(provider && (resolvedModel || requestedModel))
  };
}

export function hostMatchesRoute(host, route) {
  if (!host?.provider || !route?.provider || host.provider !== route.provider) return false;
  const hostModels = new Set([host.requestedModel, host.resolvedModel].filter(Boolean));
  return hostModels.size > 0 && hostModels.has(route.model);
}

export { EFFORTS as HOST_EFFORTS, SELECTION_MODES as HOST_SELECTION_MODES };
