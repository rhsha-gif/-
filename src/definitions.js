import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertScopedFile, scopedPath, readOptional } from './definition-sync.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDERS = ['anthropic', 'openai'];
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
const SETTINGS = {
  anthropic: new Set(['name', 'model', 'effort', 'maxTurns', 'disallowedTools', 'tools', 'permissionMode', 'skills', 'mcpServers', 'hooks', 'memory', 'isolation', 'ship_triggers']),
  openai: new Set(['name', 'model', 'model_reasoning_effort', 'sandbox_mode'])
};

export function stripFrontmatter(text) { return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim(); }

async function sourcePath(scope, manifest, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || /^[A-Za-z]:|^[/\\]/.test(relative)) throw new Error(`Invalid definition source: ${relative}`);
  const resolved = path.resolve(path.dirname(manifest), relative);
  const safe = scopedPath(scope, path.relative(scope, resolved));
  await assertScopedFile(scope, safe);
  return safe;
}

export async function loadDefinitions({ cwd = process.cwd(), packageRoot = PACKAGE_ROOT, includeUser = false, includeShared = true } = {}) {
  const manifests = [
    ...(includeShared ? [[path.join(packageRoot, 'integrations/shared/definitions.json'), packageRoot, 'shared']] : []),
    ...(includeUser ? [[path.join(packageRoot, 'integrations/user/definitions.json'), packageRoot, 'user']] : []),
    [path.join(cwd, '.agents/aorch/definitions.json'), cwd, 'project']
  ];
  const definitions = new Map();
  for (const [manifestPath, scope, sourceScope] of manifests) {
    const raw = await readOptional(manifestPath);
    if (!raw) continue;
    await assertScopedFile(scope, manifestPath);
    const manifest = JSON.parse(raw);
    if (manifest.version !== 1) throw new Error(`Unsupported definition manifest: ${manifestPath}`);
    const seen = new Set();
    for (const type of ['agent', 'skill']) {
      const entries = manifest[`${type}s`] ?? [];
      if (!Array.isArray(entries)) throw new Error(`${type}s must be an array: ${manifestPath}`);
      for (const entry of entries) {
        const key = `${type}:${entry.id}`;
        if (!ID.test(entry.id) || seen.has(key) || typeof entry.description !== 'string' || !entry.description.trim()) throw new Error(`Invalid or duplicate definition: ${key}`);
        seen.add(key);
        const nativeProviders = type === 'agent' ? Object.keys(entry.providers ?? {}) : entry.providers;
        if (!Array.isArray(nativeProviders) || !nativeProviders.length || nativeProviders.some((p) => !PROVIDERS.includes(p))) throw new Error(`Invalid providers for ${key}`);
        const executionProviders = entry.executionProviders ?? nativeProviders;
        if (!Array.isArray(executionProviders) || executionProviders.some((provider) => !nativeProviders.includes(provider))) throw new Error(`Invalid execution providers for ${key}`);
        const canonicalPath = await sourcePath(scope, manifestPath, type === 'agent' ? entry.instructions : entry.source);
        const bindings = {};
        for (const provider of PROVIDERS) {
          const native = nativeProviders.includes(provider);
          const config = native ? (type === 'agent' ? entry.providers[provider] : entry.providerSettings?.[provider] ?? {}) : {};
          if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`Invalid binding: ${key}/${provider}`);
          const settings = { ...config };
          delete settings.instructions;
          for (const field of Object.keys(settings)) if (!SETTINGS[provider].has(field)) throw new Error(`Unsupported ${provider} agent setting: ${field}`);
          const name = settings.name ?? (type === 'agent' && provider === 'openai' ? entry.id.replaceAll('-', '_') : entry.id);
          if (!ID.test(name)) throw new Error(`Invalid provider name: ${name}`);
          const instructionsPath = config.instructions ? await sourcePath(scope, manifestPath, config.instructions) : canonicalPath;
          bindings[provider] = { name, settings, mode: native ? 'native' : 'bridge', instructionsPath,
            ...(type === 'agent' && native ? { instructions: stripFrontmatter(await readFile(instructionsPath, 'utf8')) } : {}) };
        }
        definitions.set(key, { id: entry.id, type, description: entry.description, sourceScope, sourcePath: canonicalPath, manifestPath,
          nativeProviders: [...nativeProviders], executionProviders: [...executionProviders], providers: [...nativeProviders], bindings,
          installed: false, enabled: true, available: null, syncStatus: 'not-installed', scope, ...(entry.compatibility ? { compatibility: entry.compatibility } : {}) });
      }
    }
  }
  return [...definitions.values()];
}

function bridgeText(definition) {
  const selection = definition.type === 'agent' ? `agentId: ${definition.id}` : `capabilityIds: [${definition.id}]`;
  return `# ${definition.id}\n\n${definition.description}\n\nThis definition requires ${definition.executionProviders.join(' or ')}. Before execution, the lead must select ${selection} in an aorch task and route it to a supported provider. Use aorch inventory and dispatch --dry-run to check availability. If that provider is unavailable, return blocked with the needed action. Do not simulate the missing feature, grant approval, or delegate again from a worker. Return any question to the lead as inputRequest.\n`;
}

function tomlString(value) { return JSON.stringify(value); }
function tomlInstructions(text) { return `"""\n${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}\n"""`; }

