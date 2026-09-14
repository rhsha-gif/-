import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NO_SHELL_FEATURES, readonlyFilesServer, noShellSettings } from './codex-restrictions.js';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Where a preset lives per adapter: the project install first, the shipped copy
// as fallback. Same precedence as loadConfig — a project that tuned its presets
// must not have them silently replaced by the packaged defaults.
const PRESET_LOCATIONS = Object.freeze({
  claude: [
    (cwd, name) => path.join(cwd, '.claude', 'agents', `${name}.md`),
    (_cwd, name) => path.join(PACKAGE_ROOT, 'integrations', 'claude', 'agents', `${name}.md`)
  ],
  codex: [
    (cwd, name) => path.join(cwd, '.codex', 'agents', `${name}.toml`),
    (_cwd, name) => path.join(PACKAGE_ROOT, 'integrations', 'codex', 'agents', `${name}.toml`)
  ],
  antigravity: [
    (cwd, name) => path.join(cwd, '.agents', 'agents', name, 'agent.md'),
    (_cwd, name) => path.join(PACKAGE_ROOT, 'integrations', 'antigravity', 'agents', name, 'agent.md')
  ],
  grok: [
    (cwd, name) => path.join(cwd, '.grok', 'agents', `${name}.md`),
    (_cwd, name) => path.join(PACKAGE_ROOT, 'integrations', 'grok', 'agents', `${name}.md`)
  ]
});

// The one role that needs an MCP server, and the exact tools it may call. This
// is hard-coded rather than a config field on purpose (2026-08-30 ponytail
// verdict): with a single consumer, a generic roleAgents.<role>.mcpServers
// schema would only open a surface where config runs arbitrary commands with
// arbitrary env. The server definition is checked in as a static mcp-config, so
// nothing is generated at run time. The tool list is enumerated, not a
// wildcard: paper-search-mcp also ships download_scihub and other downloaders,
// and a wildcard would grant them the moment the server updates.
const PAPER_SEARCH_SOURCES = [
  'arxiv', 'semantic', 'openalex', 'crossref', 'pubmed', 'pmc', 'europepmc', 'biorxiv',
  'medrxiv', 'dblp', 'core', 'base', 'doaj', 'hal', 'iacr', 'openaire', 'ssrn', 'unpaywall',
  'zenodo', 'citeseerx', 'google_scholar'
];
const PAPER_SEARCH_READ_SOURCES = [
  'arxiv', 'base', 'biorxiv', 'citeseerx', 'crossref', 'dblp', 'doaj', 'hal', 'iacr', 'medrxiv',
  'openaire', 'openalex', 'pubmed', 'semantic', 'ssrn', 'zenodo'
];
const ROLE_MCP = Object.freeze({
  'paper-researcher': Object.freeze({
    configPath: path.join(PACKAGE_ROOT, 'integrations', 'claude', 'mcp', 'paper-researcher.mcp.json'),
    tools: Object.freeze([
      'mcp__paper-search__search_papers',
      ...PAPER_SEARCH_SOURCES.map((source) => `mcp__paper-search__search_${source}`),
      ...PAPER_SEARCH_READ_SOURCES.map((source) => `mcp__paper-search__read_${source}_paper`),
      'mcp__paper-search__get_crossref_paper_by_doi',
      'mcp__paper-search__download_arxiv'
    ])
  })
});

export function roleMcp(agentRole) {
  const entry = ROLE_MCP[agentRole];
  return entry ? { mcpConfig: entry.configPath, mcpTools: [...entry.tools] } : {};
}

