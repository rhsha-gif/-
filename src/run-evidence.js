import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from './fs-util.js';

export const RUN_EVIDENCE_VERSION = 1;
export const WORK_ROOT_REGISTRY_VERSION = 1;
export const CONTROLLER_ATTESTATION_VERSION = 2;
const LEGACY_CONTROLLER_ATTESTATION_VERSION = 1;

const EXECUTION_STATUSES = new Set(['complete', 'partial', 'blocked', 'awaiting-input', 'failed']);
const FAILURE_KINDS = new Set(['authentication', 'rate-limit', 'network', 'timeout', 'protocol', 'execution', 'action-required']);
const ARTIFACT_STATUSES = new Set(['pass', 'fail', 'unscored']);
const EVALUATION_STATUSES = new Set(['pass', 'minor', 'major', 'fail', 'unavailable', 'error']);
const RISK_LEVELS = new Set(['low', 'standard', 'high', 'critical']);
const COMPLEXITY_LEVELS = new Set(['low', 'standard', 'high', 'critical']);

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertExactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${name}.${key} is not allowed`);
  }
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value, name) {
  return value === undefined ? undefined : requiredString(value, name);
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function optionalMetric(value, name) {
  return value === undefined ? undefined : nonNegativeInteger(value, name);
}

function normalizeDate(value, name) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${name} must be a valid date`);
  return date.toISOString();
}

function normalizeRoute(route) {
  assertObject(route, 'evidence.route');
  assertExactKeys(route, ['provider', 'adapter', 'model', 'effort', 'profileId'], 'evidence.route');
  return {
    provider: requiredString(route.provider, 'evidence.route.provider'),
    adapter: requiredString(route.adapter, 'evidence.route.adapter'),
    model: requiredString(route.model, 'evidence.route.model'),
    effort: requiredString(route.effort, 'evidence.route.effort'),
    ...(route.profileId === undefined ? {} : { profileId: optionalString(route.profileId, 'evidence.route.profileId') })
  };
}

function normalizeTask(task) {
  assertObject(task, 'evidence.task');
  assertExactKeys(task, ['kind', 'role', 'risk', 'complexity', 'explicitModelPin'], 'evidence.task');
  const risk = requiredString(task.risk, 'evidence.task.risk');
  const complexity = requiredString(task.complexity, 'evidence.task.complexity');
  if (!RISK_LEVELS.has(risk)) throw new TypeError('evidence.task.risk is unsupported');
  if (!COMPLEXITY_LEVELS.has(complexity)) throw new TypeError('evidence.task.complexity is unsupported');
  if (task.explicitModelPin !== undefined && typeof task.explicitModelPin !== 'boolean') {
    throw new TypeError('evidence.task.explicitModelPin must be a boolean');
  }
  return {
    kind: requiredString(task.kind, 'evidence.task.kind'),
    ...(task.role === undefined ? {} : { role: optionalString(task.role, 'evidence.task.role') }),
    risk,
    complexity,
    ...(task.explicitModelPin === undefined ? {} : { explicitModelPin: task.explicitModelPin })
  };
}

