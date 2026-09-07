import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveWindowsCommandSpec, runCommand } from './executor.js';

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
    const localId = safeCapabilityId(meta.name, entry.name);
    if (!localId) continue;
    const id = metadata.pluginName ? safeCapabilityId(`${metadata.pluginName}:${localId}`) : localId;
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
  const registry = await readMetadata(path.join(baseDir, 'installed_plugins.json'));
  const disabledIds = new Set(Object.entries(registry?.plugins ?? {}).filter(([, entries]) =>
    (Array.isArray(entries) ? entries : [entries]).some(record => record?.enabled === false || record?.active === false)
  ).map(([id]) => id));
  const results = [];
  for (const entry of await readdir(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || ['cache', 'marketplaces', 'data'].includes(entry.name)) continue;
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
      if (manifest?.enabled === false || manifest?.active === false) continue;
      const id = safeCapabilityId(manifest.name, entry.name);
      if (!id || disabledIds.has(id)) continue;
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
  results.push(...await scanInstalledPlugins(baseDir, provider, metadata, registry, disabledIds));
  return results;
}

async function readMetadata(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

// Read only installation/manifest metadata, never host config or credentials.
// An install location or remote ID alone does not prove current activation.
function isActive(record) {
  return record && record.enabled !== false && record.active !== false
    && (record.enabled === true || record.active === true);
}

async function installedPlugin(root, id, provider, metadata) {
  let manifest;
  for (const name of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'plugin.json']) {
    const manifestPath = path.join(root, name);
    const candidate = await readMetadata(manifestPath);
    if (!candidate || candidate.enabled === false || candidate.active === false) {
      if (metadata.allowManifestless && await exists(manifestPath)) return [];
      continue;
    }
    manifest = candidate;
    break;
  }
  if (!manifest && metadata.allowManifestless) {
    // The CLI confirms activation for inline marketplace packages such as LSPs;
    // an existing directory confirms the payload, not executable/tool support.
    try { if ((await stat(root)).isDirectory()) manifest = { name: id.split('@')[0] }; } catch { /* Missing payload. */ }
  }
  if (!manifest || (metadata.expectedName && manifest.name !== metadata.expectedName)) return [];
  const pluginId = safeCapabilityId(id);
  const pluginName = safeCapabilityId(manifest.name);
  if (!pluginId || !pluginName) return [];
  return [{ id: pluginId, type: 'plugin', description: manifest.description ?? '',
    providers: [provider], enabled: true, path: root, discovered: true,
    sourceScope: metadata.sourceScope ?? 'project' },
  ...await scanSkills(path.join(root, 'skills'), provider, { ...metadata, pluginName })];
}

async function scanInstalledPlugins(baseDir, provider, metadata, registry, disabledIds) {
  const results = [];
  if (registry?.plugins && typeof registry.plugins === 'object' && !Array.isArray(registry.plugins)) {
    for (const [id, entries] of Object.entries(registry.plugins)) {
      if (disabledIds.has(id)) continue;
      for (const record of Array.isArray(entries) ? entries : [entries]) {
        if (!isActive(record)) continue;
        const location = record.installPath ?? record.install_path;
        if (typeof location !== 'string' || !location.trim()) continue;
        results.push(...await installedPlugin(path.resolve(baseDir, location), id, provider, metadata));
      }
    }
  }
  // Cache layouts may nest marketplace/package/version. Explicit active markers
  // are supported; ordinary cache manifests and ID-only markers are ignored.
  async function scanCache(root, depth) {
    if (depth > 4 || !(await exists(root))) return;
    for (const name of ['.codex-remote-plugin-install.json', '.codex-marketplace-install.json']) {
      const record = await readMetadata(path.join(root, name));
      if (!isActive(record)) continue;
      const id = record.id ?? record.plugin_id ?? record.remote_plugin_id;
      if (disabledIds.has(id)) continue;
      const location = record.installPath ?? record.install_path ?? '.';
      if (typeof location !== 'string') continue;
      results.push(...await installedPlugin(path.resolve(root, location), id, provider, metadata));
    }
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) await scanCache(path.join(root, entry.name), depth + 1);
    }
  }
  await scanCache(path.join(baseDir, 'cache'), 0);
  return results;
}

async function cliPluginMetadata(options, cwd, command) {
  try {
    let value = options[`${command}PluginList`];
    if (value === undefined) {
      // A fixture home must never launch the real user's CLI implicitly.
      const runner = options[`${command}PluginRunner`];
      if (Object.hasOwn(options, 'homeDir') && !runner) return null;
      const spec = { command, args: ['plugin', 'list', '--json'] };
      const result = await (runner ?? runCommand)(
        runner ? spec : resolveWindowsCommandSpec(spec), { cwd, timeoutMs: 5000 });
      if (result?.exitCode !== 0 || result.timedOut) return null;
      value = result.stdout;
    }
    if (typeof value === 'string') value = JSON.parse(value);
    if (command === 'claude') return Array.isArray(value) ? value : null;
    return value && Array.isArray(value.installed) ? value : null;
  } catch { return null; }
}

async function scanClaudeCliPlugins(listing) {
  const results = [];
  // Claude lists installed records directly; enabled is its activation signal.
  for (const record of listing) {
    if (record?.enabled !== true || !safeCapabilityId(record.id) || !safeCacheSegment(record.version)
      || !['user', 'project', 'local'].includes(record.scope)) continue;
    const location = record.installPath;
    if (typeof location !== 'string' || /[\u0000-\u001f]/.test(location) || !path.isAbsolute(location)) continue;
    results.push(...await installedPlugin(path.resolve(location), record.id, 'anthropic', {
      sourceScope: record.scope === 'user' ? 'user' : 'project', allowManifestless: true
    }));
  }
  return results;
}

