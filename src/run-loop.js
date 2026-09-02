import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { executeTask } from './task-runner.js';
import { runVerificationCommands } from './verify.js';
import { appendObservation } from './observations.js';
import { detectRateLimit, setLimit, DEFAULT_LIMIT_MINUTES } from './limits.js';
import { writeJsonAtomic } from './fs-util.js';
import { captureGitSnapshot, evaluateChangeGuard } from './change-guard.js';

function routeSummary(route) {
  return { provider: route.provider, profileId: route.profileId, model: route.model, effort: route.effort };
}

function nextLadderStep(config, provider, triedRoutes, task = {}) {
  const ladder = config.escalation?.ladders?.[provider] ?? [];
  if ((task.allowedProviders?.length && !task.allowedProviders.includes(provider))
    || (task.forbiddenProviders ?? []).includes(provider)) {
    return undefined;
  }
  return ladder.find((step) => !triedRoutes.has(`${step.profileId}:${step.effort}`)
    && (!task.allowedProfileIds?.length || task.allowedProfileIds.includes(step.profileId))
    && !(task.forbiddenProfileIds ?? []).includes(step.profileId));
}

async function failChangeGuard({ attempt, route, runDir, changeGuard, attempts, cause }) {
  const routeEvidence = routeSummary(route);
  attempts.push({
    attempt,
    route: routeEvidence,
    passed: false,
    changeGuardPassed: false
  });
  const evidencePath = path.join(runDir, 'verification.json');
  await writeJsonAtomic(evidencePath, {
    attempt,
    route: routeEvidence,
    passed: false,
    results: [],
    changeGuard
  });
  const error = new Error(
    `Change guard failed after attempt ${attempt}; manual review required. Evidence: ${evidencePath}`,
    cause ? { cause } : undefined
  );
  error.attempts = attempts;
  error.runDir = runDir;
  error.changeGuard = changeGuard;
  throw error;
}

// The receipt is the only machine-readable signal a task without verification
// commands produces, and the schema lets the worker say `partial`, `blocked`,
// or mark a criterion `fail`. A string is why the run must stop; any receipt
// that is not a non-array object is rejected.
function receiptVerdict(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return 'worker receipt is not an object';
  if (receipt.status !== 'complete') {
    return `worker receipt reports status "${receipt.status}"`;
  }
  const failed = (Array.isArray(receipt.criteria) ? receipt.criteria : [])
    .filter((entry) => entry?.status === 'fail')
    .map((entry) => entry.criterion);
  if (failed.length > 0) {
    return `worker receipt marks ${failed.length} criterion(s) failed: ${failed.join('; ')}`;
  }
  return null;
}

// Same shape as failChangeGuard: the worker's own verdict on its work is not
// a model failure escalation can fix — a blocked reviewer stays blocked on a
// stronger tier — so the evidence returns to the human immediately.
async function failReceiptVerdict({ attempt, route, runDir, changeGuard, attempts, receipt, verdict }) {
  const routeEvidence = routeSummary(route);
  attempts.push({ attempt, route: routeEvidence, passed: false, changeGuardPassed: true, receiptStatus: receipt?.status });
  const evidencePath = path.join(runDir, 'verification.json');
  await writeJsonAtomic(evidencePath, {
    attempt,
    route: routeEvidence,
    passed: false,
    results: [],
    changeGuard,
    receiptVerdict: verdict
  });
  const error = new Error(`${verdict}; manual review required. Evidence: ${evidencePath}`);
  error.attempts = attempts;
  error.runDir = runDir;
  error.receiptStatus = receipt?.status;
  throw error;
}

