import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadDefinitions, renderDefinitions } from './definitions.js';
import { contentHash, readOptional } from './definition-sync.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
async function entries(dir) {
  try { return (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function metadata(text, fallback) {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? text;
  const value = (key) => {
    const match = front.match(new RegExp(`^${key}\\s*[:=]\\s*(.+)$`, 'm'));
    if (!match) return undefined;
    const raw = match[1].trim();
    if (/^[>|][-+]?\s*$/.test(raw)) {
      const lines = front.slice(match.index + match[0].length).replace(/^\r?\n/, '').split(/\r?\n/);
      const block = [];
      for (const line of lines) { if (line && !/^\s/.test(line)) break; block.push(line.trim()); }
      return block.join(raw[0] === '>' ? ' ' : '\n').trim();
    }
    if (raw.startsWith('"')) { try { return JSON.parse(raw); } catch { /* YAML quoting fallback */ } }
    return raw.replace(/^['"]|['"]$/g, '');
  };
  return { name: value('name') ?? fallback, description: value('description') ?? '' };
}
function discovered(entry, provider) {
  return { installed: true, enabled: true, configuredEnabled: null, available: null, availabilityEvidence: 'disk; current host session not observed',
    discovered: true, syncStatus: 'unmanaged', ...entry, providers: [provider],
    bindings: { [provider]: { name: entry.name ?? entry.id, path: entry.path, mode: entry.mode ?? 'native', enabled: entry.enabled ?? true, sourceScope: entry.sourceScope, syncStatus: entry.syncStatus ?? 'unmanaged' } } };
}
async function scanSkills(dir, provider, meta = {}) {
  const found = [];
  for (const entry of await entries(dir)) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, 'SKILL.md');
    const raw = await readOptional(file);
    if (!raw) continue;
    const info = metadata(raw.toString('utf8'), entry.name);
    const name = ID.test(info.name) ? info.name : entry.name;
    const id = meta.namespace ? `${meta.namespace}:${name}` : name;
    if (!ID.test(id)) continue;
    const bridge = /aorch-generated:.*mode=bridge/.test(raw.toString('utf8'));
    found.push(discovered({ id, type: 'skill', description: info.description, sourceHash: contentHash(raw), path: path.dirname(file), ...meta, ...(bridge ? { mode: 'bridge', enabled: false } : {}) }, provider));
  }
  return found;
}
async function scanAgents(dir, provider, meta) {
  const found = [];
  for (const entry of await entries(dir)) {
    const unsupported = provider === 'openai' && meta.namespace && entry.name.endsWith('.md');
    if (!entry.isFile() || (!entry.name.endsWith(provider === 'anthropic' ? '.md' : '.toml') && !unsupported)) continue;
    const file = path.join(dir, entry.name);
    const text = await readFile(file, 'utf8');
    const localId = entry.name.replace(/\.(md|toml)$/, '');
    const info = metadata(text, localId);
    const id = meta.namespace ? `${meta.namespace}:${localId}` : localId;
    if (!ID.test(id)) continue;
    found.push(discovered({ id, name: meta.namespace ? `${meta.namespace}:${info.name}` : info.name, type: 'agent', description: info.description, sourceHash: contentHash(text), path: file, ...meta,
      ...(unsupported ? { enabled: false, supported: false, executionProviders: [], compatibility: 'Cached Claude agent format; no native Codex binding verified' } : {}),
      ...(/aorch-generated:.*mode=bridge/.test(text) ? { mode: 'bridge', enabled: false } : {}) }, provider));
  }
  return found;
}

// Only capability configuration is exposed. Never inspect auth files, env
// files, plugin data, or credential stores during inventory.
async function pluginSettings(root, provider) {
  const file = path.join(root, provider === 'anthropic' ? '.claude/settings.json' : '.codex/config.toml');
  const raw = await readOptional(file);
  if (!raw) return {};
  if (provider === 'anthropic') {
    try { return JSON.parse(raw).enabledPlugins ?? {}; } catch { return {}; }
  }
  const enabled = {};
  let plugin;
  for (const line of raw.toString('utf8').split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) plugin = line.match(/^\s*\[plugins\."([^"]+)"\]\s*$/)?.[1];
    if (plugin) {
      const value = line.match(/^\s*enabled\s*=\s*(true|false)\b/);
      if (value) enabled[plugin] = value[1] === 'true';
    }
  }
  return enabled;
}
async function scanPlugins(dir, provider, meta, settings, depth = 0, parts = []) {
  if (depth > 4) return [];
  const found = [];
  for (const entry of await entries(dir)) {
    if (!entry.isDirectory() || ['data', 'node_modules', '.git', '.plugin-appserver'].includes(entry.name)) continue;
    const root = path.join(dir, entry.name);
    let manifest;
    for (const relative of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'plugin.json']) {
      const raw = await readOptional(path.join(root, relative));
      if (raw) { try { manifest = JSON.parse(raw); } catch { /* report only valid metadata */ } break; }
    }
    if (!manifest) { found.push(...await scanPlugins(root, provider, meta, settings, depth + 1, [...parts, entry.name])); continue; }
    const name = ID.test(manifest.name ?? '') ? manifest.name : entry.name;
    const marketplace = parts[0] === 'cache' ? parts[1] : undefined;
    const id = marketplace ? `${name}@${marketplace}` : name;
    if (!ID.test(id)) continue;
    const configuredEnabled = Object.hasOwn(settings, id) ? settings[id] : Object.hasOwn(settings, name) ? settings[name] : null;
    const enabled = configuredEnabled === true;
    found.push(discovered({ id, type: 'plugin', description: manifest.description ?? '', path: root, version: manifest.version ?? entry.name,
      ...meta, enabled, configuredEnabled }, provider));
    found.push(...await scanSkills(path.join(root, 'skills'), provider, { ...meta, namespace: name, pluginId: id, enabled, configuredEnabled }));
    found.push(...await scanAgents(path.join(root, 'agents'), provider, { ...meta, namespace: name, pluginId: id, enabled, configuredEnabled }));
    found.push(...await scanHooks(root, provider, { ...meta, namespace: name, pluginId: id, enabled, configuredEnabled }, path.join(root, 'hooks/hooks.json')));
  }
  return found;
}
async function scanHooks(root, provider, meta, file = path.join(root, provider === 'anthropic' ? '.claude/settings.json' : '.codex/hooks.json')) {
  const raw = await readOptional(file);
  if (!raw) return [];
  let settings;
  try { settings = JSON.parse(raw); } catch { return []; }
  const found = [];
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) for (const hook of group.hooks ?? []) {
      const digest = contentHash(JSON.stringify({ event, group })).slice(0, 12);
      const supported = provider === 'anthropic' || hook.type === 'command';
      found.push(discovered({ id: `${provider}:${meta.namespace ? `${meta.namespace}:` : ''}${event}:${digest}`, type: 'hook', description: `${event} ${hook.type ?? 'unknown'} hook`, path: file,
        ...meta, enabled: supported && meta.enabled !== false && settings.disableAllHooks !== true, configuredEnabled: Object.hasOwn(meta, 'configuredEnabled') ? meta.configuredEnabled : settings.disableAllHooks !== true,
        supported, event, handlerType: hook.type }, provider));
    }
  }
  return found;
}

