// 'ultracode' engages Claude Code's multi-agent workflow mode. Headless -p
// runs do not detect the prompt keyword (measured: probe reports OFF), but the
// CLI accepts ultracode as a native --effort value since 2.1.205 (measured on
// 2.1.228: probe reports ON), so the route effort passes through unchanged.
// The injected instruction assigns per-agent effort by purpose and the turn
// budget rises to cover workflow spawn/collect/verify loops.
// Bash is in the read set because every task's verification runs through it.
// PowerShell is listed separately because on Windows it is a distinct tool name,
// and an allowlist carrying only Bash sends the worker into a denial loop that
// burns its whole turn budget (measured: five PowerShell denials, no output).
// The web tools are granted to every role: a researcher cannot research without
// them, and the alternative — role-conditional allowlists — would make the
// boundary depend on a field the worker itself cannot see.
// MCP tools are the one exception: an MCP server is a process with a start-up
// cost and a failure point, and granting it to every role would let a
// paper-search outage stop a worker that never needed papers. So the role
// preset (src/role-agent.js) returns mcpTools, and they are appended here only
// when it does — the decision is aorch's, not the worker's.
const READ_TOOLS = Object.freeze([
  'Read', 'Grep', 'Glob', 'Bash', 'PowerShell', 'WebSearch', 'WebFetch'
]);
const WRITE_TOOLS = Object.freeze(['Write', 'Edit']);

const ULTRACODE_EFFORT = 'ultracode';
const ULTRACODE_MIN_MAX_TURNS = 200;
const ULTRACODE_PROMPT_PREFIX = 'Assign each workflow agent\'s reasoning effort by purpose: '
  + 'low for mechanical stages, high for verification and judging stages.\n\n';

export function buildClaudeCommand({
  prompt,
  route,
  write = false,
  outputFormat = 'json',
  jsonSchema,
  pluginDirs = [],
  maxTurns = 80,
  agent,
  mcpConfig,
  mcpTools = [],
  executable = 'claude'
}) {
  if (!route?.model || !route?.effort) throw new TypeError('route.model and route.effort are required');
  const ultracode = route.effort === ULTRACODE_EFFORT;
  const args = [
    '-p', ultracode ? ULTRACODE_PROMPT_PREFIX + prompt : prompt,
    '--model', route.model,
    '--effort', route.effort,
    '--output-format', outputFormat,
    // No permission mode auto-approves tool use in a headless run — measured on
    // claude 2.1.233, `auto`, `dontAsk`, `acceptEdits` and even
    // `bypassPermissions` all deny Bash, and the worker answers with prose
    // asking for approval. Read-only tasks additionally used `plan`, which does
    // not mean "do not change files" but "do not act": such a worker cannot run
    // its verification or write its receipt, and has no ExitPlanMode tool to
    // escape with. Either way no structured output came back, so
    // parseClaudeOutput stored the raw CLI envelope as the receipt and the
    // change guard had no filesChanged claim to check.
    //
    // An explicit allowlist is what actually grants tool use (measured: zero
    // denials, command executed), and it states the role boundary better than a
    // mode does — a read-only worker is handed no editing tools at all. Bash is
    // granted either way because verification needs it, so writes are bounded by
    // the change guard comparing the tree, not by a sandbox.
    '--permission-mode', 'auto',
    '--allowed-tools', ...READ_TOOLS, ...(write ? WRITE_TOOLS : []), ...(mcpConfig ? mcpTools : []),
    '--max-turns', String(ultracode ? Math.max(maxTurns, ULTRACODE_MIN_MAX_TURNS) : maxTurns),
    '--no-session-persistence'
  ];
  if (!write) args.push('--disallowed-tools', ...WRITE_TOOLS, 'NotebookEdit');
  if (jsonSchema) {
    // The claude CLI validates --json-schema with a resolver that cannot fetch
    // the draft/2020-12 meta-schema, so a $schema declaration kills the worker
    // before it starts. The keyword vocabulary we use is draft-07-compatible.
    const { $schema: _metaSchema, ...portableSchema } = jsonSchema;
    args.push('--json-schema', JSON.stringify(portableSchema));
  }
  // A role preset carries hard constraints the prompt cannot enforce — a
  // reviewer that lacks Write cannot "helpfully" edit the code it is judging.
  // Passing the model separately is deliberate: the preset supplies behaviour
  // and tool limits, the router supplies the tier.
  if (agent) args.push('--agent', agent);
  // --strict-mcp-config keeps the worker from also loading the user's global
  // MCP servers, whose start-up (measured: three time-outs in one session)
  // would otherwise be paid on every paper task.
  if (mcpConfig) args.push('--mcp-config', mcpConfig, '--strict-mcp-config');
  for (const pluginDir of pluginDirs) args.push('--plugin-dir', pluginDir);
  return {
    command: executable,
    args,
    stdin: null,
    env: { AORCH_WORKER: '1' }
  };
}
