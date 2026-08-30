import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function roleAgentName({ config, agentRole, adapter }) {
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

// Pulls `developer_instructions = """..."""` out of a Codex preset. A real TOML
// parser would be a dependency, and this package has none; the presets are ours
// and this is the only key we consume from them.
export function extractCodexInstructions(toml) {
  const match = /^developer_instructions\s*=\s*"""\r?\n?([\s\S]*?)"""/m.exec(toml);
  return match ? match[1].trim() : '';
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

async function readFirstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return null;
}

// Claude selects the preset by name (`--agent`), which also applies its tool
// restrictions. Codex has no such flag, so its preset reaches the worker as
// prompt text and only `--sandbox` constrains tools.
export async function resolveRoleAgent({ config, agentRole, adapter, cwd = process.cwd() }) {
  if (!agentRole) return {};

  // Checked before the name lookup: on an adapter with no preset mechanism the
  // problem is the adapter, and reporting a missing config entry would send the
  // reader to edit roleAgents, which would not help.
  if (!Object.hasOwn(PRESET_LOCATIONS, adapter)) {
    throw new Error(`Adapter ${adapter} cannot apply agentRole ${agentRole}`);
  }

  const name = roleAgentName({ config, agentRole, adapter });

  if (adapter === 'claude') {
    // The CLI already fails closed on an unknown --agent, but it does so after
    // the process has started and reports it as an opaque exit 1. Checking here
    // keeps both adapters failing at the same point, before anything spawns,
    // and lets the message name the fix.
    const locations = PRESET_LOCATIONS.claude.map((resolve) => resolve(cwd, name));
    const preset = await readFirstExisting(locations);
    if (preset === null) {
      throw new Error(
        `Claude agent preset ${name}.md not found for agentRole ${agentRole}; run \`aorch install\``
      );
    }
    const maxTurns = parseFrontmatterNumber(preset, 'maxTurns');
    return { agent: name, ...(maxTurns === undefined ? {} : { maxTurns }), ...roleMcp(agentRole) };
  }

  const locations = PRESET_LOCATIONS.codex.map((resolve) => resolve(cwd, name));
  const toml = await readFirstExisting(locations);
  if (toml === null) {
    throw new Error(`Codex agent preset ${name}.toml not found for agentRole ${agentRole}`);
  }
  const agentInstructions = extractCodexInstructions(toml);
  if (agentInstructions === '') {
    throw new Error(`Codex agent preset ${name}.toml has no developer_instructions`);
  }
  // Codex has no --mcp-config; the same checked-in file is read here and
  // reaches `codex exec` as -c mcp_servers.<name>.* overrides (measured
  // 2026-08-30: the worker listed the tools as mcp__paper_search__*).
  const mcp = roleMcp(agentRole);
  if (!mcp.mcpConfig) return { agentInstructions };
  const { mcpServers } = JSON.parse(await readFile(mcp.mcpConfig, 'utf8'));
  return { agentInstructions, mcpServers };
}
