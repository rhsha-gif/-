import { access, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from './fs-util.js';
import { estimateRouteQuality, normalizeObservation } from './performance-store.js';
import {
  learningDirectory,
  evidenceDigest,
  readControllerEvidence,
  readRegisteredWorkRoots,
  readRunEvidence,
  runEvidenceIdentity,
  workRootRegistryPath
} from './run-evidence.js';

export const WEEKLY_POLICY_VERSION = 1;
export const MIN_WEEKLY_ROUTE_SAMPLES = 5;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const VERDICT_QUALITY = Object.freeze({ pass: 1, minor: 0.85, major: 0.55, fail: 0.2 });

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
}

function assertExactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${name}.${key} is not allowed`);
  }
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function validDate(value, name) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${name} must be a valid date`);
  return date.toISOString();
}

function resolveHome(homeDir) {
  return path.resolve(homeDir ?? os.homedir());
}

function observationPath(entry) {
  return path.join(entry.stateRoot, 'observations.jsonl');
}

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function parseJson(filePath, description) {
  let raw;
  try { raw = await readFile(filePath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { available: false, value: null };
    throw error;
  }
  try { return { available: true, value: JSON.parse(raw) }; }
  catch (error) { throw new Error(`Invalid ${description} ${filePath}: ${error.message}`, { cause: error }); }
}

async function parseJsonl(filePath, description) {
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
    catch (error) {
      throw new Error(`Invalid ${description} ${filePath} at line ${index + 1}: ${error.message}`, { cause: error });
    }
  }
  return { available: true, records };
}

function normalizeRoot(input) {
  const item = typeof input === 'string' ? { root: input } : input;
  assertObject(item, 'root');
  assertExactKeys(item, ['root', 'stateRoot', 'source'], 'root');
  const root = path.resolve(requiredString(item.root, 'root.root'));
  const stateRoot = item.stateRoot === undefined
    ? path.join(root, '.aorch')
    : (path.isAbsolute(item.stateRoot) ? path.resolve(item.stateRoot) : path.resolve(root, item.stateRoot));
  return { root, stateRoot, source: item.source ?? 'explicit' };
}

function mergeRoots(entries) {
  const byRoot = new Map();
  for (const entry of entries) {
    const normalized = normalizeRoot(entry);
    const key = normalized.root.toLowerCase();
    const previous = byRoot.get(key);
    if (!previous || previous.source === 'install') byRoot.set(key, normalized);
  }
  return [...byRoot.values()].sort((a, b) => compareText(a.root, b.root));
}

async function readInstallRoots(homeDir) {
  const filePath = path.join(resolveHome(homeDir), '.aorch', 'installs.json');
  const parsed = await parseJson(filePath, 'install registry');
  if (!parsed.available) return { filePath, available: false, roots: [] };
  assertObject(parsed.value, 'install registry');
  assertExactKeys(parsed.value, ['version', 'projects'], 'install registry');
  if (parsed.value.version !== 1) throw new Error(`Invalid install registry ${filePath}: unsupported version ${parsed.value.version}`);
  if (!parsed.value.projects || typeof parsed.value.projects !== 'object' || Array.isArray(parsed.value.projects)) {
    throw new Error(`Invalid install registry ${filePath}: projects must be an object`);
  }
  return {
    filePath,
    available: true,
    roots: Object.keys(parsed.value.projects).map((root) => ({ root, source: 'install' }))
  };
}

async function discoverRoots({ roots = [], homeDir }) {
  if (!Array.isArray(roots)) throw new TypeError('roots must be an array');
  const [registered, installs] = await Promise.all([
    readRegisteredWorkRoots({ homeDir }),
    readInstallRoots(homeDir)
  ]);
  const workRegistryPath = workRootRegistryPath({ homeDir });
  return {
    roots: mergeRoots([
      ...installs.roots,
      ...registered.map((entry) => ({ root: entry.root, stateRoot: entry.stateRoot, source: 'work-root' })),
      ...roots
    ]),
    registries: {
      installs: { path: installs.filePath, available: installs.available, count: installs.roots.length },
      workRoots: {
        path: workRegistryPath,
        available: await exists(workRegistryPath),
        count: registered.length
      }
    }
  };
}

