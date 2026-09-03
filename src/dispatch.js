import { validateTaskPlan } from './decompose.js';
import { roleAgentName } from './role-agent.js';
import { selectRoute } from './router.js';
import { executeWithVerification } from './run-loop.js';
import { randomUUID } from 'node:crypto';

function adapterForProvider(config, providerId) {
  const provider = config.providers?.find((entry) => entry.id === providerId);
  if (!provider) throw new Error(`Unknown provider in route: ${providerId}`);
  return provider.adapter;
}

function routeSummary(route) {
  return {
    provider: route.provider,
    profileId: route.profileId,
    model: route.model,
    effort: route.effort
  };
}

// Walks a validated plan in declared order. Order is the plan's only sequencing
// signal — a reviewer task declared after the implementation it reviews must not
// run first — so this is deliberately sequential rather than parallel.
export async function dispatchPlan({
  plan,
  config,
  observations = [],
  cwd = process.cwd(),
  dryRun = false,
  timeoutMs,
  // Where the verify gate appends its quality observation. run-loop skips the
  // append entirely when this is absent, so omitting it silently costs every
  // dispatched task its routing evidence — the thing the whole ledger is for.
  observationsPath,
  // Providers currently rate-limited. Applied to every task exactly as `aorch
  // exec` applies it to one, so a limit hit does not mean half a plan routes to
  // an exhausted subscription.
  forbiddenProviders = [],
  executeImpl = executeWithVerification,
  selectRouteImpl = selectRoute
}) {
  const validated = validateTaskPlan(plan);
  const results = [];
  const runId = randomUUID();

  for (const declared of validated.tasks) {
    const task = forbiddenProviders.length === 0
      ? declared
      : {
        ...declared,
        forbiddenProviders: [...new Set([...(declared.forbiddenProviders ?? []), ...forbiddenProviders])]
      };
    const route = selectRouteImpl({ task, catalog: config, observations, quota: null });
    const adapter = adapterForProvider(config, route.provider);

    // Resolved before any process starts. A missing mapping is a configuration
    // error, and discovering it after a worker already wrote files would leave
    // the tree changed by a task that should never have been dispatched.
    let agent;
    try {
      agent = roleAgentName({ config, agentRole: task.agentRole, adapter });
    } catch (error) {
      results.push({
        taskId: task.id,
        agentRole: task.agentRole,
        status: 'failed',
        route: routeSummary(route),
        error: error.message
      });
      return { objective: validated.objective, decomposed: validated.decomposed, results, ok: false };
    }

    if (dryRun) {
      results.push({
        taskId: task.id,
        agentRole: task.agentRole,
        agent,
        adapter,
        status: 'planned',
        ...routeSummary(route)
      });
      continue;
    }

    try {
      const execution = await executeImpl({
        task: { ...task, runId },
        config,
        observations,
        cwd,
        ...(observationsPath === undefined ? {} : { observationsPath }),
        ...(timeoutMs === undefined ? {} : { timeoutMs })
      });
      results.push({
        taskId: task.id,
        agentRole: task.agentRole,
        agent,
        status: 'complete',
        route: routeSummary(execution.route ?? route),
        runDir: execution.runDir,
        verification: execution.verification,
        attempts: execution.attempts
      });
    } catch (error) {
      // Stop the plan. Later tasks were written assuming the earlier ones
      // landed; running them on a half-applied tree produces failures whose
      // cause is the dispatcher, not the work.
      results.push({
        taskId: task.id,
        agentRole: task.agentRole,
        agent,
        status: 'failed',
        route: routeSummary(route),
        error: error.message,
        ...(error.runDir ? { runDir: error.runDir } : {}),
        ...(error.attempts ? { attempts: error.attempts } : {})
      });
      return { objective: validated.objective, decomposed: validated.decomposed, results, ok: false };
    }
  }

  return { objective: validated.objective, decomposed: validated.decomposed, results, ok: true };
}
