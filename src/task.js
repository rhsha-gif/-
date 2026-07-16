const RISKS = new Set(['low', 'standard', 'high', 'critical']);
const COMPLEXITIES = new Set(['low', 'standard', 'high', 'critical']);
const DEFAULT_COMPLEXITY_BY_RISK = Object.freeze({ low: 'low', standard: 'standard', high: 'high', critical: 'high' });
const ROUTE_METRICS = new Set(['quality', 'tokens', 'latency']);
const VERIFICATION_ISOLATIONS = new Set(['same-workspace', 'git-worktree']);

function requireString(task, field) {
  if (typeof task[field] !== 'string' || task[field].trim() === '') throw new TypeError(`task.${field} is required`);
}


function optionalNumber(value, field, { minimum = -Infinity, maximum = Infinity, exclusiveMinimum = false } = {}) {
  if (value === undefined) return undefined;
  const number = Number(value);
  const below = exclusiveMinimum ? number <= minimum : number < minimum;
  if (!Number.isFinite(number) || below || number > maximum) {
    const lower = exclusiveMinimum ? `greater than ${minimum}` : `at least ${minimum}`;
    throw new RangeError(`task.${field} must be ${lower} and at most ${maximum}`);
  }
  return number;
}

function routingPriorities(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 3
    || value.some((entry) => !ROUTE_METRICS.has(entry))
    || new Set(value).size !== value.length) {
    throw new TypeError('task.routingPriorities must be a unique non-empty array of quality, tokens, and latency');
  }
  return value;
}

function ensureStringArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new TypeError(`task.${field} must be an array of non-empty strings`);
  }
  return value;
}

export function validateTask(input, { forExecution = false } = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('task must be an object');
  const task = structuredClone(input);
  for (const field of ['id', 'kind', 'role']) requireString(task, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(task.id)) {
    throw new Error('task.id must be a path-safe identifier');
  }
  if (task.runId !== undefined && (typeof task.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(task.runId))) {
    throw new Error('task.runId must be a path-safe identifier');
  }
  if (!RISKS.has(task.risk)) throw new Error(`Unsupported task risk: ${task.risk}`);
  const explicitComplexity = task.complexity !== undefined;
  task.complexity = task.complexity ?? DEFAULT_COMPLEXITY_BY_RISK[task.risk];
  if (!COMPLEXITIES.has(task.complexity)) throw new Error(`Unsupported task complexity: ${task.complexity}`);
  if (task.risk === 'critical' && explicitComplexity && !['high', 'critical'].includes(task.complexity)) {
    throw new Error('Critical task complexity must be high or critical');
  }

  task.tags = ensureStringArray(task.tags, 'tags');
  task.capabilityIds = ensureStringArray(task.capabilityIds, 'capabilityIds');
  task.allowedScope = ensureStringArray(task.allowedScope, 'allowedScope');
  task.forbiddenScope = ensureStringArray(task.forbiddenScope, 'forbiddenScope');
  task.acceptanceCriteria = ensureStringArray(task.acceptanceCriteria, 'acceptanceCriteria');
  task.verificationCommands = ensureStringArray(task.verificationCommands, 'verificationCommands');
  task.verifierCommands = ensureStringArray(task.verifierCommands, 'verifierCommands');
  if (task.verificationIsolation !== undefined && !VERIFICATION_ISOLATIONS.has(task.verificationIsolation)) {
    throw new Error('task.verificationIsolation must be same-workspace or git-worktree');
  }
  task.allowedProviders = ensureStringArray(task.allowedProviders, 'allowedProviders');
  task.forbiddenProviders = ensureStringArray(task.forbiddenProviders, 'forbiddenProviders');
  task.forbiddenProfileIds = ensureStringArray(task.forbiddenProfileIds, 'forbiddenProfileIds');
  if (task.write !== undefined && typeof task.write !== 'boolean') {
    throw new TypeError('task.write must be boolean');
  }
  if (task.allowUntrustedCapabilities !== undefined && typeof task.allowUntrustedCapabilities !== 'boolean') {
    throw new TypeError('task.allowUntrustedCapabilities must be boolean');
  }
  task.allowUntrustedCapabilities = task.allowUntrustedCapabilities === true;
  if (task.allowUntrustedProviders !== undefined && typeof task.allowUntrustedProviders !== 'boolean') {
    throw new TypeError('task.allowUntrustedProviders must be boolean');
  }
  task.allowUntrustedProviders = task.allowUntrustedProviders === true;
  if (task.allowInPlaceWrite !== undefined && typeof task.allowInPlaceWrite !== 'boolean') {
    throw new TypeError('task.allowInPlaceWrite must be boolean');
  }
  task.allowInPlaceWrite = task.allowInPlaceWrite === true;
  task.routingPriorities = routingPriorities(task.routingPriorities);
  task.minimumQuality = optionalNumber(task.minimumQuality, 'minimumQuality', { minimum: 0, maximum: 1 });
  task.maxTokenIndex = optionalNumber(task.maxTokenIndex, 'maxTokenIndex', { minimum: 0, exclusiveMinimum: true });
  task.maxLatencyIndex = optionalNumber(task.maxLatencyIndex, 'maxLatencyIndex', { minimum: 0, exclusiveMinimum: true });
  if (task.routingPriorities?.[0] !== 'quality' && task.routingPriorities && task.minimumQuality === undefined) {
    throw new Error('task.minimumQuality is required when routingPriorities does not start with quality');
  }

  if (forExecution) {
    requireString(task, 'objective');
    if (task.acceptanceCriteria.length === 0) throw new Error('Execution task requires acceptance criteria');
    if (task.write === true && task.allowedScope.length === 0) throw new Error('Write task requires an explicit allowed scope');
    if (task.risk === 'critical' && task.verificationCommands.length === 0) {
      throw new Error('Critical task requires explicit verification commands');
    }
  }
  return task;
}
