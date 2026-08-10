import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from './executor.js';
import { writeJsonAtomic } from './fs-util.js';

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
  // Require a real number (or a numeric string). Reject null / '' / false /
  // arrays / objects, which Number() would silently coerce to a misleading 0 —
  // an explicit null is "unknown", not "0% remaining". (typeof null === 'object'.)
  if (raw === undefined || typeof raw === 'boolean' || typeof raw === 'object') return null;
  const remainingPercent = Number(raw);
  if (!Number.isFinite(remainingPercent) || (typeof raw === 'string' && raw.trim() === '')) return null;
  return { provider: provider.id, remainingPercent };
}

// Reads every probed provider's quota through a TTL cache at
// <stateRoot>/quota-cache.json, so routing pays the (up to 10s per provider)
// probe cost at most once per TTL window. Probe failures are cached as null
// for the same window — a broken probe must not re-charge every call. With
// refresh: false the call never probes: a stale or missing entry just means
// "no signal" (cache-only readers like classify stay fast). Cache I/O is
// fail-open like the probes themselves: an unreadable or unwritable cache
// degrades to probing (or to no signal), never to an error.
export async function readAllProviderQuotas(providers, {
  stateRoot,
  ttlMs = 5 * 60 * 1000,
  refresh = true,
  now = () => Date.now(),
  runCommandImpl = runCommand,
  cwd = process.cwd(),
  timeoutMs = 10_000
} = {}) {
  const cachePath = path.join(stateRoot, 'quota-cache.json');
  let cache = {};
  try {
    const parsed = JSON.parse(await readFile(cachePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cache = parsed;
  } catch {
    // Missing or corrupt cache: start empty.
  }

  const quota = {};
  let changed = false;
  for (const provider of providers ?? []) {
    if (!provider?.usageProbe) continue;
    const entry = cache[provider.id];
    const probedAt = entry ? Date.parse(entry.probedAt) : Number.NaN;
    const fresh = Number.isFinite(probedAt) && now() - probedAt < ttlMs;
    if (fresh) {
      quota[provider.id] = typeof entry.remainingPercent === 'number' && Number.isFinite(entry.remainingPercent)
        ? entry.remainingPercent
        : null;
      continue;
    }
    if (!refresh) {
      quota[provider.id] = null;
      continue;
    }
    const probed = await readProviderQuota(provider, { runCommandImpl, cwd, timeoutMs });
    quota[provider.id] = probed ? probed.remainingPercent : null;
    cache[provider.id] = { remainingPercent: quota[provider.id], probedAt: new Date(now()).toISOString() };
    changed = true;
  }

  if (changed) {
    try {
      await writeJsonAtomic(cachePath, cache);
    } catch {
      // Fail-open: an unwritable cache just means the next call probes again.
    }
  }
  return quota;
}