function normalizeExecution(execution) {
  assertObject(execution, 'evidence.execution');
  assertExactKeys(execution, [
    'status', 'completed', 'failureKind', 'durationMs', 'reworkDurationMs',
    'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens',
    'cacheCreationTokens', 'totalTokens'
  ], 'evidence.execution');
  const status = requiredString(execution.status, 'evidence.execution.status');
  if (!EXECUTION_STATUSES.has(status)) throw new TypeError('evidence.execution.status is unsupported');
  if (typeof execution.completed !== 'boolean') {
    throw new TypeError('evidence.execution.completed must be a boolean');
  }
  if (execution.completed !== (status === 'complete')) {
    throw new TypeError('evidence.execution.completed must agree with status complete');
  }
  if (status === 'failed') {
    if (!FAILURE_KINDS.has(execution.failureKind)) {
      throw new TypeError('evidence.execution.failureKind is required for failed execution');
    }
  } else if (execution.failureKind !== undefined) {
    throw new TypeError('evidence.execution.failureKind is only allowed for failed execution');
  }
  return {
    status,
    completed: execution.completed,
    ...(execution.failureKind === undefined ? {} : { failureKind: execution.failureKind }),
    ...Object.fromEntries([
      ['durationMs', optionalMetric(execution.durationMs, 'evidence.execution.durationMs')],
      ['reworkDurationMs', optionalMetric(execution.reworkDurationMs, 'evidence.execution.reworkDurationMs')],
      ['inputTokens', optionalMetric(execution.inputTokens, 'evidence.execution.inputTokens')],
      ['outputTokens', optionalMetric(execution.outputTokens, 'evidence.execution.outputTokens')],
      ['reasoningTokens', optionalMetric(execution.reasoningTokens, 'evidence.execution.reasoningTokens')],
      ['cacheReadTokens', optionalMetric(execution.cacheReadTokens, 'evidence.execution.cacheReadTokens')],
      ['cacheCreationTokens', optionalMetric(execution.cacheCreationTokens, 'evidence.execution.cacheCreationTokens')],
      ['totalTokens', optionalMetric(execution.totalTokens, 'evidence.execution.totalTokens')]
    ].filter(([, value]) => value !== undefined))
  };
}

function normalizeArtifact(artifact) {
  assertObject(artifact, 'evidence.artifact');
  assertExactKeys(artifact, ['status'], 'evidence.artifact');
  const status = requiredString(artifact.status, 'evidence.artifact.status');
  if (!ARTIFACT_STATUSES.has(status)) throw new TypeError('evidence.artifact.status is unsupported');
  return { status };
}

function normalizeEvaluation(evaluation) {
  assertObject(evaluation, 'evidence.evaluation');
  assertExactKeys(evaluation, ['source', 'status', 'quality', 'synthetic', 'target'], 'evidence.evaluation');
  if (evaluation.source !== 'independent-gate') {
    throw new TypeError('evidence.evaluation.source must be independent-gate');
  }
  const status = requiredString(evaluation.status, 'evidence.evaluation.status');
  if (!EVALUATION_STATUSES.has(status)) throw new TypeError('evidence.evaluation.status is unsupported');
  if (evaluation.quality !== undefined
    && (!Number.isFinite(evaluation.quality) || evaluation.quality < 0 || evaluation.quality > 1)) {
    throw new RangeError('evidence.evaluation.quality must be between 0 and 1');
  }
  if (evaluation.synthetic !== undefined && typeof evaluation.synthetic !== 'boolean') {
    throw new TypeError('evidence.evaluation.synthetic must be a boolean');
  }
  if (evaluation.target !== undefined && !['task-output', 'reviewer-output'].includes(evaluation.target)) {
    throw new TypeError('evidence.evaluation.target must be task-output or reviewer-output');
  }
  if (['unavailable', 'error'].includes(status) && evaluation.quality !== undefined) {
    throw new TypeError(`evidence.evaluation.${status} cannot carry quality`);
  }
  return {
    source: 'independent-gate',
    status,
    ...(evaluation.quality === undefined ? {} : { quality: evaluation.quality }),
    ...(evaluation.synthetic === undefined ? {} : { synthetic: evaluation.synthetic }),
    ...(evaluation.target === undefined ? {} : { target: evaluation.target })
  };
}

export function normalizeRunEvidence(input) {
  assertObject(input, 'evidence');
  assertExactKeys(input, [
    'schemaVersion', 'projectId', 'taskId', 'runId', 'attempt', 'recordedAt',
    'route', 'task', 'execution', 'artifact', 'evaluation'
  ], 'evidence');
  if (input.schemaVersion !== RUN_EVIDENCE_VERSION) {
    throw new Error(`Unsupported run evidence schemaVersion: ${input.schemaVersion}`);
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new TypeError('evidence.attempt must be a positive integer');
  }
  return {
    schemaVersion: RUN_EVIDENCE_VERSION,
    projectId: requiredString(input.projectId, 'evidence.projectId'),
    taskId: requiredString(input.taskId, 'evidence.taskId'),
    runId: requiredString(input.runId, 'evidence.runId'),
    attempt: input.attempt,
    recordedAt: normalizeDate(input.recordedAt, 'evidence.recordedAt'),
    route: normalizeRoute(input.route),
    task: normalizeTask(input.task),
    execution: normalizeExecution(input.execution),
    artifact: normalizeArtifact(input.artifact),
    ...(input.evaluation === undefined ? {} : { evaluation: normalizeEvaluation(input.evaluation) })
  };
}

