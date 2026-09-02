import { estimateRouteQuality } from './performance-store.js';

const ROUTE_METRICS = ['quality', 'tokens', 'latency'];
const TASK_COMPLEXITIES = ['low', 'standard', 'high', 'critical'];
const DEFAULT_COMPLEXITY_BY_RISK = Object.freeze({ low: 'low', standard: 'standard', high: 'high', critical: 'high' });
const RISK_RANK = Object.freeze({ low: 0, standard: 1, high: 2, critical: 3 });


function effectiveTaskComplexity(task) {
  const complexity = task.complexity ?? DEFAULT_COMPLEXITY_BY_RISK[task.risk] ?? 'standard';
  if (!TASK_COMPLEXITIES.includes(complexity)) {
    throw new Error(`Unsupported task complexity: ${complexity}`);
  }
  if (task.risk === 'critical' && task.complexity !== undefined && !['high', 'critical'].includes(complexity)) {
    throw new Error('Critical task complexity must be high or critical');
  }
  return complexity;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function providerSupportsCapabilities(provider, requestedIds, inventory) {
  if (!requestedIds?.length) return true;
  const byId = new Map();
  const ambiguousIds = new Set();
  for (const entry of inventory ?? []) {
    if (byId.has(entry.id)) ambiguousIds.add(entry.id);
    else byId.set(entry.id, entry);
  }
  return requestedIds.every((id) => {
    if (ambiguousIds.has(id)) return false;
    const capability = byId.get(id);
    if (!capability || capability.enabled === false) return false;
    const providers = capability.providers ?? ['*'];
    return providers.includes('*') || providers.includes(provider);
  });
}

function providerMetadata(catalog, providerId) {
  // A catalog may omit provider metadata entirely; the CLI path cannot reach
  // this fallback because validateConfig rejects models that reference
  // undeclared providers.
  return (catalog.providers ?? []).find((entry) => entry.id === providerId)
    ?? { id: providerId, adapterMaturity: 'stable' };
}

function providerAllowedForTask(provider, task, policy) {
  const risk = task.risk ?? 'standard';
  if ((provider.adapterMaturity ?? 'stable') === 'experimental') {
    const maximum = policy.experimentalAdapterMaxRisk ?? 'standard';
    if ((RISK_RANK[risk] ?? 1) > (RISK_RANK[maximum] ?? 1)) return false;
  }
  return true;
}

function supportsTask(profile, task, catalog) {
  const provider = providerMetadata(catalog, profile.provider);
  return profile.enabled !== false
    && provider.enabled !== false
    && providerAllowedForTask(provider, task, catalog.controlPlane ?? {})
    && (profile.roles?.includes(task.role) ?? true)
    && (profile.taskKinds?.includes(task.kind) ?? true)
    && (!task.allowedProviders?.length || task.allowedProviders.includes(profile.provider))
    && !(task.forbiddenProviders ?? []).includes(profile.provider)
    && !(task.forbiddenProfileIds ?? []).includes(profile.id)
    // The positive twin of forbiddenProfileIds. Its one legitimate use is a
    // task whose point is a specific model's judgement (the model-upgrade
    // audit); routing by quality cannot express that, because a cheaper tier
    // with an effort bump ties or wins on the prior.
    && (!task.allowedProfileIds?.length || task.allowedProfileIds.includes(profile.id))
    && providerSupportsCapabilities(profile.provider, task.capabilityIds, catalog.capabilities);
}

function expandCandidates(task, catalog, complexity) {
  return (catalog.models ?? [])
    .filter((profile) => supportsTask(profile, task, catalog))
    .flatMap((profile) => (profile.efforts ?? [{ name: 'medium' }])
      .filter((effort) => !effort.complexities?.length || effort.complexities.includes(complexity))
      .filter((effort) => !effort.taskKinds?.length || effort.taskKinds.includes(task.kind))
      .map((effort) => {
        const provider = providerMetadata(catalog, profile.provider);
        const prior = profile.quality?.[task.kind] ?? profile.quality?.default ?? 0.5;
        return {
          provider: profile.provider,
          profileId: profile.id,
          model: profile.model,
          effort: effort.name,
          quotaGate: effort.quotaGate ?? null,
          maturity: profile.maturity ?? 'stable',
          adapterMaturity: provider.adapterMaturity ?? 'stable',
          priorQuality: clamp01(prior + (effort.qualityDelta ?? 0)),
          tokenIndex: (profile.tokenIndex ?? 1) * (effort.tokenMultiplier ?? 1),
          latencyIndex: (profile.latencyIndex ?? 1) * (effort.latencyMultiplier ?? 1),
          metadata: profile.metadata ?? {}
        };
      }));
}

function byStableIdentity(left, right) {
  // Codepoint order, not localeCompare: ICU collation varies by host locale
  // and would make the final tie-break nondeterministic across machines.
  const a = `${left.profileId}:${left.effort}`;
  const b = `${right.profileId}:${right.effort}`;
  return a < b ? -1 : a > b ? 1 : 0;
}

function effectivePriorities(task, policy) {
  const configured = task.routingPriorities ?? policy.defaultPriorities ?? ROUTE_METRICS;
  if (!Array.isArray(configured) || configured.length === 0
    || configured.length > ROUTE_METRICS.length
    || configured.some((metric) => !ROUTE_METRICS.includes(metric))
    || new Set(configured).size !== configured.length) {
    throw new TypeError('Routing priorities must be a unique non-empty array of quality, tokens, and latency');
  }
  if (configured[0] !== 'quality' && task.minimumQuality === undefined) {
    throw new Error('An explicit task.minimumQuality is required when routing priorities do not start with quality');
  }
  return [...configured, ...ROUTE_METRICS.filter((metric) => !configured.includes(metric))];
}

function applyHardConstraints(candidates, task) {
  return candidates.filter((candidate) => (
    (task.minimumQuality === undefined || candidate.quality.conservative >= task.minimumQuality)
    && (task.maxTokenIndex === undefined || candidate.tokenIndex <= task.maxTokenIndex)
    && (task.maxLatencyIndex === undefined || candidate.latencyIndex <= task.maxLatencyIndex)
  ));
}

// Quota is a cost-optimization signal, never a safety gate. Unknown quota
// (provider absent from the map, or a non-finite value) means "no signal" and
// leaves the candidate untouched in every quota decision below.
function quotaThresholds(policy) {
  return {
    soft: policy.quota?.softThresholdPercent ?? 40,
    hard: policy.quota?.hardThresholdPercent ?? 10,
    premium: policy.quota?.premiumThresholdPercent ?? 60
  };
}

function quotaState(quota, providerId, thresholds) {
  const remaining = quota?.[providerId];
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return 'unknown';
  if (remaining < thresholds.hard) return 'depleted';
  if (remaining < thresholds.soft) return 'low';
  return 'ok';
}

// Drop depleted-quota providers only while an alternative survives: an
// exclusion that would empty the set rolls back, degrading depletion from an
// exclusion to a preference (the soft stage still disprefers those providers).
function excludeDepletedProviders(candidates, quota, thresholds) {
  const surviving = candidates.filter(
    (candidate) => quotaState(quota, candidate.provider, thresholds) !== 'depleted'
  );
  if (surviving.length === 0 || surviving.length === candidates.length) {
    return { candidates, excludedProviders: [] };
  }
  const excludedProviders = [...new Set(
    candidates
      .filter((candidate) => quotaState(quota, candidate.provider, thresholds) === 'depleted')
      .map((candidate) => candidate.provider)
  )];
  return { candidates: surviving, excludedProviders };
}

// Fan-out modes (efforts carrying quotaGate: ultra, ultracode) invert the
// unknown-quota rule above on purpose. Depletion exclusion refuses to punish a
// provider for a missing signal; a gated effort is an opt-in luxury that only
// turns on when the remaining quota is positively confirmed to cover it — an
// absent or unreadable signal keeps it off. Like depletion, an exclusion that
// would empty the candidate set rolls back so a task never loses its only
// route to the gate.
function applyWideModeGate(candidates, quota, thresholds) {
  const surviving = candidates.filter((candidate) => {
    if (!candidate.quotaGate) return true;
    const remaining = quota?.[candidate.provider];
    const floor = candidate.quotaGate === 'premium' ? thresholds.premium : thresholds.soft;
    return typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= floor;
  });
  if (surviving.length === 0 || surviving.length === candidates.length) {
    return { candidates, excludedCandidates: [] };
  }
  const excludedCandidates = candidates
    .filter((candidate) => !surviving.includes(candidate))
    .map((candidate) => ({ profileId: candidate.profileId, effort: candidate.effort, quotaGate: candidate.quotaGate }));
  return { candidates: surviving, excludedCandidates };
}

// Within the tie set left by the first priority metric, prefer providers whose
// quota is not running low. Placed after the first metric on purpose: the tie
// set after the full narrowing chain is almost always a single candidate, so a
// last-place tie-break would never fire, while here the preference decides
// among candidates the leading metric already considers equivalent.
function preferComfortableQuota(tier, quota, thresholds) {
  const comfortable = tier.filter(
    (candidate) => !['low', 'depleted'].includes(quotaState(quota, candidate.provider, thresholds))
  );
  if (comfortable.length === 0 || comfortable.length === tier.length) {
    return { tier, applied: false };
  }
  return { tier: comfortable, applied: true };
}

function narrowByMetric(candidates, metric, policy) {
  if (candidates.length <= 1) return candidates;
  if (metric === 'quality') {
    const best = Math.max(...candidates.map((candidate) => candidate.quality.conservative));
    const tolerance = policy.qualityTolerance ?? 0.005;
    return candidates.filter((candidate) => candidate.quality.conservative >= best - tolerance);
  }
  const field = metric === 'tokens' ? 'tokenIndex' : 'latencyIndex';
  const best = Math.min(...candidates.map((candidate) => candidate[field]));
  const tolerance = metric === 'tokens'
    ? (policy.tokenTolerance ?? 0.05)
    : (policy.latencyTolerance ?? policy.tokenTolerance ?? 0.05);
  return candidates.filter((candidate) => candidate[field] <= best * (1 + tolerance));
}

// Escalation deliberately bypasses the eligibility filters: a ladder is a
// human-authored recovery path, and its profiles may be locked out of normal
// routing on purpose (e.g. an apex model whose only effort is critical-only).
export function forceRoute({ catalog, profileId, effort, task = {} }) {
  const profile = (catalog.models ?? []).find((entry) => entry.id === profileId);
  if (!profile || profile.enabled === false) {
    throw new Error(`Forced route requires an enabled profile: ${profileId}`);
  }
  const effortSpec = (profile.efforts ?? []).find((entry) => entry.name === effort);
  if (!effortSpec) {
    throw new Error(`Forced route effort is not defined for ${profileId}: ${effort}`);
  }
  const provider = providerMetadata(catalog, profile.provider);
  const prior = clamp01(
    (profile.quality?.[task.kind] ?? profile.quality?.default ?? 0.5) + (effortSpec.qualityDelta ?? 0)
  );
  return {
    provider: profile.provider,
    profileId: profile.id,
    model: profile.model,
    effort: effortSpec.name,
    maturity: profile.maturity ?? 'stable',
    adapterMaturity: provider.adapterMaturity ?? 'stable',
    priorQuality: prior,
    quality: { mean: prior, conservative: prior, uncertainty: 0, effectiveSamples: 0, rawSamples: 0, priorQuality: prior, priorWeight: 0 },
    tokenIndex: (profile.tokenIndex ?? 1) * (effortSpec.tokenMultiplier ?? 1),
    latencyIndex: (profile.latencyIndex ?? 1) * (effortSpec.latencyMultiplier ?? 1),
    metadata: profile.metadata ?? {},
    decision: { policy: 'forced-route', complexity: task.complexity ?? null }
  };
}

export function selectRoute({ task, catalog, observations = [], now = new Date(), quota = null }) {
  if (!task?.kind || !task?.role) {
    throw new TypeError('task.kind and task.role are required');
  }
  const policy = catalog?.routing ?? {};
  const complexity = effectiveTaskComplexity(task);

  let candidates = expandCandidates(task, catalog, complexity).map((route) => ({
    ...route,
    quality: estimateRouteQuality({
      route,
      task: { ...task, complexity },
      priorQuality: route.priorQuality,
      observations,
      now,
      halfLifeDays: policy.observationHalfLifeDays ?? 30,
      priorWeight: policy.priorWeight ?? 3,
      uncertaintyPenalty: policy.uncertaintyPenalty ?? 0.02
    })
  }));

  // Report generic ineligibility before the critical challenger gate so an
  // empty candidate set is not misattributed to model maturity.
  if (candidates.length === 0) {
    throw new Error(`No eligible route for task ${task.id ?? '<unknown>'}`);
  }

  if (task.risk === 'critical') {
    const minimum = policy.criticalMinimumSamples ?? 3;
    const eligible = candidates.filter((candidate) => {
      if (candidate.maturity !== 'challenger') return true;
      return task.role === 'reviewer' && candidate.quality.effectiveSamples >= minimum;
    });
    if (eligible.length === 0) {
      throw new Error(`No proven route is eligible for critical task ${task.id ?? '<unknown>'}`);
    }
    candidates = eligible;
  }

  const beforeConstraints = candidates.length;
  candidates = applyHardConstraints(candidates, task);
  if (candidates.length === 0) {
    throw new Error(`No eligible route meets the explicit constraints for task ${task.id ?? '<unknown>'}`);
  }

  // Quota runs after the explicit-constraint filter so a constraint failure is
  // never misattributed to quota, and its exclusion can only shrink a set that
  // already satisfies the task's floors.
  const thresholds = quotaThresholds(policy);
  let excludedProviders = [];
  if (quota) {
    ({ candidates, excludedProviders } = excludeDepletedProviders(candidates, quota, thresholds));
  }

  // Runs even without a quota map: gated efforts stay sealed until a reading
  // positively confirms headroom, so a missing signal never unlocks them.
  const wideGate = applyWideModeGate(candidates, quota, thresholds);
  candidates = wideGate.candidates;

  const priorities = effectivePriorities(task, policy);
  const stageCounts = [];
  let softQuotaApplied = false;
  let tier = candidates;
  for (const [index, metric] of priorities.entries()) {
    tier = narrowByMetric(tier, metric, policy);
    stageCounts.push({ metric, remaining: tier.length });
    if (index === 0 && quota) {
      const preference = preferComfortableQuota(tier, quota, thresholds);
      tier = preference.tier;
      softQuotaApplied = preference.applied;
      stageCounts.push({ metric: 'quota', remaining: tier.length });
    }
  }

  tier.sort(byStableIdentity);
  const selected = tier[0];
  return {
    ...selected,
    decision: {
      policy: policy.selectionPolicy ?? 'task-specific-priority-order',
      priorities,
      candidatesConsidered: beforeConstraints,
      candidatesAfterConstraints: candidates.length,
      stageCounts,
      complexity,
      constraints: {
        minimumQuality: task.minimumQuality ?? null,
        maxTokenIndex: task.maxTokenIndex ?? null,
        maxLatencyIndex: task.maxLatencyIndex ?? null
      },
      quota: quota
        ? {
          remainingByProvider: { ...quota },
          excludedProviders,
          softPreferenceApplied: softQuotaApplied,
          softThresholdPercent: thresholds.soft,
          hardThresholdPercent: thresholds.hard
        }
        : null,
      wideGate: {
        premiumThresholdPercent: thresholds.premium,
        softThresholdPercent: thresholds.soft,
        excludedCandidates: wideGate.excludedCandidates
      }
    }
  };
}
