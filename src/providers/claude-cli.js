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
  const args = [
    '-p', prompt,
    '--model', route.model,
    '--effort', route.effort,
    '--output-format', outputFormat,
    '--permission-mode', write ? 'auto' : 'plan',
    '--max-turns', String(maxTurns),
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
