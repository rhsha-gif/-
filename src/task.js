const RISKS = new Set(['low', 'standard', 'high', 'critical']);
const COMPLEXITIES = new Set(['low', 'standard', 'high', 'critical']);
const DEFAULT_COMPLEXITY_BY_RISK = Object.freeze({ low: 'low', standard: 'standard', high: 'high', critical: 'high' });
const ROUTE_METRICS = new Set(['quality', 'tokens', 'latency']);
const VERIFICATION_ISOLATIONS = new Set(['same-workspace', 'git-worktree']);
const EXECUTION_LANES = new Set(['single-worker', 'bundled', 'orchestrated']);
const SIGNATURE_ENUMS = Object.freeze({
  ambiguity: new Set(['low', 'medium', 'high']),
  repositoryBreadth: new Set(['local', 'module', 'wide']),
  editBreadth: new Set(['none', 'one-file', 'few-files', 'many-files']),
  contextVolume: new Set(['small', 'medium', 'large']),
  toolIntensity: new Set(['low', 'medium', 'high']),
  stateComplexity: new Set(['none', 'simple', 'complex']),
  testCoverage: new Set(['good', 'partial', 'poor', 'unknown']),
  externalIntegration: new Set(['none', 'read-only', 'mutating'])
});

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

function exactProjectFiles(value, field) {
  const entries = ensureStringArray(value, field);
  const normalized = entries.map((entry) => {
    const raw = entry.trim().replaceAll('\\', '/');
    if (!raw || raw.includes('\0') || raw.endsWith('/') || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)
      || /[*?[]/.test(raw)) {
      throw new Error(`task.${field} must contain exact project-relative files`);
    }
    const withoutPrefix = raw.replace(/^\.\//, '');
    const parts = withoutPrefix.split('/');
    if (parts.length === 0 || parts.some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`task.${field} must contain exact project-relative files`);
    }
    return parts.join('/');
  });
  if (new Set(normalized).size !== normalized.length) throw new Error(`task.${field} must not contain duplicates`);
  return normalized;
}

function validateSignature(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('task.signature must be an object');
  const result = {};
  for (const [field, allowed] of Object.entries(SIGNATURE_ENUMS)) {
    if (value[field] === undefined) continue;
    if (!allowed.has(value[field])) throw new Error(`task.signature.${field} is invalid`);
    result[field] = value[field];
  }
  for (const field of ['language', 'framework']) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== 'string' || value[field].trim() === '') throw new TypeError(`task.signature.${field} must be a non-empty string`);
    result[field] = value[field].trim();
  }
  const known = new Set([...Object.keys(SIGNATURE_ENUMS), 'language', 'framework']);
  const unknown = Object.keys(value).filter((field) => !known.has(field));
  if (unknown.length) throw new Error(`task.signature contains unsupported fields: ${unknown.join(', ')}`);
  return result;
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
  task.verifierPrepareCommands = ensureStringArray(task.verifierPrepareCommands, 'verifierPrepareCommands');
  task.verifierProtectedScope = ensureStringArray(task.verifierProtectedScope, 'verifierProtectedScope')
    .map((entry) => entry.trim().replaceAll('\\', '/').replace(/^\.\//, ''));
  if (task.verifierProtectedScope.some((entry) => entry === '' || entry.startsWith('/') || entry.includes('\0'))) {
    throw new Error('task.verifierProtectedScope must contain project-relative patterns');
  }
  if (task.allowChangeEvidenceOnly !== undefined && typeof task.allowChangeEvidenceOnly !== 'boolean') {
    throw new TypeError('task.allowChangeEvidenceOnly must be boolean');
  }
  task.allowChangeEvidenceOnly = task.allowChangeEvidenceOnly === true;
  if (task.allowChangeEvidenceOnly && task.risk !== 'low') {
    throw new Error('task.allowChangeEvidenceOnly is limited to low-risk tasks');
  }
  task.requirements = ensureStringArray(task.requirements, 'requirements');
  task.invariants = ensureStringArray(task.invariants, 'invariants');
  task.failureModes = ensureStringArray(task.failureModes, 'failureModes');
  task.contextFiles = ensureStringArray(task.contextFiles, 'contextFiles');
  task.evidenceFiles = exactProjectFiles(task.evidenceFiles, 'evidenceFiles');
  if (task.context !== undefined && (typeof task.context !== 'string' || task.context.trim() === '')) {
    throw new TypeError('task.context must be a non-empty string');
  }
  if (typeof task.context === 'string') task.context = task.context.trim();
  task.escalationSignals = ensureStringArray(task.escalationSignals, 'escalationSignals');
  task.signature = validateSignature(task.signature);
  if (task.executionLane !== undefined && !EXECUTION_LANES.has(task.executionLane)) {
    if (task.executionLane === 'direct') {
      throw new Error('task.executionLane direct was removed; use single-worker so the bootstrap host delegates to one bounded worker');
    }
    throw new Error('task.executionLane must be single-worker, bundled, or orchestrated');
  }
  if (task.laneReason !== undefined && (typeof task.laneReason !== 'string' || task.laneReason.trim() === '')) {
    throw new TypeError('task.laneReason must be a non-empty string');
  }
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
  if (task.controlPlaneChange !== undefined && typeof task.controlPlaneChange !== 'boolean') {
    throw new TypeError('task.controlPlaneChange must be boolean');
  }
  task.controlPlaneChange = task.controlPlaneChange === true;
  if (task.approval !== undefined) {
    if (!task.approval || typeof task.approval !== 'object' || Array.isArray(task.approval)) {
      throw new TypeError('task.approval must be an object');
    }
    for (const field of ['runId', 'proposalId']) {
      if (typeof task.approval[field] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(task.approval[field])) {
        throw new Error(`task.approval.${field} must be a path-safe identifier`);
      }
    }
    task.approval = { runId: task.approval.runId, proposalId: task.approval.proposalId };
  }
  if (task.controlPlaneChange) {
    if (task.write !== true || task.risk !== 'critical' || task.verificationIsolation !== 'git-worktree') {
      throw new Error('Control-plane changes require write=true, risk=critical, and verificationIsolation=git-worktree');
    }
    if (!task.approval) throw new Error('Control-plane changes require an approved proposal reference');
    if (task.verifierCommands.length === 0) throw new Error('Control-plane changes require a hidden verifier command');
  } else if (task.approval !== undefined) {
    throw new Error('task.approval is only valid when task.controlPlaneChange is true');
  }
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
    const executableChecks = task.verificationCommands.length + task.verifierCommands.length;
    if (task.write === true && executableChecks === 0 && !task.allowChangeEvidenceOnly) {
      throw new Error('Write task requires at least one executable check; low-risk evidence-only work must set allowChangeEvidenceOnly');
    }
  }
  return task;
}

// Fields the worker must never see: hidden verification plans, protected
// scope, and approval references. Everything else in the task envelope is
// public worker input.
const PRIVATE_TASK_FIELDS = ['verifierCommands', 'verifierPrepareCommands', 'verifierProtectedScope', 'approval'];

export function publicWorkerEnvelope(task) {
  const envelope = structuredClone(task);
  for (const field of PRIVATE_TASK_FIELDS) delete envelope[field];
  return envelope;
}
