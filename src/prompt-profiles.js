import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PROMPT_PROFILES_DIR = path.join(PACKAGE_ROOT, 'prompt-profiles');
const OFFICIAL_HOSTS_BY_PROVIDER = Object.freeze({
  anthropic: new Set(['platform.claude.com', 'code.claude.com']),
  openai: new Set(['developers.openai.com', 'platform.openai.com', 'cookbook.openai.com'])
});
const OFFICIAL_PUBLISHER_BY_PROVIDER = Object.freeze({ anthropic: 'anthropic', openai: 'openai' });
const DAY_MS = 24 * 60 * 60 * 1000;
const STRATEGIES = new Set(['xml', 'sections']);
const STATUSES = new Set(['active', 'candidate', 'retired']);

function strings(value, field) {
  if (!Array.isArray(value) || value.length === 0
    || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')
    || new Set(value).size !== value.length) {
    throw new TypeError(`${field} must be a unique non-empty array of strings`);
  }
  return value.map((entry) => entry.trim());
}

function dateOnly(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    throw new TypeError(`${field} must be an ISO date`);
  }
  return value;
}

function officialSource(source, index, provider) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError(`officialSources[${index}] must be an object`);
  }
  for (const field of ['publisher', 'document', 'url']) {
    if (typeof source[field] !== 'string' || source[field].trim() === '') {
      throw new TypeError(`officialSources[${index}].${field} must be a non-empty string`);
    }
  }
  let parsed;
  try { parsed = new URL(source.url); }
  catch { throw new TypeError(`officialSources[${index}].url must be a valid URL`); }
  const allowedHosts = OFFICIAL_HOSTS_BY_PROVIDER[provider];
  if (!allowedHosts) throw new Error(`No official prompt-source policy is configured for provider ${provider}`);
  if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname)) {
    throw new Error(`officialSources[${index}] must use an official ${provider} provider domain`);
  }
  if (source.publisher.trim().toLowerCase() !== OFFICIAL_PUBLISHER_BY_PROVIDER[provider]) {
    throw new Error(`officialSources[${index}].publisher must match provider ${provider}`);
  }
  return {
    publisher: source.publisher.trim(),
    document: source.document.trim(),
    url: parsed.toString(),
    verifiedAt: dateOnly(source.verifiedAt, `officialSources[${index}].verifiedAt`)
  };
}

export function validatePromptProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('prompt profile must be an object');
  }
  if (input.version !== 1) throw new Error('prompt profile version must be 1');
  for (const field of ['id', 'provider']) {
    if (typeof input[field] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input[field])) {
      throw new TypeError(`prompt profile ${field} must be a path-safe identifier`);
    }
  }
  if (!STRATEGIES.has(input.strategy)) throw new Error('prompt profile strategy must be xml or sections');
  if (!STATUSES.has(input.status)) throw new Error('prompt profile status must be active, candidate, or retired');
  if (!input.rules || typeof input.rules !== 'object' || Array.isArray(input.rules)) {
    throw new TypeError('prompt profile rules must be an object');
  }
  if (input.rules.requiredSections !== undefined
    && (!Array.isArray(input.rules.requiredSections)
      || input.rules.requiredSections.some((section) => typeof section !== 'string' || section.trim() === ''))) {
    // A non-array (or non-string entries) validates here but makes the lint's
    // `for (const section of requiredSections)` crash at execution time.
    throw new TypeError('prompt profile rules.requiredSections must be an array of non-empty strings');
  }
  if (!Array.isArray(input.officialSources) || input.officialSources.length === 0) {
    throw new TypeError('prompt profile requires officialSources');
  }
  return {
    ...structuredClone(input),
    modelFamilies: strings(input.modelFamilies, 'prompt profile modelFamilies'),
    roles: strings(input.roles, 'prompt profile roles'),
    taskKinds: strings(input.taskKinds, 'prompt profile taskKinds'),
    verifiedAt: dateOnly(input.verifiedAt, 'prompt profile verifiedAt'),
    officialSources: input.officialSources.map((source, index) => officialSource(source, index, input.provider))
  };
}

export function assertPromptProfileFresh(profile, {
  now = new Date(),
  maxAgeDays = 120,
  maxFutureSkewDays = 1
} = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('prompt profile freshness now must be a valid Date');
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1) throw new RangeError('maxAgeDays must be a positive integer');
  if (!Number.isInteger(maxFutureSkewDays) || maxFutureSkewDays < 0) throw new RangeError('maxFutureSkewDays must be a non-negative integer');
  const dates = [profile.verifiedAt, ...(profile.officialSources ?? []).map((source) => source.verifiedAt)]
    .map((value) => new Date(`${value}T00:00:00Z`));
  if (dates.some((value) => Number.isNaN(value.getTime()))) throw new Error(`Prompt profile ${profile.id} contains an invalid verification date`);
  const times = dates.map((value) => value.getTime());
  const oldest = new Date(Math.min(...times));
  const newest = new Date(Math.max(...times));
  // Future-skew must be judged against the NEWEST source: a single
  // impossibly-future-dated source must not hide behind an older one. Age must
  // be judged against the OLDEST source: the profile is only as fresh as its
  // stalest citation.
  if (now.getTime() - newest.getTime() < -maxFutureSkewDays * DAY_MS) {
    throw new Error(`Prompt profile ${profile.id} is future dated beyond ${maxFutureSkewDays} day(s)`);
  }
  const ageDays = Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / DAY_MS));
  if (ageDays > maxAgeDays) {
    throw new Error(`Prompt profile ${profile.id} is stale at ${ageDays} days; maximum age is ${maxAgeDays}`);
  }
  return {
    fresh: true,
    ageDays,
    oldestVerifiedAt: oldest.toISOString().slice(0, 10),
    maxAgeDays,
    maxFutureSkewDays
  };
}

