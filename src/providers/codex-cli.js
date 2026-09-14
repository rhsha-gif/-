// `codex exec` has no agent-selection flag — `-p/--profile` layers a file from
// $CODEX_HOME and is a different mechanism from the .codex/agents/*.toml presets.
// So the role preset reaches a Codex worker the only way it can: as instructions
// at the head of the prompt. The trade-off is honest — Codex gets the role's
// behaviour; explicit no-shell presets also forward their disabled features
// and a scoped read-only file MCP rather than relying on prose alone.
export function buildCodexCommand({
  prompt,
  route,
  write = false,
  schemaPath,
  outputPath,
  agentInstructions,
  mcpServers,
  codexFeatures,
  executable = 'codex'
}) {
  if (!route?.model || !route?.effort) throw new TypeError('route.model and route.effort are required');
  if (codexFeatures?.shell_tool === false && (write || Object.keys(mcpServers ?? {}).some(name => name !== 'aorch_files'))) throw new TypeError('Restricted Codex execution requires read-only access and only the scoped aorch_files server');
  const args = [
    'exec',
    ...(codexFeatures?.shell_tool === false ? ['--ignore-user-config', '--skip-git-repo-check'] : []),
    '--model', route.model,
    '--sandbox', write ? 'workspace-write' : 'read-only',
    '-c', `model_reasoning_effort="${route.effort}"`,
    // `codex exec` rejects --search (that flag is interactive-only: "unexpected
    // argument"). --enable web_search is the exec-side equivalent and was
    // measured working — it produced a web search tool call and returned the
    // right answer with its source URL. Do not "fix" this back to --search.
    '--enable', 'web_search',
    '--json'
  ];
  for (const [name, enabled] of Object.entries(codexFeatures ?? {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || typeof enabled !== 'boolean') throw new TypeError('Invalid Codex feature override');
    args.push('-c', `features.${name}=${enabled}`);
  }
  // One -c per key: `codex exec` takes TOML-valued overrides, so the command
  // is a quoted string and args a JSON array (valid TOML for a string array).
  // Only command and args are forwarded — a server that needed env would need
  // a decision about secrets first, and none does today.
  for (const [name, server] of Object.entries(mcpServers ?? {})) {
    args.push('-c', `mcp_servers.${name}.command=${JSON.stringify(server.command)}`);
    args.push('-c', `mcp_servers.${name}.args=${JSON.stringify(server.args ?? [])}`);
    if (server.enabled_tools !== undefined) {
      if (!Array.isArray(server.enabled_tools) || server.enabled_tools.some(tool => typeof tool !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(tool))) throw new TypeError('Invalid MCP tool allowlist');
      args.push('-c', `mcp_servers.${name}.enabled_tools=${JSON.stringify(server.enabled_tools)}`);
    }
    if (codexFeatures?.shell_tool === false && name === 'aorch_files') args.push('-c', 'mcp_servers.aorch_files.default_tools_approval_mode="auto"');
  }
  if (schemaPath) args.push('--output-schema', schemaPath);
  if (outputPath) args.push('-o', outputPath);
  args.push('-');
  const stdin = agentInstructions ? `${agentInstructions.trim()}\n\n${prompt}` : prompt;
  return {
    command: executable,
    args,
    stdin,
    env: { AORCH_WORKER: '1' }
  };
}