function legacyObservationIdentity(observation) {
  const metadata = observation.metadata ?? {};
  if (metadata.projectId && metadata.runId && metadata.taskId && metadata.attempt) {
    return [metadata.projectId, metadata.runId, metadata.taskId, metadata.attempt].join('\0');
  }
  return [
    'legacy-verify-gate', metadata.projectId ?? '', metadata.runId ?? '', metadata.taskId ?? '', metadata.attempt ?? '',
    observation.provider, observation.model, observation.effort, observation.taskKind
  ].join('\0');
}

function routeKey(observation) {
  return [observation.provider, observation.model, observation.effort, observation.taskKind].join('\0');
}

function fromLegacyObservation(raw, filePath, index) {
  let observation;
  try { observation = normalizeObservation(raw); }
  catch (error) { throw new Error(`Invalid observation ${filePath} at record ${index + 1}: ${error.message}`, { cause: error }); }
  return {
    identity: legacyObservationIdentity(observation),
    observation,
    eligible: false,
    ineligibleReason: 'legacy-unattested'
  };
}

function fromRunEvidence(evidence, controller) {
  const evaluation = evidence.evaluation;
  let ineligibleReason = null;
  if (!controller?.available) ineligibleReason = 'no-controller-attestation';
  else if (!controller.matches) ineligibleReason = 'controller-attestation-mismatch';
  else if (!evaluation) ineligibleReason = 'no-independent-evaluation';
  else if (evaluation.synthetic === true) ineligibleReason = 'synthetic-evaluation';
  else if (['unavailable', 'error'].includes(evaluation.status)) ineligibleReason = 'evaluation-unavailable';
  else if (!['complete'].includes(evidence.execution.status)) ineligibleReason = 'execution-not-complete';
  else if (!['low', 'standard'].includes(evidence.task.risk)
    || !['low', 'standard'].includes(evidence.task.complexity)) ineligibleReason = 'protected-risk-or-complexity';
  else if (evidence.task.explicitModelPin === true) ineligibleReason = 'explicit-model-pin';

  const quality = evaluation?.quality ?? VERDICT_QUALITY[evaluation?.status];
  if (ineligibleReason === null && !Number.isFinite(quality)) ineligibleReason = 'evaluation-unscored';
  if (ineligibleReason === null
    && quality < 1
    && (evidence.task.role === 'reviewer' || evidence.task.kind === 'review')
    && evaluation.target !== 'reviewer-output') {
    ineligibleReason = 'reviewer-detected-subject-defect';
  }
  const observation = quality === undefined ? null : normalizeObservation({
    provider: evidence.route.provider,
    model: evidence.route.model,
    effort: evidence.route.effort,
    taskKind: evidence.task.kind,
    ...(evidence.route.profileId === undefined ? {} : { profileId: evidence.route.profileId }),
    quality,
    recordedAt: evidence.recordedAt,
    reviewed: true,
    metadata: {
      source: 'independent-gate',
      projectId: evidence.projectId,
      runId: evidence.runId,
      taskId: evidence.taskId,
      attempt: evidence.attempt,
      risk: evidence.task.risk,
      complexity: evidence.task.complexity,
      explicitModelPin: evidence.task.explicitModelPin === true,
      controllerAttested: controller?.matches === true,
      ...(controller?.attestation?.evidenceDigest === undefined
        ? {}
        : { controllerDigest: controller.attestation.evidenceDigest })
    }
  });
  return {
    identity: runEvidenceIdentity(evidence),
    observation,
    eligible: ineligibleReason === null,
    ineligibleReason
  };
}