export function roleAgentName({ config, agentRole, agentId, adapter }) {
  if (agentId) {
    const provider = providerForAdapter(adapter);
    const entries = (config.capabilities ?? []).filter((entry) => entry.type === 'agent' && entry.id === agentId);
    const entry = entries[0];
    if (entries.length !== 1 || entry.enabled === false || !(entry.executionProviders ?? entry.providers ?? []).includes(provider)
      || entry.bindings?.[provider]?.mode === 'bridge' || entry.bindings?.[provider]?.enabled === false) {
      throw new Error(`Agent ${agentId} is unavailable on ${adapter}; check aorch inventory and enable its required provider`);
    }
    return entry.bindings?.[provider]?.name ?? agentId;
  }
  if (!agentRole) return undefined;
  const entry = config?.roleAgents?.[agentRole];
  if (!entry) {
    throw new Error(`No roleAgents entry for agentRole ${agentRole}`);
  }
  const name = entry[adapter];
  // Fail closed. Falling back to "no agent" would run a reviewer with write
  // tools, or a fixer with none, and the receipt would look identical.
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`No ${adapter} agent configured for agentRole ${agentRole}`);
  }
  return name;
}

function providerForAdapter(adapter) {
  return adapter === 'claude' ? 'anthropic' : adapter === 'codex' ? 'openai' : adapter;
}

