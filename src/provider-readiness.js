import { diagnoseProviders } from './provider-diagnostics.js';
import { forceRoute, selectRoute } from './router.js';
import { resolveAntigravityModel } from './providers/antigravity-cli.js';

// The slug the CLI will actually receive. `agy models` lists suffixed Gemini
// slugs, while the catalog stores the base and lets the effort pick the suffix.
export function launchModel(provider, route) {
  return provider.adapter === 'antigravity' ? resolveAntigravityModel(route.model, route.effort) : route.model;
}

// One context belongs to one exec/dispatch invocation; no persistent blacklist.
export function createReadinessContext({ diagnose = diagnoseProviders, now = Date.now } = {}) {
  const cache = new Map(), excluded = new Set(), evidence = [];
  return {
    excluded, evidence,
    async check(provider, model, cwd) {
      const key = JSON.stringify([provider.id, provider.adapter, provider.executable, cwd]);
      let item = cache.get(key);
      if (!item || now() - item.time >= 300_000) {
        const [result] = await diagnose({ providers: [provider], cwd });
        item = { time: now(), result };
        if (result.readiness === 'ready') cache.set(key, item);
      }
      const result = { ...item.result, model };
      if (result.readiness === 'ready' && result.models && !result.models.includes(model)) {
        result.readiness = 'blocked';
        result.readinessReason = 'model-unavailable';
      }
      evidence.push(result);
      if (result.readiness !== 'ready') excluded.add(provider.id);
      return result;
    }
  };
}

export async function selectReadyRoute({ task, config, observations, cwd, forcedRoute, context }) {
  while (true) {
    const candidateTask = { ...task, forbiddenProviders: [...new Set([...(task.forbiddenProviders ?? []), ...context.excluded])] };
    let route;
    try {
      route = forcedRoute
        ? forceRoute({ catalog: config, task: candidateTask, profileId: forcedRoute.profileId, effort: forcedRoute.effort })
        : selectRoute({ task: candidateTask, catalog: config, observations });
    } catch (cause) {
      const reasons = context.evidence.filter((item) => item.readiness !== 'ready')
        .map((item) => `${item.id}: ${item.readinessReason}`).join('; ');
      const error = new Error(`No ready route satisfying task constraints${reasons ? ` (${reasons})` : ''}: ${cause.message}`, { cause });
      error.preflightEvidence = [...context.evidence];
      throw error;
    }
    const provider = config.providers.find((entry) => entry.id === route.provider);
    // Generic commands only promise executable + args, not version/auth flags.
    // Retain that contract; preflight is mandatory for the four native adapters.
    if (provider.adapter === 'generic') {
      context.evidence.push({ id: provider.id, readiness: 'unknown', readinessReason: 'custom-protocol', executionStatus: 'not-probed' });
      return route;
    }
    const status = await context.check(provider, launchModel(provider, route), cwd);
    if (status.readiness === 'ready') return route;
  }
}