async function readRootEvidence(entry) {
  const rootAvailable = await exists(entry.root);
  if (!rootAvailable) {
    return {
      root: entry.root, stateRoot: entry.stateRoot, source: entry.source, available: false,
      sources: { runEvidence: false, observations: false, taskRuns: false },
      runs: [], observations: [], taskArtifacts: []
    };
  }
  const runSource = await readRunEvidence({ root: entry.root, stateRoot: entry.stateRoot });
  const observationsFile = observationPath(entry);
  const legacySource = await parseJsonl(observationsFile, 'observation log');
  const observations = legacySource.records.map((raw, index) => fromLegacyObservation(raw, observationsFile, index));
  const taskRuns = await readTaskArtifacts(entry.stateRoot);
  return {
    root: entry.root,
    stateRoot: entry.stateRoot,
    source: entry.source,
    available: true,
    sources: {
      runEvidence: runSource.available,
      observations: legacySource.available,
      taskRuns: taskRuns.available
    },
    runs: runSource.records,
    observations,
    taskArtifacts: taskRuns.records
  };
}

async function readTaskArtifacts(stateRoot) {
  const taskRoot = path.join(stateRoot, 'task-runs');
  let runDirectories;
  try { runDirectories = await readdir(taskRoot, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return { available: false, records: [] };
    throw error;
  }
  const records = [];
  for (const runEntry of runDirectories.filter((entry) => entry.isDirectory()).sort((a, b) => compareText(a.name, b.name))) {
    const runPath = path.join(taskRoot, runEntry.name);
    const taskEntries = (await readdir(runPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => compareText(a.name, b.name));
    for (const taskEntry of taskEntries) {
      const taskPath = path.join(runPath, taskEntry.name);
      const [receipt, verification] = await Promise.all([
        parseJson(path.join(taskPath, 'receipt.json'), 'task receipt'),
        parseJson(path.join(taskPath, 'verification.json'), 'verification evidence')
      ]);
      if (!receipt.available && !verification.available) continue;
      const attempt = Number.isSafeInteger(verification.value?.attempt) ? verification.value.attempt : 1;
      const hasIndependentGate = Array.isArray(verification.value?.results) && verification.value.results.length > 0;
      records.push({
        identity: `${runEntry.name}\0${taskEntry.name}\0${attempt}`,
        runId: runEntry.name,
        taskId: taskEntry.name,
        attempt,
        executionComplete: receipt.value?.status === 'complete',
        artifactStatus: hasIndependentGate
          ? (verification.value?.passed === true ? 'pass' : verification.value?.passed === false ? 'fail' : 'unscored')
          : 'unscored'
      });
    }
  }
  return { available: true, records };
}

function addMetric(metrics, value, key) {
  if (value !== undefined) {
    metrics[key] += value;
    metrics.observedCounts[key] += 1;
  }
}

function summarizeRuns(runs, taskArtifacts) {
  const metrics = {
    attempts: runs.length,
    executionComplete: 0,
    executionIncomplete: 0,
    artifactPass: 0,
    artifactFail: 0,
    artifactUnscored: 0,
    durationMs: 0,
    reworkDurationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0
  };
  metrics.observedCounts = Object.fromEntries([
    'durationMs', 'reworkDurationMs', 'inputTokens', 'outputTokens',
    'reasoningTokens', 'cacheReadTokens', 'cacheCreationTokens', 'totalTokens'
  ].map((key) => [key, 0]));
  for (const run of runs) {
    metrics[run.execution.completed ? 'executionComplete' : 'executionIncomplete'] += 1;
    metrics[`artifact${run.artifact.status[0].toUpperCase()}${run.artifact.status.slice(1)}`] += 1;
    addMetric(metrics, run.execution.durationMs, 'durationMs');
    addMetric(metrics, run.execution.reworkDurationMs, 'reworkDurationMs');
    addMetric(metrics, run.execution.inputTokens, 'inputTokens');
    addMetric(metrics, run.execution.outputTokens, 'outputTokens');
    addMetric(metrics, run.execution.reasoningTokens, 'reasoningTokens');
    addMetric(metrics, run.execution.cacheReadTokens, 'cacheReadTokens');
    addMetric(metrics, run.execution.cacheCreationTokens, 'cacheCreationTokens');
    addMetric(metrics, run.execution.totalTokens, 'totalTokens');
  }
  // Historic task receipts remain operational evidence and never become
  // quality data. Callers remove artifacts already represented by a new run.
  metrics.attempts += taskArtifacts.length;
  for (const artifact of taskArtifacts) {
    metrics[artifact.executionComplete ? 'executionComplete' : 'executionIncomplete'] += 1;
    metrics[`artifact${artifact.artifactStatus[0].toUpperCase()}${artifact.artifactStatus.slice(1)}`] += 1;
  }
  return metrics;
}

function findPrior(config, observations) {
  const first = observations[0];
  const profileIds = new Set(observations.map((item) => item.profileId).filter(Boolean));
  const candidates = (config.models ?? []).filter((model) => (
    model.provider === first.provider
    && model.model === first.model
    && (profileIds.size === 0 || profileIds.has(model.id))
    && (model.efforts ?? []).some((effort) => effort.name === first.effort)
  ));
  if (candidates.length !== 1) return null;
  const profile = candidates[0];
  const effort = profile.efforts.find((entry) => entry.name === first.effort);
  const priorQuality = Math.min(1, Math.max(0,
    (profile.quality?.[first.taskKind] ?? profile.quality?.default ?? 0.5) + (effort.qualityDelta ?? 0)
  ));
  return { profileId: profile.id, priorQuality };
}

function policyVersion(now) {
  return validDate(now, 'now').replace(/[-:.]/g, '');
}

function publicObservation(observation) {
  const metadata = observation.metadata ?? {};
  return {
    provider: observation.provider,
    model: observation.model,
    effort: observation.effort,
    taskKind: observation.taskKind,
    ...(observation.profileId === undefined ? {} : { profileId: observation.profileId }),
    quality: observation.quality,
    recordedAt: observation.recordedAt,
    reviewed: true,
    metadata: {
      source: metadata.source,
      ...(metadata.projectId === undefined ? {} : { projectId: metadata.projectId }),
      ...(metadata.runId === undefined ? {} : { runId: metadata.runId }),
      ...(metadata.taskId === undefined ? {} : { taskId: metadata.taskId }),
      ...(metadata.attempt === undefined ? {} : { attempt: metadata.attempt }),
      risk: metadata.risk,
      complexity: metadata.complexity,
      explicitModelPin: metadata.explicitModelPin === true,
      controllerAttested: metadata.controllerAttested === true,
      ...(metadata.controllerDigest === undefined ? {} : { controllerDigest: metadata.controllerDigest })
    }
  };
}

function buildPolicy({ eligible, now, config, minimumSamples }) {
  const groups = new Map();
  for (const item of eligible) {
    const key = routeKey(item.observation);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item.observation);
  }
  const cutoffMs = new Date(now).getTime() - WEEK_MS;
  const routeGroups = [];
  for (const observations of groups.values()) {
    observations.sort((a, b) => compareText(a.recordedAt, b.recordedAt));
    const weeklySamples = observations.filter((entry) => new Date(entry.recordedAt).getTime() >= cutoffMs).length;
    if (observations.length < minimumSamples) continue;
    const prior = findPrior(config, observations);
    if (!prior) continue;
    const first = observations[0];
    const estimate = estimateRouteQuality({
      route: first,
      task: { kind: first.taskKind },
      priorQuality: prior.priorQuality,
      observations,
      now,
      halfLifeDays: 30,
      priorWeight: 3,
      uncertaintyPenalty: config.routing?.uncertaintyPenalty ?? 0.02
    });
    routeGroups.push({
      provider: first.provider,
      profileId: prior.profileId,
      model: first.model,
      effort: first.effort,
      taskKind: first.taskKind,
      priorQuality: prior.priorQuality,
      weeklySamples,
      estimate,
      observations: observations.map(publicObservation)
    });
  }
  routeGroups.sort((a, b) => compareText(routeKey(a), routeKey(b)));
  return {
    schemaVersion: WEEKLY_POLICY_VERSION,
    version: policyVersion(now),
    createdAt: validDate(now, 'now'),
    parameters: { windowDays: 7, halfLifeDays: 30, priorWeight: 3, minimumSamples },
    routeGroups
  };
}

function validateObservationPolicyEntry(input, name) {
  assertObject(input, name);
  assertExactKeys(input, ['provider', 'model', 'effort', 'taskKind', 'profileId', 'quality', 'recordedAt', 'reviewed', 'metadata'], name);
  assertObject(input.metadata, `${name}.metadata`);
  assertExactKeys(input.metadata, [
    'source', 'projectId', 'runId', 'taskId', 'attempt', 'risk', 'complexity', 'explicitModelPin',
    'controllerAttested', 'controllerDigest'
  ], `${name}.metadata`);
  if (!['verify-gate', 'independent-gate'].includes(input.metadata.source)
    || !['low', 'standard'].includes(input.metadata.risk)
    || !['low', 'standard'].includes(input.metadata.complexity)
    || typeof input.metadata.explicitModelPin !== 'boolean'
    || input.metadata.controllerAttested !== true
    || typeof input.metadata.controllerDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(input.metadata.controllerDigest)) {
    throw new TypeError(`${name}.metadata must describe approved ordinary-risk evidence`);
  }
  return normalizeObservation(input);
}

export function validateWeeklyPolicy(input) {
  assertObject(input, 'weekly policy');
  assertExactKeys(input, ['schemaVersion', 'version', 'createdAt', 'parameters', 'routeGroups'], 'weekly policy');
  if (input.schemaVersion !== WEEKLY_POLICY_VERSION) throw new Error(`Unsupported weekly policy schemaVersion: ${input.schemaVersion}`);
  const version = requiredString(input.version, 'weekly policy.version');
  if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new TypeError('weekly policy.version contains unsupported characters');
  const createdAt = validDate(input.createdAt, 'weekly policy.createdAt');
  assertObject(input.parameters, 'weekly policy.parameters');
  assertExactKeys(input.parameters, ['windowDays', 'halfLifeDays', 'priorWeight', 'minimumSamples'], 'weekly policy.parameters');
  const expected = { windowDays: 7, halfLifeDays: 30, priorWeight: 3 };
  for (const [key, value] of Object.entries(expected)) {
    if (input.parameters[key] !== value) throw new TypeError(`weekly policy.parameters.${key} must be ${value}`);
  }
  if (!Number.isSafeInteger(input.parameters.minimumSamples)
    || input.parameters.minimumSamples < MIN_WEEKLY_ROUTE_SAMPLES) {
    throw new TypeError(`weekly policy.parameters.minimumSamples must be an integer of at least ${MIN_WEEKLY_ROUTE_SAMPLES}`);
  }
  if (!Array.isArray(input.routeGroups)) throw new TypeError('weekly policy.routeGroups must be an array');
  const routeGroups = input.routeGroups.map((group, index) => {
    const name = `weekly policy.routeGroups[${index}]`;
    assertObject(group, name);
    assertExactKeys(group, [
      'provider', 'profileId', 'model', 'effort', 'taskKind', 'priorQuality',
      'weeklySamples', 'estimate', 'observations'
    ], name);
    for (const key of ['provider', 'profileId', 'model', 'effort', 'taskKind']) requiredString(group[key], `${name}.${key}`);
    if (!Number.isFinite(group.priorQuality) || group.priorQuality < 0 || group.priorQuality > 1) {
      throw new TypeError(`${name}.priorQuality must be between 0 and 1`);
    }
    if (!Number.isSafeInteger(group.weeklySamples) || group.weeklySamples < 0) throw new TypeError(`${name}.weeklySamples must be non-negative`);
    assertObject(group.estimate, `${name}.estimate`);
    assertExactKeys(group.estimate, [
      'mean', 'conservative', 'uncertainty', 'effectiveSamples', 'rawSamples', 'priorQuality', 'priorWeight'
    ], `${name}.estimate`);
    for (const key of ['mean', 'conservative', 'uncertainty', 'effectiveSamples', 'rawSamples', 'priorQuality', 'priorWeight']) {
      if (!Number.isFinite(group.estimate[key])) throw new TypeError(`${name}.estimate.${key} must be finite`);
    }
    if (!Array.isArray(group.observations) || group.observations.length < input.parameters.minimumSamples) {
      throw new TypeError(`${name}.observations must contain at least ${input.parameters.minimumSamples} records`);
    }
    const observations = group.observations.map((entry, itemIndex) => validateObservationPolicyEntry(entry, `${name}.observations[${itemIndex}]`));
    if (observations.some((entry) => routeKey(entry) !== routeKey(group))) {
      throw new TypeError(`${name}.observations must match their route group`);
    }
    return { ...group, observations };
  });
  const keys = routeGroups.map(routeKey);
  if (new Set(keys).size !== keys.length) throw new Error('weekly policy contains duplicate route groups');
  return {
    schemaVersion: WEEKLY_POLICY_VERSION,
    version,
    createdAt,
    parameters: { ...expected, minimumSamples: input.parameters.minimumSamples },
    routeGroups
  };
}

function trustedControllerState(record) {
  return {
    available: true,
    matches: true,
    attestation: record
  };
}

async function verifyPolicyAgainstController(policy, homeDir) {
  if (policy.routeGroups.length === 0) return policy;
  const source = await readControllerEvidence({ homeDir: resolveHome(homeDir) });
  const byDigest = new Map(source.records.map((record) => [record.evidenceDigest, record]));
  for (const group of policy.routeGroups) {
    for (const observation of group.observations) {
      const record = byDigest.get(observation.metadata.controllerDigest);
      if (!record) throw new Error(`controller evidence is missing for policy observation ${observation.metadata.controllerDigest}`);
      const candidate = fromRunEvidence(record.evidence, trustedControllerState(record));
      if (!candidate.eligible || !candidate.observation) {
        throw new Error(`controller evidence is not eligible for policy observation ${observation.metadata.controllerDigest}`);
      }
      const expected = publicObservation(candidate.observation);
      const actual = publicObservation(observation);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`policy observation does not match controller evidence ${observation.metadata.controllerDigest}`);
      }
    }
  }
  return policy;
}

