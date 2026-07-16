export function buildCodexCommand({ prompt, route, write = false, schemaPath, outputPath, executable = 'codex' }) {
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
  return {
    command: executable,
    args,
    stdin: prompt,
    env: { AORCH_WORKER: '1' }
  };
}