function projectSkillLinks(text, definition, relative, destination) {
  if (definition.sourceScope !== 'project') return text;
  return text.replace(/(\[[^\]]*\]\()([^\s)]+)(\))/g, (whole, before, link, after) => {
    if (!link.startsWith('.')) return whole;
    const [file, ...fragment] = link.split('#');
    const resolved = path.resolve(path.dirname(path.join(definition.sourcePath, relative)), decodeURIComponent(file));
    const inSkill = path.relative(definition.sourcePath, resolved);
    if (inSkill !== '..' && !inSkill.startsWith(`..${path.sep}`)) return whole;
    const rebound = path.relative(path.dirname(path.join(definition.scope, destination)), resolved).replaceAll('\\', '/');
    return `${before}${rebound}${fragment.length ? `#${fragment.join('#')}` : ''}${after}`;
  });
}

async function skillFiles(root, dir = root) {
  const files = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (/^(desktop\.ini|thumbs\.db|\.DS_Store)$/i.test(entry.name)) continue;
    if (entry.name === '.git' || entry.name === 'node_modules' || /^\.env(?:\.|$)/.test(entry.name)) continue;
    const file = scopedPath(root, path.relative(root, path.join(dir, entry.name)));
    await assertScopedFile(root, file);
    if (entry.isSymbolicLink()) throw new Error(`Skill assets cannot be symlinks: ${file}`);
    if (entry.isDirectory()) files.push(...await skillFiles(root, file));
    else files.push({ relative: path.relative(root, file).replaceAll('\\', '/'), content: await readFile(file) });
  }
  return files;
}

// One common body, native settings at the boundary. Bridge files expose names
// without falsely advertising support for a provider-specific capability.
export async function renderDefinitions({ definitions, target = 'both', packageRoot = PACKAGE_ROOT, resolveRoot = true }) {
  if (!['both', 'claude', 'codex'].includes(target)) throw new Error(`Unknown target: ${target}`);
  const files = [];
  for (const definition of definitions) {
    for (const provider of PROVIDERS) {
      if (target !== 'both' && target !== (provider === 'openai' ? 'codex' : 'claude')) continue;
      const binding = definition.bindings[provider];
      const native = binding.mode === 'native';
      const origin = `aorch-generated: ${definition.type}:${definition.id}; mode=${binding.mode}; edit ${definition.sourceScope === 'project' ? '.agents/aorch/definitions.json' : `integrations/${definition.sourceScope}/definitions.json`}`;
      const metadata = { definitionId: `${definition.type}:${definition.id}`, provider, mode: binding.mode };
      if (definition.type === 'agent') {
        const body = native ? binding.instructions : bridgeText(definition);
        const settings = native ? binding.settings : provider === 'openai' ? { sandbox_mode: 'read-only' } : { tools: [], disallowedTools: 'Write, Edit, NotebookEdit, Bash, PowerShell, Agent' };
        if (provider === 'anthropic') {
          const fields = Object.entries({ name: binding.name, description: definition.description, ...settings })
            .map(([key, value]) => `${key}: ${typeof value === 'string' && !/[\n:#{}\[\]"']/.test(value) ? value : JSON.stringify(value)}`).join('\n');
          files.push({ path: `.claude/agents/${definition.id}.md`, content: `---\n${fields}\n---\n\n<!-- ${origin} -->\n\n${body}\n`, ...metadata });
        } else {
          const fields = Object.entries({ name: binding.name, description: definition.description, ...settings }).map(([key, value]) => `${key} = ${tomlString(value)}`).join('\n');
          files.push({ path: `.codex/agents/${definition.id}.toml`, content: `# ${origin}\n${fields}\ndeveloper_instructions = ${tomlInstructions(body)}\n`, ...metadata });
        }
      } else {
        const prefix = `${provider === 'anthropic' ? '.claude' : '.agents'}/skills/${definition.id}`;
        const assets = native ? await skillFiles(definition.sourcePath) : [{ relative: 'SKILL.md', content: Buffer.from(`---\nname: ${definition.id}\ndescription: ${JSON.stringify(definition.description)}\n---\n\n${bridgeText(definition)}`) }];
        if (!assets.some((file) => file.relative === 'SKILL.md')) throw new Error(`Missing SKILL.md: ${definition.sourcePath}`);
        for (const asset of assets) {
          let content = asset.content;
          if (native && asset.relative.endsWith('.md')) content = Buffer.from(projectSkillLinks(content.toString('utf8'), definition, asset.relative, `${prefix}/${asset.relative}`));
          if (resolveRoot && /\.(?:md|mjs|js|json|toml)$/.test(asset.relative)) content = Buffer.from(content.toString('utf8').replaceAll('{{AORCH_ROOT}}', packageRoot.replaceAll('\\', '/')));
          if (asset.relative === 'SKILL.md') {
            let text = content.toString('utf8');
            const fields = Object.entries(binding.settings).filter(([key]) => key !== 'name');
            if (native && fields.length) text = text.replace(/^---\r?\n/, `---\n${fields.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n`);
            content = Buffer.from(`${text.trimEnd()}\n\n<!-- ${origin} -->\n`);
          }
          files.push({ path: `${prefix}/${asset.relative}`, content, ...metadata });
        }
      }
    }
  }
  return files;
}