function policiesDirectory(homeDir) {
  return path.join(learningDirectory({ homeDir: resolveHome(homeDir) }), 'policies');
}

function policyPath(homeDir, version) {
  if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new TypeError('policy version contains unsupported characters');
  return path.join(policiesDirectory(homeDir), `policy-${version}.json`);
}

function currentPolicyPath(homeDir) {
  return path.join(learningDirectory({ homeDir: resolveHome(homeDir) }), 'current-policy.json');
}

export async function readWeeklyPolicy({ homeDir, version } = {}) {
  let selectedVersion = version;
  if (selectedVersion === undefined) {
    const pointerPath = currentPolicyPath(homeDir);
    const pointer = await parseJson(pointerPath, 'weekly policy pointer');
    if (!pointer.available) return null;
    assertObject(pointer.value, 'weekly policy pointer');
    assertExactKeys(pointer.value, ['schemaVersion', 'version'], 'weekly policy pointer');
    if (pointer.value.schemaVersion !== WEEKLY_POLICY_VERSION) throw new Error(`Unsupported weekly policy pointer schemaVersion: ${pointer.value.schemaVersion}`);
    selectedVersion = requiredString(pointer.value.version, 'weekly policy pointer.version');
  }
  const filePath = policyPath(homeDir, selectedVersion);
  const parsed = await parseJson(filePath, 'weekly policy');
  if (!parsed.available) throw new Error(`Weekly policy version not found: ${selectedVersion}`);
  try {
    const policy = validateWeeklyPolicy(parsed.value);
    return await verifyPolicyAgainstController(policy, homeDir);
  }
  catch (error) { throw new Error(`Invalid weekly policy ${filePath}: ${error.message}`, { cause: error }); }
}

