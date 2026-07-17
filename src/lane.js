import { taskMayTouchProtectedFiles } from './control-plane.js';

const LANE_ORDER = Object.freeze(['single-worker', 'bundled', 'orchestrated']);
const DEFAULT_POLICY = Object.freeze({
  'single-worker': { maxTasks: 1, maxExternalModelCalls: 1, maxLlmReviewers: 0 },
  bundled: { maxTasks: 2, maxExternalModelCalls: 1, maxLlmReviewers: 0 },
  orchestrated: { maxTasks: 24, maxExternalModelCalls: 12, maxLlmReviewers: 3 }
});

function signature(task) {
  return task.signature ?? {};
}

function scoreTask(task) {
  const sig = signature(task);
  const values = {
    ambiguity: { low: 0, medium: 2, high: 4 },
    repositoryBreadth: { local: 0, module: 1, wide: 3 },
    editBreadth: { none: 0, 'one-file': 0, 'few-files': 1, 'many-files': 3 },
    contextVolume: { small: 0, medium: 1, large: 2 },
    toolIntensity: { low: 0, medium: 1, high: 2 },
    stateComplexity: { none: 0, simple: 1, complex: 4 },
    testCoverage: { good: 0, partial: 1, poor: 2, unknown: 2 },
    externalIntegration: { none: 0, 'read-only': 1, mutating: 4 }
  };
  return Object.entries(values).reduce((sum, [field, map]) => sum + (map[sig[field]] ?? 2), 0);
}

function resolvedPolicy(policy = {}) {
  // v0.6.0 migration: lanePolicy.direct described host-direct execution. It
  // is accepted only as a budget alias and never restores host product edits.
  const legacySingle = policy.direct ?? {};
  return {
    'single-worker': { ...DEFAULT_POLICY['single-worker'], ...legacySingle, ...(policy['single-worker'] ?? {}) },
    bundled: { ...DEFAULT_POLICY.bundled, ...(policy.bundled ?? {}) },
    orchestrated: { ...DEFAULT_POLICY.orchestrated, ...(policy.orchestrated ?? {}) }
  };
}

function requiresOrchestration(task, protectedFiles) {
  const sig = signature(task);
  return task.controlPlaneChange === true
    || taskMayTouchProtectedFiles({ task, protectedFiles })
    || task.risk !== 'low'
    || ['high', 'critical'].includes(task.complexity)
    || sig.ambiguity === 'high'
    || sig.repositoryBreadth === 'wide'
    || sig.stateComplexity === 'complex'
    || sig.externalIntegration === 'mutating'
    || (task.escalationSignals?.length ?? 0) > 0;
}

export function classifyExecutionLane({ task, policy = DEFAULT_POLICY, protectedFiles = [] }) {
  if (!task || typeof task !== 'object') throw new TypeError('task is required');
  const lanes = resolvedPolicy(policy);
  const taskScore = scoreTask(task);
  if (requiresOrchestration(task, protectedFiles)) {
    const protectedScope = taskMayTouchProtectedFiles({ task, protectedFiles });
    return {
      lane: 'orchestrated', budget: lanes.orchestrated, score: taskScore,
      reason: protectedScope
        ? 'Write scope can touch protected control-plane files and requires orchestrated approval and verification.'
        : task.escalationSignals?.length
          ? `Escalated by evidence: ${task.escalationSignals.join(', ')}`
          : 'Risk, complexity, or task signature requires orchestration.',
      escalated: protectedScope || (task.escalationSignals?.length ?? 0) > 0
    };
  }

  const sig = signature(task);
  const singleWorkerShape = sig.ambiguity === 'low'
    && sig.repositoryBreadth === 'local'
    && ['none', 'one-file', 'few-files'].includes(sig.editBreadth)
    && sig.contextVolume === 'small'
    && sig.stateComplexity === 'none'
    && sig.externalIntegration === 'none'
    && task.verificationCommands?.length > 0
    && taskScore <= 4;

  if (singleWorkerShape) {
    return {
      lane: 'single-worker', budget: lanes['single-worker'], score: taskScore,
      reason: 'A coherent low-risk task should be completed by one separate bounded worker call.',
      escalated: false
    };
  }

  return {
    lane: 'bundled', budget: lanes.bundled, score: taskScore,
    reason: 'Low-risk work benefits from one or two coherent delegated bundles without a separate router model.',
    escalated: false
  };
}

export function laneRank(lane) {
  const rank = LANE_ORDER.indexOf(lane);
  if (rank < 0) throw new Error(`Unsupported execution lane: ${lane}`);
  return rank;
}

export function resolveExecutionLane({
  task,
  policy = DEFAULT_POLICY,
  protectedFiles = [],
  requestedLane = task?.executionLane,
  requestedReason = task?.laneReason
}) {
  const lanes = resolvedPolicy(policy);
  const base = classifyExecutionLane({ task, policy: lanes, protectedFiles });
  if (!requestedLane) {
    return { ...base, baseLane: base.lane, requestedLane: null };
  }

  const baseRank = laneRank(base.lane);
  const requestedRank = laneRank(requestedLane);
  if (requestedRank < baseRank) {
    return {
      ...base,
      baseLane: base.lane,
      requestedLane,
      reason: `Requested ${requestedLane} lane was denied because it would downgrade the required ${base.lane} safety lane. ${base.reason}`,
      escalated: true
    };
  }
  if (requestedRank === baseRank) {
    return {
      ...base,
      baseLane: base.lane,
      requestedLane,
      reason: requestedReason ?? base.reason
    };
  }
  return {
    lane: requestedLane,
    budget: lanes[requestedLane],
    score: base.score,
    baseLane: base.lane,
    requestedLane,
    reason: requestedReason ?? `Requested ${requestedLane} lane strengthens the classified ${base.lane} lane.`,
    escalated: true
  };
}

export { DEFAULT_POLICY as DEFAULT_LANE_POLICY, LANE_ORDER as EXECUTION_LANE_ORDER, resolvedPolicy as resolveLanePolicy };
