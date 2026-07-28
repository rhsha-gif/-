import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { executeTask } from './task-runner.js';
import { runVerificationCommands } from './verify.js';
import { appendObservation } from './observations.js';
import { detectRateLimit, setLimit, DEFAULT_LIMIT_MINUTES } from './limits.js';
import { writeJsonAtomic } from './fs-util.js';

function routeSummary(route) {
  return { provider: route.provider, profileId: route.profileId, model: route.model, effort: route.effort };
}

function nextLadderStep(config, provider, triedRoutes) {
  const ladder = config.escalation?.ladders?.[provider] ?? [];
  return ladder.find((step) => !triedRoutes.has(`${step.profileId}:${step.effort}`));
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
  setLimitImpl = setLimit
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

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let execution;
    try {
      execution = await executeTaskImpl({
        task: currentTask,
        ...passthrough,
        ...(forcedRoute ? { forcedRoute } : {})
      });
    } catch (error) {
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

    if (commands.length === 0) {
      return { ...execution, verification: null, attempts: [{ attempt, route: routeSummary(execution.route), passed: null }] };
    }

    const verification = await runVerificationImpl({
      commands,
      cwd,
      timeoutMs: config.verification?.commandTimeoutMs
    });
    attempts.push({ attempt, route: routeSummary(execution.route), passed: verification.passed });
    const evidencePath = path.join(execution.runDir, 'verification.json');
    await writeJsonAtomic(evidencePath, {
      attempt,
      route: routeSummary(execution.route),
      passed: verification.passed,
      results: verification.results
    });
    if (observationsPath) {
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
    forcedRoute = nextLadderStep(config, execution.route.provider, triedRoutes);
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