export function policyObservations(policy, task, { minimumSamples = MIN_WEEKLY_ROUTE_SAMPLES } = {}) {
  const validated = validateWeeklyPolicy(policy);
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples < 0) {
    throw new TypeError('minimumSamples must be a non-negative integer');
  }
  const effectiveMinimum = Math.max(MIN_WEEKLY_ROUTE_SAMPLES, minimumSamples);
  if (task && (
    ['high', 'critical'].includes(task.risk)
    || ['high', 'critical'].includes(task.complexity)
    || task.explicitModelPin === true
    || task.profileId !== undefined
    || task.model !== undefined
    || (Array.isArray(task.allowedProfileIds) && task.allowedProfileIds.length > 0)
  )) return [];
  return validated.routeGroups
    .filter((group) => group.observations.length >= effectiveMinimum)
    .filter((group) => !task?.kind || group.taskKind === task.kind)
    .flatMap((group) => group.observations.map((entry) => normalizeObservation(entry)));
}

async function writePolicy(policy, homeDir) {
  const validated = validateWeeklyPolicy(policy);
  const destination = policyPath(homeDir, validated.version);
  const existing = await parseJson(destination, 'weekly policy');
  if (existing.available) {
    let previous;
    try { previous = validateWeeklyPolicy(existing.value); }
    catch (error) { throw new Error(`Invalid weekly policy ${destination}: ${error.message}`, { cause: error }); }
    if (JSON.stringify(previous) !== JSON.stringify(validated)) {
      throw new Error(`Weekly policy version collision: ${validated.version}`);
    }
  } else {
    await writeJsonAtomic(destination, validated);
  }
  await writeJsonAtomic(currentPolicyPath(homeDir), {
    schemaVersion: WEEKLY_POLICY_VERSION,
    version: validated.version
  });
}