export function runEvidenceIdentity(evidence) {
  const value = normalizeRunEvidence(evidence);
  return `${value.projectId}\0${value.runId}\0${value.taskId}\0${value.attempt}`;
}

export function evidenceDigest(evidence) {
  return createHash('sha256').update(JSON.stringify(normalizeRunEvidence(evidence))).digest('hex');
}

export function learningDirectory({ homeDir = os.homedir() } = {}) {
  return path.join(path.resolve(homeDir), '.aorch', 'learning');
}

export function workRootRegistryPath(options = {}) {
  return path.join(learningDirectory(options), 'work-roots.json');
}

function safeProjectDirectory(projectId) {
  return /^[A-Za-z0-9._-]{1,128}$/.test(projectId)
    ? projectId
    : createHash('sha256').update(projectId).digest('hex');
}

export function controllerEvidencePath(evidence, { homeDir = os.homedir() } = {}) {
  const normalized = normalizeRunEvidence(evidence);
  const identityHash = createHash('sha256').update(runEvidenceIdentity(normalized)).digest('hex');
  return path.join(
    learningDirectory({ homeDir }),
    'controller-evidence',
    safeProjectDirectory(normalized.projectId),
    `${identityHash}.json`
  );
}

function normalizeLegacyControllerAttestation(input) {
  assertObject(input, 'controller attestation');
  assertExactKeys(input, ['schemaVersion', 'identityHash', 'evidenceDigest', 'attestedAt'], 'controller attestation');
  if (input.schemaVersion !== LEGACY_CONTROLLER_ATTESTATION_VERSION) {
    throw new Error(`Unsupported controller attestation schemaVersion: ${input.schemaVersion}`);
  }
  for (const field of ['identityHash', 'evidenceDigest']) {
    if (typeof input[field] !== 'string' || !/^[a-f0-9]{64}$/.test(input[field])) {
      throw new TypeError(`controller attestation.${field} must be a SHA-256 digest`);
    }
  }
  return {
    schemaVersion: LEGACY_CONTROLLER_ATTESTATION_VERSION,
    identityHash: input.identityHash,
    evidenceDigest: input.evidenceDigest,
    attestedAt: normalizeDate(input.attestedAt, 'controller attestation.attestedAt')
  };
}

function normalizeControllerAttestation(input) {
  assertObject(input, 'controller attestation');
  if (input.schemaVersion === LEGACY_CONTROLLER_ATTESTATION_VERSION) {
    return normalizeLegacyControllerAttestation(input);
  }
  assertExactKeys(input, ['schemaVersion', 'identityHash', 'evidenceDigest', 'attestedAt', 'evidence'], 'controller attestation');
  if (input.schemaVersion !== CONTROLLER_ATTESTATION_VERSION) {
    throw new Error(`Unsupported controller attestation schemaVersion: ${input.schemaVersion}`);
  }
  for (const field of ['identityHash', 'evidenceDigest']) {
    if (typeof input[field] !== 'string' || !/^[a-f0-9]{64}$/.test(input[field])) {
      throw new TypeError(`controller attestation.${field} must be a SHA-256 digest`);
    }
  }
  const evidence = normalizeRunEvidence(input.evidence);
  const identityHash = createHash('sha256').update(runEvidenceIdentity(evidence)).digest('hex');
  const digest = evidenceDigest(evidence);
  if (input.identityHash !== identityHash || input.evidenceDigest !== digest) {
    throw new Error('controller attestation digests do not match its normalized evidence');
  }
  return {
    schemaVersion: CONTROLLER_ATTESTATION_VERSION,
    identityHash: input.identityHash,
    evidenceDigest: input.evidenceDigest,
    attestedAt: normalizeDate(input.attestedAt, 'controller attestation.attestedAt'),
    evidence
  };
}