// Input order is precedence: project, user. Keep each provider's real source;
// same-name definitions are not proof that their bodies are equivalent.
function combine(entries) {
  const map = new Map();
  for (const entry of entries) {
    const key = `${entry.type}:${entry.id}`;
    if (!map.has(key)) { map.set(key, { ...entry, providers: [...(entry.providers ?? ['*'])], paths: entry.path ? [entry.path] : [], bindings: { ...entry.bindings }, origins: [{ path: entry.path, sourceScope: entry.sourceScope, providers: entry.providers, hash: entry.sourceHash }] }); continue; }
    const current = map.get(key);
    const shadowed = current.sourceScope !== entry.sourceScope;
    current.origins.push({ path: entry.path, sourceScope: entry.sourceScope, providers: entry.providers, hash: entry.sourceHash, shadowed, ...(entry.version ? { version: entry.version } : {}) });
    if (shadowed) continue;
    for (const provider of entry.providers ?? []) {
      if (current.bindings[provider] && (entry.type === 'plugin' || entry.pluginId) && current.bindings[provider].path !== entry.bindings?.[provider]?.path) {
        current.bindings[provider] = { ...current.bindings[provider], enabled: false, cacheSelection: 'ambiguous; choose a verified installed path before execution' };
      }
      if (!current.bindings[provider]) current.bindings[provider] = entry.bindings?.[provider];
      if (!current.providers.includes(provider)) current.providers.push(provider);
    }
    if (entry.path && !current.paths.includes(entry.path)) current.paths.push(entry.path);
    current.enabled = Object.values(current.bindings).some((binding) => binding?.enabled !== false && binding?.mode !== 'bridge');
  }
  return [...map.values()];
}