export async function restoreWeeklyPolicy({ homeDir, version }) {
  const policy = await readWeeklyPolicy({ homeDir, version });
  await writeJsonAtomic(currentPolicyPath(homeDir), {
    schemaVersion: WEEKLY_POLICY_VERSION,
    version: policy.version
  });
  return policy;
}

export async function evaluateWeekly({ roots = [], homeDir, apply = false, now = new Date(), config } = {}) {
  assertObject(config, 'config');
  if (typeof apply !== 'boolean') throw new TypeError('apply must be a boolean');
  const nowIso = validDate(now, 'now');
  const configuredMinimumSamples = config.learning?.minimumSamples ?? MIN_WEEKLY_ROUTE_SAMPLES;
  if (!Number.isSafeInteger(configuredMinimumSamples) || configuredMinimumSamples < MIN_WEEKLY_ROUTE_SAMPLES) {
    throw new TypeError(`config.learning.minimumSamples must be an integer of at least ${MIN_WEEKLY_ROUTE_SAMPLES}`);
  }
  const minimumSamples = Math.max(MIN_WEEKLY_ROUTE_SAMPLES, configuredMinimumSamples);
  const nowMs = new Date(nowIso).getTime();
  const discovery = await discoverRoots({ roots, homeDir });
  const controllerSource = await readControllerEvidence({ homeDir: resolveHome(homeDir) });
  const controllerByDigest = new Map(controllerSource.records.map((record) => [record.evidenceDigest, record]));
  const controllerByIdentity = new Map(
    controllerSource.records.map((record) => [runEvidenceIdentity(record.evidence), record])
  );
  const rootResults = [];
  for (const entry of discovery.roots) rootResults.push(await readRootEvidence(entry));

  const runByIdentity = new Map();
  const operationalRunIdentities = new Set();
  const artifactByIdentity = new Map();
  const qualityByIdentity = new Map();
  let evidenceCandidates = 0;
  const collectRun = (run, controller, knownControllerIdentity = false) => {
    evidenceCandidates += 1;
    const identity = runEvidenceIdentity(run);
    const trusted = controller?.evidenceDigest === evidenceDigest(run);
    if (!runByIdentity.has(identity) || trusted) runByIdentity.set(identity, run);
    if (new Date(run.recordedAt).getTime() <= nowMs) {
      operationalRunIdentities.add(`${run.runId}\0${run.taskId}\0${run.attempt}`);
    }
    const candidate = fromRunEvidence(
      run,
      trusted
        ? trustedControllerState(controller)
        : { available: knownControllerIdentity, matches: false, attestation: null }
    );
    const previous = qualityByIdentity.get(candidate.identity);
    if (!previous || (!previous.eligible && candidate.eligible)) qualityByIdentity.set(candidate.identity, candidate);
  };
  // Controller evidence is the canonical source. Project JSONL is a local
  // operational mirror and cannot hide an attested failure by deleting a row.
  for (const record of controllerSource.records) collectRun(record.evidence, record);
  for (const root of rootResults) {
    for (const run of root.runs) {
      collectRun(
        run,
        controllerByDigest.get(evidenceDigest(run)),
        controllerByIdentity.has(runEvidenceIdentity(run))
      );
    }
    for (const artifact of root.taskArtifacts) {
      if (!artifactByIdentity.has(artifact.identity)) artifactByIdentity.set(artifact.identity, artifact);
    }
    for (const candidate of root.observations) {
      evidenceCandidates += 1;
      const previous = qualityByIdentity.get(candidate.identity);
      if (!previous || (!previous.eligible && candidate.eligible)) qualityByIdentity.set(candidate.identity, candidate);
    }
  }
  const quality = [...qualityByIdentity.values()];
  for (const entry of quality) {
    if (entry.observation && new Date(entry.observation.recordedAt).getTime() > nowMs) {
      entry.eligible = false;
      entry.ineligibleReason = 'future-dated-evidence';
    }
  }
  const eligible = quality.filter((entry) => entry.eligible && entry.observation);
  const ineligibleReasons = {};
  for (const entry of quality.filter((item) => !item.eligible)) {
    ineligibleReasons[entry.ineligibleReason] = (ineligibleReasons[entry.ineligibleReason] ?? 0) + 1;
  }
  const currentPolicy = await readWeeklyPolicy({ homeDir });
  const accumulated = new Map(eligible.map((entry) => [entry.identity, entry]));
  for (const observation of currentPolicy ? policyObservations(currentPolicy) : []) {
    if (new Date(observation.recordedAt).getTime() > nowMs) continue;
    const identity = legacyObservationIdentity(observation);
    if (!accumulated.has(identity)) accumulated.set(identity, { identity, observation, eligible: true, ineligibleReason: null });
  }
  const proposedPolicy = buildPolicy({
    eligible: [...accumulated.values()], now: nowIso, config, minimumSamples
  });
  const policyEvidenceIdentities = (policy) => new Set(
    policy.routeGroups.flatMap((group) => group.observations.map(legacyObservationIdentity))
  );
  const currentIdentities = currentPolicy ? policyEvidenceIdentities(currentPolicy) : new Set();
  const proposedIdentities = policyEvidenceIdentities(proposedPolicy);
  const changed = proposedPolicy.routeGroups.length > 0
    && [...proposedIdentities].some((identity) => !currentIdentities.has(identity));
  const policy = changed || !currentPolicy ? proposedPolicy : currentPolicy;
  if (apply && changed) await writePolicy(proposedPolicy, homeDir);

  const historicArtifacts = [...artifactByIdentity.values()]
    .filter((entry) => !operationalRunIdentities.has(entry.identity));
  const metrics = summarizeRuns(
    [...runByIdentity.values()].filter((run) => new Date(run.recordedAt).getTime() <= nowMs),
    historicArtifacts
  );
  const report = {
    schemaVersion: 1,
    generatedAt: nowIso,
    window: { start: new Date(new Date(nowIso).getTime() - WEEK_MS).toISOString(), end: nowIso },
    registries: discovery.registries,
    controllerEvidence: {
      path: controllerSource.root,
      available: controllerSource.available,
      count: controllerSource.records.length
    },
    roots: rootResults.map((entry) => ({
      root: entry.root,
      stateRoot: entry.stateRoot,
      source: entry.source,
      available: entry.available,
      sources: entry.sources
    })),
    metrics,
    quality: {
      status: eligible.length === 0 ? 'unscored' : 'scored',
      eligibleObservations: eligible.length,
      currentWindowEligibleObservations: eligible.filter(
        (entry) => new Date(entry.observation.recordedAt).getTime() >= nowMs - WEEK_MS
      ).length,
      unscoredObservations: quality.length - eligible.length,
      ineligibleReasons,
      duplicateObservations: evidenceCandidates - qualityByIdentity.size
    },
    policy: {
      changed,
      eligibleRouteGroups: policy.routeGroups.length,
      applied: apply && changed,
      reason: changed ? null : proposedPolicy.routeGroups.length === 0
        ? 'no-route-met-sample-policy'
        : 'no-new-approved-evidence'
    }
  };
  return { report, policy, applied: apply && changed };
}
