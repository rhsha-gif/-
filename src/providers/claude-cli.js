// 'ultracode' engages Claude Code's multi-agent workflow mode. Headless -p
// runs do not detect the prompt keyword (measured: probe reports OFF), but the
// CLI accepts ultracode as a native --effort value since 2.1.205 (measured on
// 2.1.228: probe reports ON), so the route effort passes through unchanged.
// The injected instruction assigns per-agent effort by purpose and the turn
// budget rises to cover workflow spawn/collect/verify loops.
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
  executable = 'claude'
}) {
  if (!route?.model || !route?.effort) throw new TypeError('route.model and route.effort are required');
  const ultracode = route.effort === ULTRACODE_EFFORT;
  const args = [
    '-p', ultracode ? ULTRACODE_PROMPT_PREFIX + prompt : prompt,
    '--model', route.model,
    '--effort', route.effort,
    '--output-format', outputFormat,
    '--permission-mode', write ? 'auto' : 'plan',
    '--max-turns', String(ultracode ? Math.max(maxTurns, ULTRACODE_MIN_MAX_TURNS) : maxTurns),
    '--no-session-persistence'
  ];
  if (jsonSchema) {
    // The claude CLI validates --json-schema with a resolver that cannot fetch
    // the draft/2020-12 meta-schema, so a $schema declaration kills the worker
    // before it starts. The keyword vocabulary we use is draft-07-compatible.
    const { $schema: _metaSchema, ...portableSchema } = jsonSchema;
    args.push('--json-schema', JSON.stringify(portableSchema));
  }
  for (const pluginDir of pluginDirs) args.push('--plugin-dir', pluginDir);
  return {
    command: executable,
    args,
    stdin: null,
    env: { AORCH_WORKER: '1' }
  };
}
