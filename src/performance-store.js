const DAY_MS = 24 * 60 * 60 * 1000;

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

export function normalizeObservation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('observation must be an object');
  }
  // The matched route identity is four dimensions only: provider, model,
  // effort, and task kind. Any finer stratification (profile, role, risk,
  // complexity) fragments a solo user's evidence so no cell ever accumulates
  // enough samples to move off the prior. Those fields are kept as optional
  // metadata but never gate matching.
  for (const field of ['provider', 'model', 'effort', 'taskKind']) {
    if (typeof input[field] !== 'string' || input[field].trim() === '') {
      throw new TypeError(`observation.${field} must be a non-empty string`);
    }
  }
  for (const field of ['profileId', 'role']) {
    if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field].trim() === '')) {
      throw new TypeError(`observation.${field} must be a non-empty string when provided`);
    }
  }
  if (input.reviewed !== undefined && typeof input.reviewed !== 'boolean') {
    throw new TypeError('observation.reviewed must be a boolean');
  }
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
  return {
    provider: input.provider,
    model: input.model,
    effort: input.effort,
    taskKind: input.taskKind,
    ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
    ...(input.role === undefined ? {} : { role: input.role }),
    quality,
    recordedAt: recordedAt.toISOString(),
    reviewed: input.reviewed !== false,
    metadata: input.metadata ?? {}
  };
}

function sameRoute(observation, route, task) {
  return observation.reviewed !== false
    && observation.provider === route.provider
    && observation.model === route.model
    && observation.effort === route.effort
    && observation.taskKind === task.kind;
}

export function estimateRouteQuality({
  route,
  task,
  priorQuality,
  observations = [],
  now = new Date(),
  halfLifeDays = 30,
  priorWeight = 3,
  uncertaintyPenalty = 0.02
}) {
  if (!Number.isFinite(priorQuality) || priorQuality < 0 || priorQuality > 1) {
    throw new RangeError('priorQuality must be between 0 and 1');
  }
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    throw new RangeError('halfLifeDays must be positive');
  }
  if (!Number.isFinite(priorWeight) || priorWeight < 0) {
    throw new RangeError('priorWeight must be non-negative');
  }

  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError('now must be a valid date');
  const matched = observations
    .map(normalizeObservation)
    .filter((observation) => sameRoute(observation, route, task));

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
    priorWeight
  };
}