export async function readControllerAttestation(evidence, { homeDir = os.homedir() } = {}) {
  const normalized = normalizeRunEvidence(evidence);
  const filePath = controllerEvidencePath(normalized, { homeDir });
  let raw;
  try { raw = await readFile(filePath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { filePath, available: false, matches: false, attestation: null };
    throw error;
  }
  let attestation;
  try { attestation = normalizeControllerAttestation(JSON.parse(raw)); }
  catch (error) { throw new Error(`Invalid controller attestation ${filePath}: ${error.message}`, { cause: error }); }
  if (attestation.schemaVersion === LEGACY_CONTROLLER_ATTESTATION_VERSION) {
    return { filePath, available: true, matches: false, attestation };
  }
  const identityHash = createHash('sha256').update(runEvidenceIdentity(normalized)).digest('hex');
  const matches = attestation.identityHash === identityHash
    && attestation.evidenceDigest === evidenceDigest(normalized);
  return { filePath, available: true, matches, attestation };
}

export async function readControllerEvidence({ homeDir = os.homedir() } = {}) {
  const root = path.join(learningDirectory({ homeDir }), 'controller-evidence');
  let projects;
  try { projects = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return { root, available: false, records: [], legacyRecords: [] };
    throw error;
  }
  const records = [];
  const legacyRecords = [];
  const identities = new Set();
  for (const project of projects.filter((entry) => entry.isDirectory()).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const projectRoot = path.join(root, project.name);
    const files = (await readdir(projectRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const file of files) {
      const filePath = path.join(projectRoot, file.name);
      let record;
      try { record = normalizeControllerAttestation(JSON.parse(await readFile(filePath, 'utf8'))); }
      catch (error) { throw new Error(`Invalid controller attestation ${filePath}: ${error.message}`, { cause: error }); }
      if (record.schemaVersion === LEGACY_CONTROLLER_ATTESTATION_VERSION) {
        if (file.name !== `${record.identityHash}.json`) {
          throw new Error(`Controller attestation path does not match its identity: ${filePath}`);
        }
        legacyRecords.push({ filePath, ...record });
        continue;
      }
      if (project.name !== safeProjectDirectory(record.evidence.projectId)
        || file.name !== `${record.identityHash}.json`) {
        throw new Error(`Controller attestation path does not match its evidence: ${filePath}`);
      }
      const identity = runEvidenceIdentity(record.evidence);
      if (identities.has(identity)) throw new Error(`Duplicate controller evidence identity: ${identity}`);
      identities.add(identity);
      records.push({ filePath, ...record });
    }
  }
  return { root, available: true, records, legacyRecords };
}

function normalizeStateRoot(root, stateRoot = '.aorch') {
  requiredString(stateRoot, 'stateRoot');
  return path.isAbsolute(stateRoot) ? path.resolve(stateRoot) : path.resolve(root, stateRoot);
}

function normalizeRegistry(input) {
  assertObject(input, 'work root registry');
  assertExactKeys(input, ['schemaVersion', 'roots'], 'work root registry');
  if (input.schemaVersion !== WORK_ROOT_REGISTRY_VERSION || !Array.isArray(input.roots)) {
    throw new Error('Invalid work root registry schema');
  }
  const seen = new Set();
  const roots = input.roots.map((entry, index) => {
    assertObject(entry, `work root registry.roots[${index}]`);
    assertExactKeys(entry, ['root', 'stateRoot', 'registeredAt'], `work root registry.roots[${index}]`);
    const root = path.resolve(requiredString(entry.root, `work root registry.roots[${index}].root`));
    const key = root.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate registered work root: ${root}`);
    seen.add(key);
    return {
      root,
      stateRoot: normalizeStateRoot(root, entry.stateRoot),
      registeredAt: normalizeDate(entry.registeredAt, `work root registry.roots[${index}].registeredAt`)
    };
  });
  roots.sort((a, b) => a.root < b.root ? -1 : a.root > b.root ? 1 : 0);
  return { schemaVersion: WORK_ROOT_REGISTRY_VERSION, roots };
}

export async function readRegisteredWorkRoots(options = {}) {
  const filePath = workRootRegistryPath(options);
  let raw;
  try { raw = await readFile(filePath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  try { return normalizeRegistry(JSON.parse(raw)).roots; }
  catch (error) { throw new Error(`Invalid work root registry ${filePath}: ${error.message}`, { cause: error }); }
}

export async function registerWorkRoot(root, { homeDir, stateRoot = '.aorch', now = new Date() } = {}) {
  const resolvedRoot = path.resolve(requiredString(root, 'root'));
  const resolvedStateRoot = normalizeStateRoot(resolvedRoot, stateRoot);
  const roots = await readRegisteredWorkRoots({ homeDir });
  const existing = roots.find((entry) => entry.root.toLowerCase() === resolvedRoot.toLowerCase());
  const next = existing
    ? roots.map((entry) => entry === existing ? { ...entry, stateRoot: resolvedStateRoot } : entry)
    : [...roots, { root: resolvedRoot, stateRoot: resolvedStateRoot, registeredAt: normalizeDate(now, 'now') }];
  const registry = normalizeRegistry({ schemaVersion: WORK_ROOT_REGISTRY_VERSION, roots: next });
  await writeJsonAtomic(workRootRegistryPath({ homeDir }), registry);
  return registry.roots.find((entry) => entry.root.toLowerCase() === resolvedRoot.toLowerCase());
}

export function runEvidencePath(root, { stateRoot = '.aorch' } = {}) {
  const resolvedRoot = path.resolve(requiredString(root, 'root'));
  return path.join(normalizeStateRoot(resolvedRoot, stateRoot), 'run-evidence.jsonl');
}

async function readJsonLines(filePath) {
  let raw;
  try { raw = await readFile(filePath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { available: false, records: [] };
    throw error;
  }
  const records = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch (error) { throw new Error(`Invalid JSONL ${filePath} at line ${index + 1}: ${error.message}`, { cause: error }); }
  }
  return { available: true, records };
}

export async function readRunEvidence({ root, stateRoot = '.aorch' }) {
  const filePath = runEvidencePath(root, { stateRoot });
  const source = await readJsonLines(filePath);
  const records = source.records.map((entry, index) => {
    try { return normalizeRunEvidence(entry); }
    catch (error) { throw new Error(`Invalid run evidence ${filePath} at record ${index + 1}: ${error.message}`, { cause: error }); }
  });
  return { filePath, available: source.available, records };
}

export async function recordRunEvidence({
  root,
  stateRoot = '.aorch',
  evidence,
  now = new Date(),
  homeDir = os.homedir(),
  attest = false
}) {
  if (typeof attest !== 'boolean') throw new TypeError('attest must be a boolean');
  const normalized = normalizeRunEvidence({
    ...evidence,
    recordedAt: evidence?.recordedAt ?? normalizeDate(now, 'now')
  });
  const filePath = runEvidencePath(root, { stateRoot });
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, 'a', 0o600);
  try { await handle.writeFile(`${JSON.stringify(normalized)}\n`, 'utf8'); }
  finally { await handle.close(); }
  if (attest) {
    const attestationPath = controllerEvidencePath(normalized, { homeDir });
    const identityHash = createHash('sha256').update(runEvidenceIdentity(normalized)).digest('hex');
    const attestation = normalizeControllerAttestation({
      schemaVersion: CONTROLLER_ATTESTATION_VERSION,
      identityHash,
      evidenceDigest: evidenceDigest(normalized),
      attestedAt: normalizeDate(now, 'now'),
      evidence: normalized
    });
    let existing;
    try { existing = JSON.parse(await readFile(attestationPath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Invalid controller attestation ${attestationPath}: ${error.message}`, { cause: error });
    }
    if (existing !== undefined) {
      const previous = normalizeControllerAttestation(existing);
      if (previous.identityHash !== attestation.identityHash || previous.evidenceDigest !== attestation.evidenceDigest) {
        throw new Error(`Controller attestation identity collision: ${attestationPath}`);
      }
      if (previous.schemaVersion === LEGACY_CONTROLLER_ATTESTATION_VERSION) {
        await writeJsonAtomic(attestationPath, attestation);
      }
    } else {
      await writeJsonAtomic(attestationPath, attestation);
    }
  }
  return normalized;
}
