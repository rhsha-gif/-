import { runCommand } from './executor.js';

// Resolve a dot path ("usage.primary.remainingPercent") against a parsed object,
// returning undefined if any segment is missing.
function getByPath(object, dotPath) {
  return dotPath.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), object);
}

// Reads a provider's remaining subscription quota via its configured usageProbe
// — an external CLI (e.g. `caut usage --json`, ccusage) whose JSON output holds
// a remaining-percentage at `remainingField`. Fail-open by design: a missing
// probe, a non-zero exit, unparseable output, or a non-numeric field all yield
// null, so the router simply behaves as if there is no quota signal. Quota is a
// cost-optimization input, not a safety gate, so absent data must never block
// routing. `runCommandImpl` is injectable for tests.
export async function readProviderQuota(provider, { runCommandImpl = runCommand, cwd = process.cwd(), timeoutMs = 10_000 } = {}) {
  const probe = provider?.usageProbe;
  if (!probe) return null;

  let result;
  try {
    result = await runCommandImpl(
      { command: probe.command, args: probe.args, stdin: null, env: {} },
      { cwd, timeoutMs }
    );
  } catch {
    return null;
  }
  if (!result || result.exitCode !== 0) return null;

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }

  const raw = getByPath(parsed, probe.remainingField);
  const remainingPercent = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(remainingPercent)) return null;
  return { provider: provider.id, remainingPercent };
}