export async function discoverCapabilities({ cwd = process.cwd(), includeUser = true, homeDir = os.homedir(), packageRoot } = {}) {
  const found = [];
  for (const [root, sourceScope] of [[cwd, 'project'], ...(includeUser ? [[homeDir, 'user']] : [])]) {
    for (const provider of ['anthropic', 'openai']) {
      const meta = { sourceScope };
      const settings = await pluginSettings(root, provider);
      found.push(...await scanSkills(path.join(root, provider === 'anthropic' ? '.claude/skills' : '.agents/skills'), provider, meta));
      if (provider === 'openai') found.push(...await scanSkills(path.join(root, '.codex/skills'), provider, meta));
      found.push(...await scanAgents(path.join(root, provider === 'anthropic' ? '.claude/agents' : '.codex/agents'), provider, meta));
      found.push(...await scanPlugins(path.join(root, provider === 'anthropic' ? '.claude/plugins' : '.codex/plugins'), provider, meta, settings));
      found.push(...await scanHooks(root, provider, meta));
    }
  }
  const combined = combine(found);
  const definitions = await loadDefinitions({ cwd, includeUser, ...(packageRoot ? { packageRoot } : {}) });
  const rendered = await renderDefinitions({ definitions, ...(packageRoot ? { packageRoot } : {}) });
  for (const definition of definitions) {
    let current = combined.find((entry) => entry.id === definition.id && entry.type === definition.type);
    if (!current && definition.sourceScope === 'shared') continue;
    if (current?.sourceScope === 'project' && definition.sourceScope === 'user') continue;
    if (!current) { current = { id: definition.id, type: definition.type, paths: [], bindings: {}, available: null }; combined.push(current); }
    const originalScope = current.sourceScope;
    current.nativeProviders = definition.nativeProviders;
    current.executionProviders = definition.executionProviders;
    current.providers = definition.nativeProviders;
    current.sourcePath = definition.sourcePath;
    current.manifestPath = definition.manifestPath;
    current.sourceScope = definition.sourceScope;
    current.description = definition.description;
    current.compatibility = definition.compatibility;
    for (const provider of ['anthropic', 'openai']) {
      const definitionRoot = definition.sourceScope === 'user' || (definition.sourceScope === 'shared' && originalScope === 'user') ? homeDir : cwd;
      const ledgerRaw = await readOptional(path.join(definitionRoot, definitionRoot === homeDir ? '.aorch/generated-user-files.json' : '.aorch/generated-files.json'));
      let ledger;
      if (ledgerRaw) { try { ledger = JSON.parse(ledgerRaw); } catch { /* unknown sync state */ } }
      const files = rendered.filter((file) => file.definitionId === `${definition.type}:${definition.id}` && file.provider === provider);
      const entry = files.find((file) => definition.type === 'agent' || file.path.endsWith('/SKILL.md'));
      const disk = entry ? await readOptional(path.join(definitionRoot, entry.path)) : null;
      const actual = disk ? contentHash(disk) : null;
      const expected = entry ? contentHash(entry.content) : null;
      const recorded = entry && ledger?.files?.[entry.path]?.hash;
      let syncStatus = actual === null ? 'not-installed' : actual === expected ? 'current' : recorded && actual !== recorded ? 'conflict' : 'stale';
      if (syncStatus === 'current') {
        for (const asset of files) {
          const content = await readOptional(path.join(definitionRoot, asset.path));
          const hash = content === null ? null : contentHash(content);
          if (hash !== contentHash(asset.content)) {
            syncStatus = hash !== null && ledger?.files?.[asset.path] && hash !== ledger.files[asset.path].hash ? 'conflict' : 'stale';
            break;
          }
        }
      }
      current.bindings[provider] = { name: definition.bindings[provider].name, path: entry ? path.join(definitionRoot, definition.type === 'skill' ? path.dirname(entry.path) : entry.path) : null,
        mode: definition.bindings[provider].mode, enabled: actual !== null, syncStatus, installed: actual !== null, settings: definition.bindings[provider].settings };
    }
    current.installed = Object.values(current.bindings).some((binding) => binding.installed);
    current.enabled = current.installed;
    current.syncStatus = Object.values(current.bindings).some((binding) => binding.syncStatus === 'conflict') ? 'conflict'
      : Object.values(current.bindings).every((binding) => binding.syncStatus === 'current') ? 'current' : 'stale';
  }
  return combined;
}

export function mergeCapabilities(configured = [], discovered = []) {
  const actual = new Map(discovered.map((entry) => [`${entry.type}:${entry.id}`, entry]));
  const merged = configured.map((entry) => {
    const key = `${entry.type}:${entry.id}`;
    const found = actual.get(key);
    if (!found) return { ...entry };
    actual.delete(key);
    return { ...entry, ...found, ...(entry.enabled === false ? { enabled: false } : {}), description: found.description || entry.description };
  });
  return [...merged, ...actual.values()];
}
export function getInventory(config, { runtime = [] } = {}) {
  const observed = new Set(runtime);
  const capabilities = config.capabilities.map(({ scope: _scope, ...entry }) => ({ ...entry,
    ...(entry.bindings ? { bindings: Object.fromEntries(Object.entries(entry.bindings).map(([provider, binding]) => [provider, {
      ...binding, ...(binding.settings ? { settings: Object.fromEntries(Object.entries(binding.settings).filter(([key]) => ['model', 'model_reasoning_effort', 'sandbox_mode'].includes(key))) } : {})
    }])) } : {}),
    ...(observed.has(entry.id) ? { available: true, availabilityEvidence: 'explicit current-session snapshot' } : {}),
    description: typeof entry.description === 'string' ? entry.description.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) : '',
    descriptionUsage: 'metadata-only' }));
  return { providers: config.providers.filter((entry) => entry.enabled !== false), models: config.models.filter((entry) => entry.enabled !== false), capabilities };
}
