import { readFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG_PATH, validateConfig } from './config.js';
import { writeJsonAtomic } from './fs-util.js';

// This explicit migration adds new defaults, never replaces user tuning.
export function mergeFourCliConfig(current, defaults) {
  const merged = structuredClone(current);
  for (const key of ['providers', 'models']) {
    const existing = new Set((merged[key] ?? []).map((entry) => entry.id));
    merged[key] = [...(merged[key] ?? []), ...defaults[key].filter((entry) => !existing.has(entry.id))];
  }
  for (const model of merged.models) {
    const source = defaults.models.find((entry) => entry.id === model.id);
    if (source?.modelFamily && model.modelFamily === undefined) model.modelFamily = source.modelFamily;
  }
  if (merged.roleAgents) {
    for (const [role, bindings] of Object.entries(defaults.roleAgents)) {
      merged.roleAgents[role] ??= structuredClone(bindings);
      for (const adapter of ['antigravity', 'grok']) merged.roleAgents[role][adapter] ??= bindings[adapter];
    }
  }
  merged.learning ??= structuredClone(defaults.learning);
  validateConfig(merged);
  return merged;
}

export async function upgradeConfigFile({ configPath, check = true, defaultsPath = DEFAULT_CONFIG_PATH }) {
  const raw = await readFile(configPath, 'utf8');
  const current = JSON.parse(raw);
  const defaults = JSON.parse(await readFile(defaultsPath, 'utf8'));
  const merged = mergeFourCliConfig(current, defaults);
  const changed = JSON.stringify(current) !== JSON.stringify(merged);
  if (!changed || check) return { status: changed ? 'outdated' : 'current', configPath, changed,
    addedProviders: merged.providers.filter((entry) => !current.providers.some((old) => old.id === entry.id)).map((entry) => entry.id),
    addedModels: merged.models.filter((entry) => !current.models.some((old) => old.id === entry.id)).map((entry) => entry.id) };
  const backup = path.join(path.dirname(configPath), 'backups', `four-cli-${randomUUID()}`, 'config.json');
  await mkdir(path.dirname(backup), { recursive: true });
  await copyFile(configPath, backup);
  await writeJsonAtomic(configPath, merged);
  return { status: 'updated', configPath, changed: true, backup };
}