function safeCacheSegment(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    && !value.endsWith('.');
}

async function scanCodexCliPlugins(codexHome, listing) {
  const results = [];
  for (const record of listing.installed) {
    if (record?.installed !== true || record.enabled !== true) continue;
    if (!safeCacheSegment(record.name) || !safeCacheSegment(record.marketplaceName)
      || !safeCacheSegment(record.version) || !safeCapabilityId(record.pluginId)) continue;
    const metadata = { sourceScope: 'user' };
    let root;
    if (record.source?.source === 'local') {
      const location = record.source.path;
      if (typeof location !== 'string' || /[\u0000-\u001f]/.test(location) || !path.isAbsolute(location)) continue;
      root = path.resolve(location);
      const local = await installedPlugin(root, record.pluginId, 'openai', metadata);
      if (local.length) {
        results.push(...local);
        continue;
      }
      // Marketplace source directories may be temporary; the exact installed
      // cache is usable only when its manifest confirms the listed identity.
      root = path.join(codexHome, 'plugins/cache', record.marketplaceName, record.name, record.version);
      metadata.expectedName = record.name;
    } else if (['remote', 'git'].includes(record.source?.source)) {
      // Use only the exact installed version; other cached versions prove nothing.
      root = path.join(codexHome, 'plugins/cache', record.marketplaceName, record.name, record.version);
      if (record.source.source === 'remote') {
        if (typeof record.source.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_~.-]{0,255}$/.test(record.source.id)) continue;
        const markerPath = path.join(root, '.codex-remote-plugin-install.json');
        if (await exists(markerPath)) {
          const marker = await readMetadata(markerPath);
          if ((marker?.remote_plugin_id ?? marker?.plugin_id ?? marker?.id) !== record.source.id) continue;
        }
      }
    } else continue;
    results.push(...await installedPlugin(root, record.pluginId, 'openai', metadata));
  }
  return results;
}

function combine(entries) {
  const map = new Map();
  for (const entry of entries) {
    const key = `${entry.type}:${entry.id}`;
    const current = map.get(key);
    if (!current) {
      const paths = entry.paths ?? (entry.path ? [entry.path] : []);
      const providerPaths = entry.providerPaths ?? Object.fromEntries(
        (entry.providers ?? ['*']).map(provider => [provider, [...paths]])
      );
      map.set(key, { ...entry, providers: [...new Set(entry.providers ?? ['*'])], paths: [...paths], providerPaths: structuredClone(providerPaths) });
      continue;
    }
    current.providers = [...new Set([...current.providers, ...(entry.providers ?? [])])];
    if (entry.path && !current.paths.includes(entry.path)) current.paths.push(entry.path);
    for (const provider of entry.providers ?? ['*']) {
      const paths = entry.providerPaths?.[provider] ?? entry.paths ?? (entry.path ? [entry.path] : []);
      current.providerPaths[provider] = [...new Set([...(current.providerPaths[provider] ?? []), ...paths])];
    }
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

export async function discoverCapabilities(options = {}) {
  const { cwd = process.cwd(), includeUser = true, homeDir = os.homedir() } = options;
  const configuredHome = !Object.hasOwn(options, 'homeDir') ? process.env.CODEX_HOME : undefined;
  const codexHome = typeof configuredHome === 'string' && path.isAbsolute(configuredHome)
    && !/[\u0000-\u001f]/.test(configuredHome) ? path.resolve(configuredHome) : path.join(homeDir, '.codex');
  const [listing, claudeListing] = includeUser ? await Promise.all([
    cliPluginMetadata(options, cwd, 'codex'), cliPluginMetadata(options, cwd, 'claude')
  ]) : [null, null];
  const roots = [
    [path.join(cwd, '.claude/skills'), 'anthropic', scanSkills, { sourceScope: 'project' }],
    [path.join(cwd, '.agents/skills'), 'openai', scanSkills, { sourceScope: 'project' }],
    [path.join(cwd, '.codex/skills'), 'openai', scanSkills, { sourceScope: 'project' }],
    [path.join(cwd, '.claude/plugins'), 'anthropic', scanPluginDirectory, { sourceScope: 'project' }],
    [path.join(cwd, '.codex/plugins'), 'openai', scanPluginDirectory, { sourceScope: 'project' }]
  ];
  if (includeUser) {
    roots.push(
      [path.join(homeDir, '.claude/skills'), 'anthropic', scanSkills, { sourceScope: 'user' }],
      [path.join(homeDir, '.agents/skills'), 'openai', scanSkills, { sourceScope: 'user' }],
      [path.join(codexHome, 'skills'), 'openai', scanSkills, { sourceScope: 'user' }],
      claudeListing ? [homeDir, 'anthropic', () => scanClaudeCliPlugins(claudeListing), { sourceScope: 'user' }]
        : [path.join(homeDir, '.claude/plugins'), 'anthropic', scanPluginDirectory, { sourceScope: 'user' }],
      listing ? [codexHome, 'openai', () => scanCodexCliPlugins(codexHome, listing), { sourceScope: 'user' }]
        : [path.join(codexHome, 'plugins'), 'openai', scanPluginDirectory, { sourceScope: 'user' }]
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
