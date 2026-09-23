import { readFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG_PATH, validateConfig } from './config.js';
import { writeJsonAtomic } from './fs-util.js';

const SYNCED_ON_MODEL_CHANGE = ['model', 'enabled', 'maturity', 'metadata',
  'validatedTaskKinds', 'validatedComplexities', 'validatedRisks', 'validatedTaskTags'];

// This explicit migration adds new defaults, never replaces user tuning —
// with two exceptions that keep an installed copy runnable. When the packaged
// profile moved to a new model string or was retired, the old string names a
// model the CLI no longer offers, so identity fields follow the package.
// Efforts carrying the removed quotaGate are dropped (validateConfig refuses
// them), and packaged efforts the copy lacks are added so allocation rules
// naming them (e.g. claude-opus-deep:medium) validate in every project.
export function mergeFourCliConfig(current, defaults) {
  const merged = structuredClone(current);
  for (const key of ['providers', 'models']) {
    const existing = new Set((merged[key] ?? []).map((entry) => entry.id));
    merged[key] = [...(merged[key] ?? []), ...defaults[key].filter((entry) => !existing.has(entry.id))];
  }
  for (const model of merged.models) {
    model.efforts = (model.efforts ?? []).filter((effort) => effort.quotaGate === undefined);
    const source = defaults.models.find((entry) => entry.id === model.id);
    if (!source) continue;
    if (source.modelFamily && model.modelFamily === undefined) model.modelFamily = source.modelFamily;
    if (source.model !== model.model || (source.enabled === false && model.enabled !== false)) {
      for (const field of SYNCED_ON_MODEL_CHANGE) {
        if (source[field] === undefined) delete model[field];
        else model[field] = structuredClone(source[field]);
      }
    }
    const names = new Set(model.efforts.map((effort) => effort.name));
    model.efforts.push(...structuredClone(source.efforts ?? []).filter((effort) => !names.has(effort.name)));
  }
  if (defaults.escalation?.diagnosis) {
    merged.escalation ??= {};
    merged.escalation.diagnosis ??= structuredClone(defaults.escalation.diagnosis);
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
    addedModels: merged.models.filter((entry) => !current.models.some((old) => old.id === entry.id)).map((entry) => entry.id),
    syncedModels: merged.models.filter((entry) => current.models.some((old) => old.id === entry.id && old.model !== entry.model)).map((entry) => `${entry.id}=${entry.model}`) };
  const backup = path.join(path.dirname(configPath), 'backups', `four-cli-${randomUUID()}`, 'config.json');
  await mkdir(path.dirname(backup), { recursive: true });
  await copyFile(configPath, backup);
  await writeJsonAtomic(configPath, merged);
  return { status: 'updated', configPath, changed: true, backup };
}
