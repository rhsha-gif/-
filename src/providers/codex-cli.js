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
