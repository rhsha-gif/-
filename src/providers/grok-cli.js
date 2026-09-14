const READ_TOOLS = Object.freeze([
  'read_file', 'grep', 'list_dir'
]);
const WRITE_TOOLS = Object.freeze([...READ_TOOLS, 'search_replace']);
// `grok models` under grok.com login is the source of truth. Revalidate there
// before adding a slug so a custom/BYOK model cannot silently enter routing.
const SUBSCRIPTION_MODELS = new Set(['grok-4.6']);

const HEADLESS_RULES =
  'Use the available file tools to do the requested work before returning the structured receipt. ' +
  'Do not run shell commands or the listed verification commands: the parent wrapper runs acceptance checks after your receipt. Use file tools only. Report checks not run by you as not-run, then finish after writing the requested artifacts. ' +
  'Do not return a prospective plan as a partial receipt. If a required tool is denied, return blocked with an inputRequest.';

export const GROK_FINALIZE_PROMPT =
  'Return the final structured task receipt for the work already completed in this session. ' +
  'Use only evidence already gathered. Do not describe future work or claim files were inspected when they were not.';

const TOKEN_FIELDS = Object.freeze({
  input_tokens: 'inputTokens',
  output_tokens: 'outputTokens',
  reasoning_tokens: 'reasoningTokens',
  cache_read_input_tokens: 'cacheReadTokens',
  cache_creation_input_tokens: 'cacheCreationTokens',
  total_tokens: 'totalTokens'
});

function protocolError(message) {
  const error = new Error(`Grok protocol error: ${message}`);
  error.failureKind = 'protocol';
  return error;
}

export function sanitizeGrokUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const sanitized = {};
  for (const [source, target] of Object.entries(TOKEN_FIELDS)) {
    const value = usage[source];
    if (Number.isFinite(value) && value >= 0) sanitized[target] = value;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function extractGrokUsage(stdout) {
  try { return sanitizeGrokUsage(JSON.parse(String(stdout ?? '')).usage); }
  catch { return undefined; }
}

export function parseGrokOutput(stdout) {
  let envelope;
  try { envelope = JSON.parse(String(stdout ?? '')); }
  catch { throw protocolError('stdout is not a JSON object'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw protocolError('stdout is not a JSON object');
  }
  if (!envelope.structuredOutput || typeof envelope.structuredOutput !== 'object' || Array.isArray(envelope.structuredOutput)) {
    const error = protocolError('successful result omitted structuredOutput');
    const usage = sanitizeGrokUsage(envelope.usage);
    if (usage) error.usage = usage;
    throw error;
  }
  return { receipt: envelope.structuredOutput, usage: sanitizeGrokUsage(envelope.usage) };
}

export function parseGrokWorkOutput(stdout) {
  let envelope;
  try { envelope = JSON.parse(String(stdout ?? '')); }
  catch { throw protocolError('work phase stdout is not a JSON object'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw protocolError('work phase stdout is not a JSON object');
  }
  if (typeof envelope.sessionId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(envelope.sessionId)) {
    const error = protocolError('work phase omitted a valid sessionId');
    const usage = sanitizeGrokUsage(envelope.usage);
    if (usage) error.usage = usage;
    throw error;
  }
  if (typeof envelope.text !== 'string' || envelope.text.trim() === '') {
    const error = protocolError('work phase omitted its result text');
    const usage = sanitizeGrokUsage(envelope.usage);
    if (usage) error.usage = usage;
    throw error;
  }
  return {
    sessionId: envelope.sessionId,
    turns: Number.isInteger(envelope.num_turns) && envelope.num_turns >= 0 ? envelope.num_turns : undefined,
    usage: sanitizeGrokUsage(envelope.usage)
  };
}

export function buildGrokCommand({
  route,
  write = false,
  promptPath,
  cwd,
  agent,
  executable = 'grok',
  maxTurns = 80
}) {
  if (!route?.model || !route?.effort) throw new TypeError('route.model and route.effort are required');
  if (!promptPath || !cwd) {
    throw new TypeError('promptPath and cwd are required');
  }
  if (!SUBSCRIPTION_MODELS.has(route.model)) {
    throw new Error(`Grok model ${route.model} is not in the verified grok.com subscription model catalog`);
  }
  const args = [
    '--prompt-file', promptPath,
    '--cwd', cwd,
    '--model', route.model,
    '--reasoning-effort', route.effort,
    '--output-format', 'json',
    '--permission-mode', 'dontAsk',
    '--sandbox', write ? 'workspace' : 'read-only',
    '--rules', HEADLESS_RULES,
    '--allow', `Read(${cwd.replaceAll('\\', '/')}/**)`,
    '--allow', `Grep(${cwd.replaceAll('\\', '/')}/**)`,
    '--tools', (write ? WRITE_TOOLS : READ_TOOLS).join(','),
    '--no-subagents',
    '--disallowed-tools', 'Agent',
    '--max-turns', String(maxTurns)
  ];
  if (write) {
    args.push('--allow', `Edit(${cwd.replaceAll('\\', '/')}/**)`);
    args.push('--allow', `Write(${cwd.replaceAll('\\', '/')}/**)`);
  }
  if (agent) args.push('--agent', agent);
  return {
    command: executable,
    args,
    stdin: null,
    env: { AORCH_WORKER: '1', GROK_SUBAGENTS: '0', GROK_MEMORY: '0' },
    unsetEnv: ['XAI_API_KEY']
  };
}

export function buildGrokFinalizeCommand({
  route,
  write = false,
  sessionId,
  promptPath,
  cwd,
  jsonSchema,
  agent,
  executable = 'grok'
}) {
  if (!route?.model || !route?.effort) throw new TypeError('route.model and route.effort are required');
  if (!sessionId || !promptPath || !cwd || !jsonSchema || typeof jsonSchema !== 'object') {
    throw new TypeError('sessionId, promptPath, cwd, and jsonSchema are required');
  }
  if (!SUBSCRIPTION_MODELS.has(route.model)) {
    throw new Error(`Grok model ${route.model} is not in the verified grok.com subscription model catalog`);
  }
  const args = [
    '--resume', sessionId,
    '--prompt-file', promptPath,
    '--cwd', cwd,
    '--model', route.model,
    '--reasoning-effort', route.effort,
    '--json-schema', JSON.stringify(jsonSchema),
    '--output-format', 'json',
    '--permission-mode', 'dontAsk',
    '--sandbox', write ? 'workspace' : 'read-only',
    '--tools', 'read_file',
    '--no-subagents',
    '--disallowed-tools', 'Agent',
    '--max-turns', '2'
  ];
  if (agent) args.push('--agent', agent);
  return {
    command: executable,
    args,
    stdin: null,
    env: { AORCH_WORKER: '1', GROK_SUBAGENTS: '0', GROK_MEMORY: '0' },
    unsetEnv: ['XAI_API_KEY']
  };
}
