import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './fs-util.js';

export const DEFAULT_LIMIT_MINUTES = 60;

// Best-effort detection of subscription/rate limit failures in CLI output.
// The exact provider message formats are not pinned yet; capture a fixture
// when a real event occurs and tighten this pattern then. Until that, the
// manual `aorch limits set` toggle is the primary path.
const RATE_LIMIT_PATTERN = /usage limit reached|rate.?limit|429|overloaded|hit your limit|limit resets/i;

export function detectRateLimit(result) {
  if (!result) return false;
  return RATE_LIMIT_PATTERN.test(`${result.stderr ?? ''}\n${result.stdout ?? ''}`);
}

function limitsPath(stateRoot) {
  return path.join(stateRoot, 'limits.json');
}

// Active limits only: expiry is a timestamp comparison at read time, so a
// limit auto-releases without any daemon or polling. This is cost state, not
// a safety control, so a corrupt file reads as empty instead of failing.
export async function readLimits(stateRoot, now = new Date()) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(limitsPath(stateRoot), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
  const nowMs = new Date(now).getTime();
  const active = {};
  for (const [provider, entry] of Object.entries(parsed ?? {})) {
    const until = new Date(entry?.limitedUntil ?? 0).getTime();
    if (Number.isFinite(until) && until > nowMs) active[provider] = entry;
  }
  return active;
}

export async function setLimit(stateRoot, provider, {
  minutes = DEFAULT_LIMIT_MINUTES,
  source = 'manual',
  note,
  now = new Date()
} = {}) {
  if (typeof provider !== 'string' || provider.trim() === '') {
    throw new TypeError('provider must be a non-empty string');
  }
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new RangeError('minutes must be positive');
  }
  const current = await readLimits(stateRoot, now);
  const limitedUntil = new Date(new Date(now).getTime() + minutes * 60_000).toISOString();
  const next = { ...current, [provider]: { limitedUntil, source, ...(note ? { note } : {}) } };
  await writeJsonAtomic(limitsPath(stateRoot), next);
  return next[provider];
}

export async function clearLimits(stateRoot, provider) {
  const current = await readLimits(stateRoot);
  const next = provider
    ? Object.fromEntries(Object.entries(current).filter(([id]) => id !== provider))
    : {};
  await writeJsonAtomic(limitsPath(stateRoot), next);
  return next;
}
