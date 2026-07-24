import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

function parseFrontmatter(markdown, fallbackId) {
  const block = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
  const content = block?.[1] ?? '';
  const name = content.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? fallbackId;
  const description = content.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
  return { name, description };
}

const CAPABILITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

function safeCapabilityId(value, fallback) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (CAPABILITY_ID_PATTERN.test(candidate)) return candidate;

  const fallbackCandidate = typeof fallback === 'string' ? fallback.trim() : '';
  return CAPABILITY_ID_PATTERN.test(fallbackCandidate) ? fallbackCandidate : null;
}

async function scanSkills(baseDir, provider, metadata = {}) {
  if (!(await exists(baseDir))) return [];
  const results = [];
  for (const entry of await readdir(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(baseDir, entry.name, 'SKILL.md');
    if (!(await exists(skillPath))) continue;
    const meta = parseFrontmatter(await readFile(skillPath, 'utf8'), entry.name);
    const id = safeCapabilityId(meta.name, entry.name);
    if (!id) continue;
    results.push({
      id,
      type: 'skill',
      description: meta.description,
      providers: [provider],
      enabled: true,
      path: path.dirname(skillPath),
      discovered: true,
      sourceScope: metadata.sourceScope ?? 'project'
    });
  }
  return results;
}

async function scanPluginDirectory(baseDir, provider, metadata = {}) {
  if (!(await exists(baseDir))) return [];
  const results = [];
  for (const entry of await readdir(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = path.join(baseDir, entry.name);
    const candidates = [
      path.join(root, '.claude-plugin/plugin.json'),
      path.join(root, '.codex-plugin/plugin.json'),
      path.join(root, 'plugin.json')
    ];
    const manifestPath = await (async () => {
      for (const candidate of candidates) if (await exists(candidate)) return candidate;
      return null;
    })();
    if (!manifestPath) continue;
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const id = safeCapabilityId(manifest.name, entry.name);
      if (!id) continue;
      results.push({
        id,
        type: 'plugin',
        description: manifest.description ?? '',
        providers: [provider],
        enabled: true,
        path: root,
        discovered: true,
        sourceScope: metadata.sourceScope ?? 'project'
      });
    } catch {
      // Ignore malformed third-party manifests; doctor/inventory must not break the whole run.
    }
  }
  return results;
}

function combine(entries) {
  const map = new Map();
  for (const entry of entries) {
    const key = `${entry.type}:${entry.id}`;
    const current = map.get(key);
    if (!current) {
      map.set(key, { ...entry, providers: [...new Set(entry.providers ?? ['*'])], paths: entry.path ? [entry.path] : [] });
      continue;
    }
    current.providers = [...new Set([...current.providers, ...(entry.providers ?? [])])];
    if (entry.path && !current.paths.includes(entry.path)) current.paths.push(entry.path);
    current.path ??= entry.path;
    current.description ||= entry.description;
    current.enabled = current.enabled || entry.enabled;
    if (current.sourceScope !== entry.sourceScope) current.sourceScope = 'mixed';
  }
  return [...map.values()];
}

function sanitizeDescription(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function inventoryCapability(entry) {
  return {
    ...entry,
    description: sanitizeDescription(entry.description),
    descriptionUsage: 'metadata-only'
  };
}

export async function discoverCapabilities({ cwd = process.cwd(), includeUser = true, homeDir = os.homedir() } = {}) {
  const roots = [
    [path.join(cwd, '.claude/skills'), 'anthropic', scanSkills, { sourceScope: 'project' }],
    [path.join(cwd, '.agents/skills'), 'openai', scanSkills, { sourceScope: 'project' }],
    [path.join(cwd, '.claude/plugins'), 'anthropic', scanPluginDirectory, { sourceScope: 'project' }],
    [path.join(cwd, '.codex/plugins'), 'openai', scanPluginDirectory, { sourceScope: 'project' }]
  ];
  if (includeUser) {
    roots.push(
      [path.join(homeDir, '.claude/skills'), 'anthropic', scanSkills, { sourceScope: 'user' }],
      [path.join(homeDir, '.agents/skills'), 'openai', scanSkills, { sourceScope: 'user' }],
      [path.join(homeDir, '.claude/plugins'), 'anthropic', scanPluginDirectory, { sourceScope: 'user' }],
      [path.join(homeDir, '.codex/plugins'), 'openai', scanPluginDirectory, { sourceScope: 'user' }]
    );
  }
  const groups = await Promise.all(roots.map(([root, provider, scanner, metadata]) => scanner(root, provider, metadata)));
  return combine(groups.flat());
}

export function mergeCapabilities(configured = [], discovered = []) {
  const discoveredMap = new Map(discovered.map((entry) => [`${entry.type}:${entry.id}`, entry]));
  const merged = configured.map((entry) => {
    const actual = discoveredMap.get(`${entry.type}:${entry.id}`);
    if (!actual) return { ...entry };
    discoveredMap.delete(`${entry.type}:${entry.id}`);
    return {
      ...entry,
      ...actual,
      description: actual.description || entry.description,
      providers: actual.providers,
      enabled: true
    };
  });
  return combine([...merged, ...discoveredMap.values()]);
}

export function getInventory(config) {
  return {
    providers: config.providers.filter((entry) => entry.enabled !== false),
    models: config.models.filter((entry) => entry.enabled !== false),
    capabilities: config.capabilities.filter((entry) => entry.enabled !== false).map(inventoryCapability)
  };
}