// Pulls `developer_instructions = """..."""` out of a Codex preset. A real TOML
// parser would be a dependency, and this package has none; the presets are ours
// and this is the only key we consume from them.
export function extractCodexInstructions(toml) {
  const match = /^developer_instructions\s*=\s*"""\r?\n?([\s\S]*?)"""/m.exec(toml);
  if (match) return match[1].trim().replace(/\\([\\"])/g, '$1');
  const single = /^developer_instructions\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m.exec(toml);
  return single ? JSON.parse(single[1]) : '';
}

// Only key we read out of a Claude preset's frontmatter. A YAML parser would be
// a dependency; the presets are ours and this is the one field aorch has to
// forward, because --max-turns beats the preset's own maxTurns (measured: preset
// 2, flag 8, ran 9 turns) and a per-role turn budget is otherwise inert.
export function parseFrontmatterNumber(text, key) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!frontmatter) return undefined;
  const match = new RegExp(`^${key}:\\s*(\\d+)\\s*$`, 'm').exec(frontmatter[1]);
  return match ? Number(match[1]) : undefined;
}

export function parseFrontmatterList(text, key) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!frontmatter) return undefined;
  const match = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(frontmatter[1]);
  if (!match) return undefined;
  const inline = match[1].trim();
  if (inline) {
    if (inline.startsWith('[')) {
      try {
        const parsed = JSON.parse(inline.replaceAll("'", '"'));
        return Array.isArray(parsed) ? parsed.map(String) : undefined;
      } catch {
        if (!inline.endsWith(']')) return undefined;
        return inline.slice(1, -1).split(',')
          .map((entry) => entry.trim().replace(/^['"]|['"]$/gu, ''))
          .filter(Boolean);
      }
    }
    return inline.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  const tail = frontmatter[1].slice(match.index + match[0].length);
  const items = [];
  for (const line of tail.split(/\r?\n/u)) {
    if (/^\s*$/u.test(line)) continue;
    const item = /^\s+-\s+(.+?)\s*$/u.exec(line);
    if (!item) break;
    items.push(item[1].replace(/^['"]|['"]$/gu, ''));
  }
  return items;
}

function nativeSandboxMode(adapter, preset, binding) {
  const configured = binding?.settings?.sandbox_mode;
  if (configured === 'read-only') return configured;
  if (adapter === 'grok') {
    const denied = parseFrontmatterList(preset, 'disallowedTools');
    return denied?.includes('search_replace') ? 'read-only' : undefined;
  }
  const tools = parseFrontmatterList(preset, 'tools');
  if (!tools) return undefined;
  const writeTools = ['write_to_file', 'replace_file_content', 'multi_replace_file_content'];
  return writeTools.some((tool) => tools.includes(tool)) ? undefined : 'read-only';
}

function assertNativeProfile(adapter, preset, name) {
  if (adapter === 'grok') {
    const denied = parseFrontmatterList(preset, 'disallowedTools');
    if (!denied?.includes('Agent')) {
      throw new Error(`Grok agent preset ${name} must disallow Agent; run \`aorch update\``);
    }
    return;
  }
  const tools = parseFrontmatterList(preset, 'tools');
  if (!tools?.includes('finish')) {
    throw new Error(`Antigravity agent preset ${name} must include finish; run \`aorch update\``);
  }
  const forbidden = ['code_search', 'run_command', 'invoke_subagent', 'define_subagent', 'send_message', 'manage_subagents', 'browser_subagent'];
  const unsafe = forbidden.find((tool) => tools.includes(tool));
  if (unsafe) {
    throw new Error(`Antigravity agent preset ${name} contains unsupported tool ${unsafe}; run \`aorch update\``);
  }
}

async function readFirstExisting(candidates) {
  return (await readFirstExistingEntry(candidates))?.text ?? null;
}

async function readFirstExistingEntry(candidates) {
  for (const candidate of candidates) {
    try {
      return { path: candidate, text: await readFile(candidate, 'utf8') };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return null;
}

function markdownBody(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, '').trim();
}

// Claude selects the preset by name (`--agent`), which also applies its tool
// restrictions. Codex has no such flag, so its preset reaches the worker as
// prompt text; sandbox and explicit feature restrictions are forwarded too.
export async function resolveRoleAgent({ config, agentRole, agentId, adapter, cwd = process.cwd() }) {
  if (!agentRole && !agentId) return {};

  // Checked before the name lookup: on an adapter with no preset mechanism the
  // problem is the adapter, and reporting a missing config entry would send the
  // reader to edit roleAgents, which would not help.
  if (!Object.hasOwn(PRESET_LOCATIONS, adapter)) {
    throw new Error(`Adapter ${adapter} cannot apply agentRole ${agentRole}`);
  }

  const name = roleAgentName({ config, agentRole, agentId, adapter });
  const provider = providerForAdapter(adapter);
  const custom = agentId ? config.capabilities.find((entry) => entry.type === 'agent' && entry.id === agentId) : null;
  const binding = custom?.bindings?.[provider];
  if (custom && ['conflict', 'stale', 'not-installed'].includes(binding?.syncStatus)) throw new Error(`Agent ${agentId} definitions are ${binding.syncStatus}; run aorch update before execution`);

  if (adapter === 'claude') {
    // The CLI already fails closed on an unknown --agent, but it does so after
    // the process has started and reports it as an opaque exit 1. Checking here
    // keeps both adapters failing at the same point, before anything spawns,
    // and lets the message name the fix.
    const locations = custom ? [binding?.path ?? path.join(cwd, '.claude/agents', `${agentId}.md`)] : [...PRESET_LOCATIONS.claude.map((resolve) => resolve(cwd, name)), path.join(os.homedir(), '.claude/agents', `${name}.md`)];
    const preset = await readFirstExisting(locations);
    if (preset === null) {
      throw new Error(
        `Claude agent preset ${name}.md not found for agentRole ${agentRole}; run \`aorch install\``
      );
    }
    const maxTurns = parseFrontmatterNumber(preset, 'maxTurns');
    return { agent: name, ...(maxTurns === undefined ? {} : { maxTurns }), ...roleMcp(agentRole) };
  }

  if (adapter === 'antigravity' || adapter === 'grok') {
    if (roleMcp(agentRole).mcpConfig) {
      throw new Error(`Adapter ${adapter} cannot apply the Claude-only MCP required by agentRole ${agentRole}`);
    }
    const projectLocation = adapter === 'antigravity'
      ? path.join(cwd, '.agents', 'agents', name, 'agent.md')
      : path.join(cwd, '.grok', 'agents', `${name}.md`);
    const packageLocation = adapter === 'antigravity'
      ? path.join(PACKAGE_ROOT, 'integrations', 'antigravity', 'agents', name, 'agent.md')
      : path.join(PACKAGE_ROOT, 'integrations', 'grok', 'agents', `${name}.md`);
    const userLocation = adapter === 'antigravity'
      ? path.join(os.homedir(), '.gemini', 'config', 'agents', name, 'agent.md')
      : path.join(os.homedir(), '.grok', 'agents', `${name}.md`);
    const locations = custom
      ? [binding?.path ?? projectLocation]
      : [projectLocation, userLocation];
    const installed = await readFirstExistingEntry(locations);
    if (installed !== null) {
      assertNativeProfile(adapter, installed.text, name);
      const sandboxMode = nativeSandboxMode(adapter, installed.text, binding);
      return { agent: name, ...(sandboxMode ? { sandboxMode } : {}) };
    }

    // Grok accepts a definition file path via --agent, so its shipped native
    // preset can be used directly without pretending it was installed by name.
    if (!custom && adapter === 'grok') {
      const packaged = await readFirstExistingEntry([packageLocation]);
      if (packaged !== null) {
        assertNativeProfile(adapter, packaged.text, name);
        const sandboxMode = nativeSandboxMode(adapter, packaged.text, binding);
        return { agent: packaged.path, ...(sandboxMode ? { sandboxMode } : {}) };
      }
    }

    // Common roles have a provider-neutral canonical body. It is safe to use
    // as prompt instructions when a native install is missing only if the role
    // carries no provider-specific capability. In particular, never pretend
    // the Claude-only paper-search MCP exists on another CLI.
    if (!custom && adapter === 'grok' && agentRole === 'worker') {
      const portable = await readFirstExisting([
        path.join(PACKAGE_ROOT, 'integrations', 'shared', 'agents', `${name}.md`)
      ]);
      if (portable !== null) return { agentInstructions: markdownBody(portable) };
    }
    throw new Error(
      `${adapter} agent preset ${name} not found for agentRole ${agentRole}; run \`aorch install\``
    );
  }

  const locations = custom ? [binding?.path ?? path.join(cwd, '.codex/agents', `${agentId}.toml`)] : [...PRESET_LOCATIONS.codex.map((resolve) => resolve(cwd, name)), path.join(os.homedir(), '.codex/agents', `${name}.toml`)];
  const toml = await readFirstExisting(locations);
  if (toml === null) {
    throw new Error(`Codex agent preset ${name}.toml not found for agentRole ${agentRole}`);
  }
  let agentInstructions = extractCodexInstructions(toml);
  if (agentInstructions === '') {
    throw new Error(`Codex agent preset ${name}.toml has no developer_instructions`);
  }
  const sandboxMode = /^sandbox_mode\s*=\s*"([^"]+)"\s*$/m.exec(toml)?.[1];
  const noShell = noShellSettings(binding?.settings) || /^features\.shell_tool\s*=\s*false\s*$/m.test(toml);
  if (noShell && sandboxMode !== 'read-only') throw new Error('No-shell Codex preset requires read-only sandbox');
  if (noShell) {
    if (!binding?.instructions) throw new Error('No-shell Codex agent requires canonical agentId instructions');
    agentInstructions = `${binding.instructions}\n\nThe file MCP root is the actual project; the process working directory is an empty isolation directory. Before analysis, read the project's AGENTS.md through aorch_files if present and preserve its safety and evidence requirements. Do not use inherited or unrelated MCP servers. Return missing required evidence to the lead.`;
  }
  const restrictions = noShell ? { codexFeatures: { ...NO_SHELL_FEATURES }, mcpServers: { aorch_files: readonlyFilesServer(cwd) } } : {};
  if (noShell) return { agentInstructions, sandboxMode, ...restrictions };
  // Codex has no --mcp-config; the same checked-in file is read here and
  // reaches `codex exec` as -c mcp_servers.<name>.* overrides (measured
  // 2026-08-30: the worker listed the tools as mcp__paper_search__*).
  const mcp = roleMcp(agentRole);
  if (!mcp.mcpConfig) return { agentInstructions, ...(sandboxMode ? { sandboxMode } : {}), ...restrictions };
  const { mcpServers } = JSON.parse(await readFile(mcp.mcpConfig, 'utf8'));
  mcpServers['paper-search'].enabled_tools = mcp.mcpTools.map(tool => tool.replace(/^mcp__paper-search__/, ''));
  return { agentInstructions, ...(sandboxMode ? { sandboxMode } : {}), ...restrictions, mcpServers: { ...mcpServers, ...restrictions.mcpServers } };
}
