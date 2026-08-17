// `codex exec` has no agent-selection flag — `-p/--profile` layers a file from
// $CODEX_HOME and is a different mechanism from the .codex/agents/*.toml presets.
// So the role preset reaches a Codex worker the only way it can: as instructions
// at the head of the prompt. The trade-off is honest — Codex gets the role's
// behaviour but not its tool restrictions, which stop at --sandbox.
export function buildCodexCommand({
  prompt,
  route,
  write = false,
  schemaPath,
  outputPath,
  agentInstructions,
  executable = 'codex'
}) {
  if (!route?.model || !route?.effort) throw new TypeError('route.model and route.effort are required');
  const args = [
    'exec',
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
