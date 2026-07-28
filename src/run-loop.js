import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { executeTask } from './task-runner.js';
import { runVerificationCommands } from './verify.js';
import { appendObservation } from './observations.js';
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
  executeTaskImpl = executeTask,
  runVerificationImpl = runVerificationCommands,
  appendObservationImpl = appendObservation
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
  let currentTask = { ...structuredClone(task), runId };
  let forcedRoute;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const execution = await executeTaskImpl({
      task: currentTask,
      ...passthrough,
      ...(forcedRoute ? { forcedRoute } : {})
    });
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
      id: `${task.id}.esc${attempt}`,
      objective: `${task.objective}\n\n## Previous attempt failed verification\n` +
        `Route: ${execution.route.model}@${execution.route.effort}\n` +
        `Command: ${failed?.command} (exit ${failed?.exitCode}${failed?.timedOut ? ', timed out' : ''})\n` +
        `${failed?.stderrTail || failed?.stdoutTail || '(no output captured)'}`
    };
  }
  throw new Error('unreachable: attempt loop exited without a verdict');
}
