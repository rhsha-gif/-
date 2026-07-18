import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWriteJson } from './file-store.js';
import { validateUsageRecord, USAGE_POOLS } from './subscription.js';

export const MODEL_AVAILABILITY_STATES = ['unknown', 'available', 'unavailable', 'temporarily-limited'];
export const MODEL_AVAILABILITY_SOURCES = ['live-probe', 'client-inspect', 'user'];

export function usageFilePath(root) {
  return path.join(root, 'usage.json');
}

export function modelAvailabilityFilePath(root) {
  return path.join(root, 'model-availability.json');
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Recorded state overrides the config's initial pool state; a pool with no
// record and no config state stays unknown rather than being invented.
export async function loadUsagePools({ root, config = {} }) {
  const stored = (await readJsonIfPresent(usageFilePath(root)))?.pools ?? {};
  const pools = {};
  for (const pool of USAGE_POOLS) {
    pools[pool] = stored[pool] ?? { pool, state: config.usagePools?.[pool] ?? 'unknown', source: null, at: null };
  }
  return { pools };
}

export async function recordUsage({ root, pool, state, source, at = new Date().toISOString(), ageMinutes }) {
  const record = validateUsageRecord({ pool, state, source, at, ...(ageMinutes === undefined ? {} : { ageMinutes }) });
  const current = (await readJsonIfPresent(usageFilePath(root))) ?? { pools: {} };
  current.pools = { ...current.pools, [pool]: record };
  await atomicWriteJson(usageFilePath(root), current);
  return record;
}

export async function loadModelAvailability({ root }) {
  return (await readJsonIfPresent(modelAvailabilityFilePath(root)))?.models ?? {};
}

export async function recordModelAvailability({ root, profileId, state, source, at = new Date().toISOString(), detail = null }) {
  if (typeof profileId !== 'string' || profileId.trim() === '') throw new Error('profileId is required');
  if (!MODEL_AVAILABILITY_STATES.includes(state)) {
    throw new Error(`model availability state must be one of ${MODEL_AVAILABILITY_STATES.join(', ')}`);
  }
  if (!MODEL_AVAILABILITY_SOURCES.includes(source)) {
    throw new Error(`model availability source must be one of ${MODEL_AVAILABILITY_SOURCES.join(', ')}`);
  }
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) throw new Error('model availability requires an ISO timestamp');
  const record = { profileId, state, source, at, ...(detail === null ? {} : { detail }) };
  const current = (await readJsonIfPresent(modelAvailabilityFilePath(root))) ?? { models: {} };
  current.models = { ...current.models, [profileId]: record };
  await atomicWriteJson(modelAvailabilityFilePath(root), current);
  return record;
}
