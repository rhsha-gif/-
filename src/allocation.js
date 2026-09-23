import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { userHome } from './install-registry.js';

// The user's hand-tuned model allocation. One global file, read at route time,
// so a change applies to every registered project without a reinstall. It only
// orders candidates that already passed every safety filter (see
// applyAllocation in router.js); priors, efforts and enablement stay in the
// catalog.
const COMPLEXITIES = ['low', 'standard', 'high', 'critical'];
const RULE_KEYS = new Set(['id', 'match', 'prefer']);
const MATCH_KEYS = new Set(['kinds', 'complexities', 'tags']);

export function allocationPath({ homeDir = userHome() } = {}) {
  return path.join(homeDir, 'allocation.json');
}

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${field} must be a non-empty array of strings`);
  }
  return value;
}

export function validateAllocation(input, catalog) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('must be a JSON object');
  const unknownTop = Object.keys(input).filter((key) => !['version', 'rules'].includes(key));
  if (unknownTop.length) throw new Error(`unknown key(s): ${unknownTop.join(', ')}`);
  if (input.version !== 1) throw new Error('version must be 1');
  if (!Array.isArray(input.rules)) throw new Error('rules must be an array');
  const profiles = new Map((catalog.models ?? []).map((model) => [model.id, model]));
  const ids = new Set();
  for (const [index, rule] of input.rules.entries()) {
    const at = `rules[${index}]`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`${at} must be an object`);
    const unknown = Object.keys(rule).filter((key) => !RULE_KEYS.has(key));
    if (unknown.length) throw new Error(`${at} has unknown key(s): ${unknown.join(', ')}`);
    if (typeof rule.id !== 'string' || rule.id.trim() === '') throw new Error(`${at}.id must be a non-empty string`);
    if (ids.has(rule.id)) throw new Error(`duplicate rule id ${rule.id}`);
    ids.add(rule.id);
    const match = rule.match ?? {};
    if (typeof match !== 'object' || Array.isArray(match)) throw new Error(`${at}.match must be an object`);
    const unknownMatch = Object.keys(match).filter((key) => !MATCH_KEYS.has(key));
    if (unknownMatch.length) throw new Error(`${at}.match has unknown key(s): ${unknownMatch.join(', ')}`);
    for (const key of Object.keys(match)) stringList(match[key], `${at}.match.${key}`);
    const badComplexity = (match.complexities ?? []).filter((value) => !COMPLEXITIES.includes(value));
    if (badComplexity.length) throw new Error(`${at}.match.complexities has unknown value(s): ${badComplexity.join(', ')}`);
    for (const entry of stringList(rule.prefer, `${at}.prefer`)) {
      const [profileId, effort, extra] = entry.split(':');
      const profile = profiles.get(profileId);
      if (!profile || extra !== undefined) throw new Error(`${at}.prefer entry ${entry} does not name a catalog profile`);
      if (effort !== undefined && !(profile.efforts ?? []).some((item) => item.name === effort)) {
        throw new Error(`${at}.prefer entry ${entry}: profile ${profileId} has no effort ${effort}`);
      }
    }
  }
  return input;
}

// Missing file: no rules, routing unchanged. Anything else wrong fails closed
// with the path, because a silently ignored rule would route work somewhere
// the user did not choose.
export async function loadAllocation({ catalog, homeDir } = {}) {
  const file = allocationPath({ homeDir });
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`allocation ${file}: ${error.message}`);
  }
  try {
    return validateAllocation(JSON.parse(raw), catalog);
  } catch (error) {
    throw new Error(`allocation ${file}: ${error.message}`);
  }
}
