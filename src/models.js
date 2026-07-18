import { buildClaudeCommand } from './providers/claude-cli.js';
import { buildCodexCommand } from './providers/codex-cli.js';
import { providerById } from './config.js';
import { checkExecutable } from './doctor.js';
import { inspectSubscriptionEnvironment, sanitizeSubscriptionWorkerEnv } from './subscription.js';
import { runCommand } from './executor.js';
import { loadModelAvailability, recordModelAvailability } from './usage-store.js';

const PROBE_PROMPT = 'Respond with the single word ok. Do not read files, run commands, or make changes.';

// Static inspection: client/config/profile facts only, no model call and no
// quota consumption. Catalog presence is a routing wish, not entitlement.
export async function inspectModels({ config, root }) {
  const recorded = await loadModelAvailability({ root });
  const executables = new Map();
  for (const provider of config.providers.filter((entry) => entry.enabled !== false)) {
    executables.set(provider.id, checkExecutable(provider));
  }
  return {
    note: 'availability is unknown until an opt-in live probe or client evidence supports it',
    models: config.models.filter((model) => model.enabled !== false).map((model) => ({
      profileId: model.id,
      provider: model.provider,
      model: model.model,
      revision: model.revision ?? model.model,
      efforts: model.efforts.map((effort) => effort.name),
      clientExecutable: executables.get(model.provider) ?? { status: 'fail', reason: 'provider disabled or missing' },
      availability: recorded[model.id] ?? { state: config.modelAvailability?.[model.id] ?? 'unknown', source: null, at: null }
    }))
  };
}

export async function probeModelLive({
  config,
  root,
  profileId,
  env = process.env,
  confirmed = false,
  timeoutMs = 120_000,
  execute = runCommand,
  now = () => new Date().toISOString()
}) {
  if (confirmed !== true) {
    throw new Error('live probe requires explicit confirmation (--yes): a probe is a real provider request and can consume subscription allowance');
  }
  const model = config.models.find((entry) => entry.id === profileId && entry.enabled !== false);
  if (!model) throw new Error(`Unknown or disabled model profile: ${profileId}`);
  const provider = providerById(config, model.provider);
  if (provider.adapter !== 'claude' && provider.adapter !== 'codex') {
    throw new Error(`Live probes support only subscription clients; provider ${provider.id} uses adapter ${provider.adapter}`);
  }
  const subscriptionProvider = provider.adapter === 'claude' ? 'anthropic' : 'openai';
  const inspection = inspectSubscriptionEnvironment({
    env,
    provider: subscriptionProvider,
    policy: { allowAutomationCredential: config.access?.allowAutomationCredential === true }
  });
  if (inspection.status !== 'pass') {
    const names = [...inspection.conflicts, ...inspection.automationCredentials].map((entry) => entry.name).join(', ');
    throw new Error(`live probe blocked by credential policy: ${names}`);
  }

  const route = { provider: provider.id, model: model.model, effort: model.efforts[0]?.name ?? 'medium' };
  const spec = provider.adapter === 'claude'
    ? buildClaudeCommand({ prompt: PROBE_PROMPT, route, write: false, outputFormat: 'text', maxTurns: 1, executable: provider.executable ?? 'claude' })
    : buildCodexCommand({ prompt: PROBE_PROMPT, route, write: false, executable: provider.executable ?? 'codex' });
  spec.env = { ...sanitizeSubscriptionWorkerEnv({ env, provider: subscriptionProvider }), ...spec.env };
  spec.envMode = 'replace';

  const result = await execute(spec, { timeoutMs, maxOutputBytes: 256 * 1024 });
  let state = 'unknown';
  let detail = null;
  if (result.status === 'complete') {
    state = 'available';
  } else if (/limit|rate|exhaust|quota/i.test(`${result.stderr}\n${result.stdout}`)) {
    state = 'temporarily-limited';
    detail = 'provider reported a usage or rate limit';
  } else {
    detail = `probe exited ${result.exitCode}${result.terminationReason ? ` (${result.terminationReason})` : ''}`;
  }
  const record = await recordModelAvailability({ root, profileId, state, source: 'live-probe', at: now(), detail });
  return { record, probe: { exitCode: result.exitCode, terminationReason: result.terminationReason ?? null } };
}