// Exec -> verify -> escalate. A failed verification climbs the provider's
// escalation ladder with the failure evidence attached; when the attempt
// budget or the ladder runs out, the human gets the evidence back instead of
// a silent retry loop. Verify outcomes are also the one non-human observation
// source: an objective pass/fail signal that lets bad downshifts self-correct.
export async function executeWithVerification({
  task,
  config,
  observations = [],
  cwd = process.cwd(),
  timeoutMs,
  dryRun = false,
  observationsPath,
  stateRoot = path.resolve(cwd, config.paths?.stateDir ?? '.aorch'),
  executeTaskImpl = executeTask,
  runVerificationImpl = runVerificationCommands,
  appendObservationImpl = appendObservation,
  setLimitImpl = setLimit,
  captureGitSnapshotImpl = captureGitSnapshot,
  evaluateChangeGuardImpl = evaluateChangeGuard
}) {
  const passthrough = { config, observations, cwd, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  if (dryRun) return executeTaskImpl({ task, ...passthrough, dryRun: true });

  const commands = task.verificationCommands ?? [];
  const maxAttempts = Math.max(1, config.escalation?.maxAttempts ?? 3);
  // All attempts share one run id so their receipts and verification evidence
  // land under a single run tree.
  const runId = task.runId ?? randomUUID();
  const attempts = [];
  const triedRoutes = new Set();
  const forbiddenProviders = new Set(task.forbiddenProviders ?? []);
  let currentTask = { ...structuredClone(task), runId };
  let forcedRoute;

  // Capture the baseline once, before any attempt. Escalation retries build on
  // the tree the previous attempt left behind, so re-snapshotting per attempt
  // would compare a stronger model's work against an already-dirtied baseline —
  // its honest file claims then read as "overclaimed" (zero net delta) and the
  // guard rejects a correct result. The guard validates net change across the
  // whole run against the pre-run tree.
  const beforeSnapshot = await captureGitSnapshotImpl({ cwd });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let execution;
    try {
      execution = await executeTaskImpl({
        task: currentTask,
        ...passthrough,
        ...(forcedRoute ? { forcedRoute } : {})
      });
    } catch (error) {
      if (error?.route) {
        const afterSnapshot = await captureGitSnapshotImpl({ cwd });
        const changeGuard = evaluateChangeGuardImpl({
          task: currentTask,
          receipt: { filesChanged: [] },
          before: beforeSnapshot,
          after: afterSnapshot,
          ignoredPaths: [stateRoot]
        });
        if (!changeGuard.passed) {
          await failChangeGuard({
            attempt,
            route: error.route,
            runDir: error.runDir ?? path.join(stateRoot, 'task-runs', runId, currentTask.id),
            changeGuard,
            attempts,
            cause: error
          });
        }
      }
      // A rate-limited provider is a cost event, not a task failure: record
      // the limit, forbid the provider, and reselect a route across the
      // remaining providers. Anything else propagates untouched.
      if (!error?.route?.provider || !detectRateLimit(error.result)) throw error;
      const provider = error.route.provider;
      await setLimitImpl(stateRoot, provider, {
        minutes: DEFAULT_LIMIT_MINUTES,
        source: 'auto-detect',
        note: `detected during task ${currentTask.id}`
      });
      forbiddenProviders.add(provider);
      attempts.push({ attempt, route: routeSummary(error.route), passed: false, rateLimited: true });
      if (attempt === maxAttempts) {
        const exhausted = new Error(
          `Provider ${provider} is rate limited and the attempt budget is exhausted after ${attempt} attempt(s)`
        );
        exhausted.attempts = attempts;
        throw exhausted;
      }
      forcedRoute = undefined;
      currentTask = { ...currentTask, forbiddenProviders: [...forbiddenProviders] };
      continue;
    }
    triedRoutes.add(`${execution.route.profileId}:${execution.route.effort}`);
    const afterSnapshot = await captureGitSnapshotImpl({ cwd });
    const changeGuard = evaluateChangeGuardImpl({
      task: currentTask,
      receipt: execution.receipt,
      before: beforeSnapshot,
      after: afterSnapshot,
      ignoredPaths: [stateRoot]
    });
    const evidencePath = path.join(execution.runDir, 'verification.json');

    if (!changeGuard.passed) {
      await failChangeGuard({
        attempt,
        route: execution.route,
        runDir: execution.runDir,
        changeGuard,
        attempts
      });
    }

    const verdict = receiptVerdict(execution.receipt);
    if (verdict) {
      await failReceiptVerdict({
        attempt,
        route: execution.route,
        runDir: execution.runDir,
        changeGuard,
        attempts,
        receipt: execution.receipt,
        verdict
      });
    }

    if (commands.length === 0) {
      const singleAttempt = {
        attempt,
        route: routeSummary(execution.route),
        passed: null,
        changeGuardPassed: true
      };
      await writeJsonAtomic(evidencePath, {
        attempt,
        route: routeSummary(execution.route),
        passed: true,
        results: [],
        changeGuard
      });
      return { ...execution, verification: null, attempts: [singleAttempt] };
    }

    const verification = await runVerificationImpl({
      commands,
      cwd,
      timeoutMs: config.verification?.commandTimeoutMs
    });
    if (verification.passed) {
      const afterVerificationSnapshot = await captureGitSnapshotImpl({ cwd });
      const verificationChangeGuard = evaluateChangeGuardImpl({
        task: currentTask,
        receipt: { filesChanged: [] },
        before: afterSnapshot,
        after: afterVerificationSnapshot,
        ignoredPaths: [stateRoot]
      });
      // Verification can generate build artefacts, so only repository control
      // state is an integrity boundary after commands complete.
      if (verificationChangeGuard.headChanged || verificationChangeGuard.controlPathsChanged.length > 0) {
        await failChangeGuard({
          attempt,
          route: execution.route,
          runDir: execution.runDir,
          changeGuard: verificationChangeGuard,
          attempts
        });
      }
    }
    attempts.push({
      attempt,
      route: routeSummary(execution.route),
      passed: verification.passed,
      changeGuardPassed: true
    });
    await writeJsonAtomic(evidencePath, {
      attempt,
      route: routeSummary(execution.route),
      passed: verification.passed,
      results: verification.results,
      changeGuard
    });
    // A read-only worker whose tree the guard just proved untouched cannot
    // have influenced what the commands measure, so the outcome would grade
    // the repository's state, not the model (measured: three tiers each
    // earned a false 0.2 judging a book that genuinely failed QA). Without an
    // applicable guard there is no such proof, so behavior stays unchanged.
    const provenUninvolved = changeGuard.applicable && !task.write;
    if (observationsPath && !provenUninvolved) {
      await appendObservationImpl(observationsPath, {
        provider: execution.route.provider,
        model: execution.route.model,
        effort: execution.route.effort,
        taskKind: task.kind,
        role: task.role,
        profileId: execution.route.profileId,
        quality: verification.passed ? 1 : 0.2,
        metadata: { source: 'verify-gate', taskId: currentTask.id, attempt }
      });
    }

    if (verification.passed) return { ...execution, verification, attempts };

    const failed = verification.results[verification.results.length - 1];
    if (provenUninvolved) {
      // Same invariant: no retry on any tier can change the verify outcome,
      // so climbing the ladder is provably wasted spend. Return the evidence
      // to the human immediately.
      const error = new Error(
        'Verification failed on a read-only task; escalation cannot change what the commands measure. ' +
        `Last failing command: ${failed?.command} (exit ${failed?.exitCode}). Evidence: ${evidencePath}`
      );
      error.attempts = attempts;
      error.runDir = execution.runDir;
      throw error;
    }
    forcedRoute = nextLadderStep(config, execution.route.provider, triedRoutes, task);
    if (!forcedRoute || attempt === maxAttempts) {
      const error = new Error(
        `Verification failed after ${attempt} attempt(s); escalation ${forcedRoute ? 'budget' : 'ladder'} exhausted. ` +
        `Last failing command: ${failed?.command} (exit ${failed?.exitCode}). Evidence: ${evidencePath}`
      );
      error.attempts = attempts;
      error.runDir = execution.runDir;
      throw error;
    }
    currentTask = {
      ...structuredClone(task),
      runId,
      forbiddenProviders: [...forbiddenProviders],
      id: `${task.id}.esc${attempt}`,
      objective: `${task.objective}\n\n## Previous attempt failed verification\n` +
        `Route: ${execution.route.model}@${execution.route.effort}\n` +
        `Command: ${failed?.command} (exit ${failed?.exitCode}${failed?.timedOut ? ', timed out' : ''})\n` +
        `${failed?.stderrTail || failed?.stdoutTail || '(no output captured)'}`
    };
  }
  throw new Error('unreachable: attempt loop exited without a verdict');
}