async function jsonFiles(root) {
  const result = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(candidate);
      else if (entry.isFile() && entry.name.endsWith('.json')) result.push(candidate);
    }
  }
  await walk(root);
  return result.sort();
}


export function inspectPromptProfileHealth(profiles, { now = new Date(), policy = {} } = {}) {
  if (!Array.isArray(profiles)) throw new TypeError('profiles must be an array');
  const entries = profiles.map((profile) => {
    // Only active profiles can ever be selected at runtime; a stale retired or
    // candidate profile must not fail doctor for guidance the runtime never
    // uses. Report them as skipped instead.
    if (profile.status !== 'active') {
      return { id: profile.id, provider: profile.provider, status: 'skipped', profileStatus: profile.status };
    }
    try {
      const freshness = assertPromptProfileFresh(profile, {
        now,
        maxAgeDays: policy.maxProfileAgeDays ?? 120,
        maxFutureSkewDays: policy.maxFutureSkewDays ?? 1
      });
      return { id: profile.id, provider: profile.provider, status: 'pass', ...freshness };
    } catch (error) {
      return { id: profile.id, provider: profile.provider, status: 'fail', reason: error.message };
    }
  });
  return { status: entries.some((entry) => entry.status === 'fail') ? 'fail' : 'pass', profiles: entries };
}

export async function loadPromptProfiles(root = DEFAULT_PROMPT_PROFILES_DIR) {
  const profiles = [];
  const ids = new Set();
  for (const filePath of await jsonFiles(root)) {
    let parsed;
    try { parsed = JSON.parse(await readFile(filePath, 'utf8')); }
    catch (error) { throw new Error(`Invalid prompt profile ${filePath}: ${error.message}`); }
    let profile;
    try { profile = validatePromptProfile(parsed); }
    catch (error) { throw new Error(`Invalid prompt profile ${filePath}: ${error.message}`); }
    if (ids.has(profile.id)) throw new Error(`Duplicate prompt profile id: ${profile.id}`);
    ids.add(profile.id);
    profiles.push(profile);
  }
  return profiles;
}

function modelMatches(profile, model) {
  const normalized = String(model ?? '').toLowerCase();
  return profile.modelFamilies.some((family) => normalized === family.toLowerCase() || normalized.includes(family.toLowerCase()));
}

export function resolvePromptProfile({ route, modelProfile = {}, profiles, role, taskKind, now = new Date(), policy = {} }) {
  if (!route?.provider || !route?.model) throw new TypeError('route provider and model are required');
  if (!Array.isArray(profiles)) throw new TypeError('profiles must be an array');
  const requested = modelProfile.promptProfileIds ?? [];
  const candidates = requested.length
    ? requested.map((id) => {
        const profile = profiles.find((entry) => entry.id === id);
        if (!profile) throw new Error(`Prompt profile not found: ${id}`);
        return profile;
      })
    : profiles;
  const compatible = candidates.filter((profile) => profile.status === 'active'
    && profile.provider === route.provider
    && modelMatches(profile, route.model)
    && (!role || profile.roles.includes(role))
    && (!taskKind || profile.taskKinds.includes(taskKind)));
  if (compatible.length === 0) {
    if (requested.length && candidates.some((profile) => profile.provider !== route.provider)) {
      throw new Error(`Prompt profile provider mismatch for route ${route.provider}/${route.model}`);
    }
    throw new Error(`No compatible prompt profile for route ${route.provider}/${route.model}`);
  }

  const freshnessFailures = [];
  for (const profile of compatible) {
    try {
      return {
        ...profile,
        freshness: assertPromptProfileFresh(profile, {
          now,
          maxAgeDays: policy.maxProfileAgeDays ?? 120,
          maxFutureSkewDays: policy.maxFutureSkewDays ?? 1
        })
      };
    } catch (error) {
      freshnessFailures.push(`${profile.id}: ${error.message}`);
    }
  }
  throw new Error(`No fresh compatible prompt profile for route ${route.provider}/${route.model}. ${freshnessFailures.join(' | ')}`);
}

export const OFFICIAL_PROMPT_SOURCE_HOSTS = new Set(
  Object.values(OFFICIAL_HOSTS_BY_PROVIDER).flatMap((hosts) => [...hosts])
);
export { OFFICIAL_HOSTS_BY_PROVIDER as OFFICIAL_PROMPT_SOURCE_HOSTS_BY_PROVIDER };
