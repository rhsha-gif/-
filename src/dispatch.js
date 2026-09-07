import { validateTaskPlan } from './decompose.js';
import { roleAgentName } from './role-agent.js';
import { selectRoute } from './router.js';
import { executeWithVerification } from './run-loop.js';
import { planFingerprint } from './continuation.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeJsonAtomic } from './fs-util.js';

function routeSummary(route) {
  return route ? { provider: route.provider, profileId: route.profileId, model: route.model, effort: route.effort } : undefined;
}

export async function dispatchPlan({ plan, config, observations = [], cwd = process.cwd(), dryRun = false, timeoutMs,
  observationsPath, forbiddenProviders = [], executeImpl = executeWithVerification, selectRouteImpl = selectRoute }) {
  const validated = validateTaskPlan(plan);
  const results = [];
  const runId = randomUUID();
  const fingerprint = planFingerprint(plan);
  const runDir = path.resolve(cwd, config.paths?.stateDir ?? '.aorch', 'task-runs', runId);
  const outcome = async (status) => {
    const result = { objective: validated.objective, decomposed: validated.decomposed, runId,
      planFingerprint: fingerprint, status, results, ok: status === 'complete' || status === 'planned',
      ...(!dryRun ? { planPath: path.join(runDir, 'plan.json'), resultPath: path.join(runDir, 'dispatch.json') } : {}) };
    if (!dryRun) {
      await writeJsonAtomic(result.planPath, plan);
      await writeJsonAtomic(result.resultPath, result);
    }
    return result;
  };
  for (const declared of validated.tasks) {
    const task = { ...declared, forbiddenProviders: [...new Set([...(declared.forbiddenProviders ?? []), ...forbiddenProviders])] };
    let route, agent;
    try {
      route = selectRouteImpl({ task, catalog: config, observations, quota: null });
      const adapter = config.providers?.find((entry) => entry.id === route.provider)?.adapter;
      if (!adapter) throw new Error(`Unknown provider in route: ${route.provider}`);
      agent = roleAgentName({ config, agentRole: task.agentRole, agentId: task.agentId, adapter });
      if (dryRun) {
        results.push({ taskId: task.id, agentRole: task.agentRole, ...(task.agentId ? { agentId: task.agentId } : {}), agent, adapter, status: 'planned', ...routeSummary(route) });
        continue;
      }
      const execution = await executeImpl({ task: { ...task, runId }, config, observations, cwd,
        ...(observationsPath === undefined ? {} : { observationsPath }), ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      const status = execution.status === 'awaiting-input' ? 'awaiting-input' : 'complete';
      results.push({ taskId: task.id, agentRole: task.agentRole, ...(task.agentId ? { agentId: task.agentId } : {}), agent, status,
        route: routeSummary(execution.route ?? route), runDir: execution.runDir, receiptPath: execution.receiptPath,
        receipt: execution.receipt, verification: execution.verification, attempts: execution.attempts,
        ...(execution.inputRequest ? { inputRequest: execution.inputRequest } : {}) });
      if (status === 'awaiting-input') return outcome(status);
    } catch (error) {
      results.push({ taskId: task.id, agentRole: task.agentRole, agent, status: 'failed', route: routeSummary(route), error: error.message,
        ...(error.runDir ? { runDir: error.runDir } : {}), ...(error.attempts ? { attempts: error.attempts } : {}) });
      return outcome('failed');
    }
  }
  return outcome(dryRun ? 'planned' : 'complete');
}
