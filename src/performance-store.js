const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const RISK_TIERS = new Set(['low', 'standard', 'high', 'critical']);
const COMPLEXITIES = new Set(['low', 'standard', 'high', 'critical']);

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function normalizeSignature(input) {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('observation.taskSignature must be an object');
  }
  const result = {};
  for (const [field, value] of Object.entries(input)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TypeError(`observation.taskSignature.${field} must be a non-empty string`);
    }
    result[field] = value.trim();
  }
  return result;
}

export function normalizeObservation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('observation must be an object');
  }
  for (const field of ['provider', 'profileId', 'model', 'effort', 'taskKind', 'role']) {
    if (typeof input[field] !== 'string' || input[field].trim() === '') {
      throw new TypeError(`observation.${field} must be a non-empty string`);
    }
  }
  if (input.reviewed !== undefined && typeof input.reviewed !== 'boolean') {
    throw new TypeError('observation.reviewed must be a boolean');
  }
  const risk = input.risk ?? 'standard';
  if (!RISK_TIERS.has(risk)) throw new Error('observation.risk must be low, standard, high, or critical');
  const complexity = input.complexity ?? 'standard';
  if (!COMPLEXITIES.has(complexity)) throw new Error('observation.complexity must be low, standard, high, or critical');
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata))) {
    throw new TypeError('observation.metadata must be an object');
  }
  const quality = Number(input.quality);
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) {
    throw new RangeError('quality must be a finite number between 0 and 1');
  }
  const recordedAt = new Date(input.recordedAt);
  if (Number.isNaN(recordedAt.getTime())) {
    throw new TypeError('recordedAt must be a valid date');
  }
  const modelRevision = input.modelRevision ?? input.model;
  if (typeof modelRevision !== 'string' || modelRevision.trim() === '') {
    throw new TypeError('observation.modelRevision must be a non-empty string');
  }
  return {
    provider: input.provider,
    profileId: input.profileId,
    model: input.model,
    modelRevision: modelRevision.trim(),
    effort: input.effort,
    taskKind: input.taskKind,
    role: input.role,
    risk,
    complexity,
    taskSignature: normalizeSignature(input.taskSignature),
    quality,
    recordedAt: recordedAt.toISOString(),
    reviewed: input.reviewed !== false,
    metadata: input.metadata ?? {}
  };
}

function sameBaseRoute(observation, route, task) {
  return observation.reviewed !== false
    && observation.provider === route.provider
    && observation.profileId === route.profileId
    && observation.model === route.model
    && observation.effort === route.effort
    && observation.taskKind === task.kind
    && observation.role === task.role
    && observation.risk === (task.risk ?? 'standard')
    && observation.complexity === (task.complexity ?? 'standard');
}

function signatureCompatible(observationSignature, taskSignature) {
  const entries = Object.entries(observationSignature ?? {});
  if (entries.length === 0) return true;
  const taskValues = taskSignature ?? {};
  return entries.every(([field, value]) => taskValues[field] === value);
}

function classifyEvidence({ observations, route, task, nowMs, maxObservationAgeDays, maxFutureSkewMinutes }) {
  const diagnostics = {
    revisionMismatch: 0,
    stale: 0,
    future: 0,
    signatureMismatch: 0,
    lastEvidenceAt: null
  };
  const matched = [];
  const expectedRevision = route.modelRevision ?? route.model;
  const maximumAgeMs = maxObservationAgeDays * DAY_MS;
  const maximumFutureMs = maxFutureSkewMinutes * MINUTE_MS;

  for (const raw of observations) {
    const observation = normalizeObservation(raw);
    if (!sameBaseRoute(observation, route, task)) continue;
    if (observation.modelRevision !== expectedRevision) {
      diagnostics.revisionMismatch += 1;
      continue;
    }
    if (!signatureCompatible(observation.taskSignature, task.signature)) {
      diagnostics.signatureMismatch += 1;
      continue;
    }
    const recordedMs = new Date(observation.recordedAt).getTime();
    if (recordedMs > nowMs + maximumFutureMs) {
      diagnostics.future += 1;
      continue;
    }
    if (nowMs - recordedMs > maximumAgeMs) {
      diagnostics.stale += 1;
      continue;
    }
    matched.push(observation);
    if (diagnostics.lastEvidenceAt === null || observation.recordedAt > diagnostics.lastEvidenceAt) {
      diagnostics.lastEvidenceAt = observation.recordedAt;
    }
  }
  return { matched, diagnostics };
}

export function estimateRouteQuality({
  route,
  task,
  priorQuality,
  observations = [],
  now = new Date(),
  halfLifeDays = 30,
  maxObservationAgeDays = 180,
  maxFutureSkewMinutes = 5,
  priorWeight = 3,
  uncertaintyPenalty = 0.02
}) {
  if (!Number.isFinite(priorQuality) || priorQuality < 0 || priorQuality > 1) {
    throw new RangeError('priorQuality must be between 0 and 1');
  }
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    throw new RangeError('halfLifeDays must be positive');
  }
  if (!Number.isFinite(maxObservationAgeDays) || maxObservationAgeDays <= 0) {
    throw new RangeError('maxObservationAgeDays must be positive');
  }
  if (!Number.isFinite(maxFutureSkewMinutes) || maxFutureSkewMinutes < 0) {
    throw new RangeError('maxFutureSkewMinutes must be non-negative');
  }
  if (!Number.isFinite(priorWeight) || priorWeight < 0) {
    throw new RangeError('priorWeight must be non-negative');
  }

  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError('now must be a valid date');
  const { matched, diagnostics } = classifyEvidence({
    observations,
    route,
    task,
    nowMs,
    maxObservationAgeDays,
    maxFutureSkewMinutes
  });

  let evidenceWeight = 0;
  let evidenceQuality = 0;
  for (const observation of matched) {
    const ageDays = Math.max(0, (nowMs - new Date(observation.recordedAt).getTime()) / DAY_MS);
    const weight = Math.pow(0.5, ageDays / halfLifeDays);
    evidenceWeight += weight;
    evidenceQuality += weight * observation.quality;
  }

  const totalWeight = priorWeight + evidenceWeight;
  const mean = totalWeight > 0
    ? (priorWeight * priorQuality + evidenceQuality) / totalWeight
    : priorQuality;
  const uncertainty = uncertaintyPenalty > 0
    ? uncertaintyPenalty / Math.sqrt(Math.max(1, evidenceWeight))
    : 0;

  return {
    mean: clamp01(mean),
    conservative: clamp01(mean - uncertainty),
    uncertainty,
    effectiveSamples: evidenceWeight,
    rawSamples: matched.length,
    priorQuality,
    priorWeight,
    diagnostics
  };
}
