const TOKEN_FIELDS = Object.freeze({
  input_tokens: 'inputTokens',
  output_tokens: 'outputTokens',
  thinking_tokens: 'reasoningTokens',
  cache_read_tokens: 'cacheReadTokens',
  total_tokens: 'totalTokens'
});

// Fail closed against custom/BYOK model configuration. Add a slug only after
// re-running `agy models` with API-key environment overrides removed.
const SUBSCRIPTION_MODELS = new Set([
  'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
  'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low',
  'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
  'gemini-3.1-pro-high', 'gemini-3.1-pro-low', 'claude-sonnet-4-6',
  'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'
]);

const HEADLESS_CONSTRAINTS =
  'Antigravity headless constraint: do not call run_command or any subagent, delegation, or inter-agent tool. ' +
  'Use file and search tools directly. Do not run the listed verification commands yourself; the parent wrapper runs them after this receipt.';

// Gemini slugs carry the thinking level as a suffix, and agy's --effort is the
// same axis (antigravity.google/docs/cli/headless). The catalog stores the base
// slug; the route effort picks the suffix, so the two can never disagree.
// Anything not in SUBSCRIPTION_MODELS after composition (e.g. a pro model with
// an effort it does not offer) fails closed below.
const SUFFIXED_FAMILIES = /^gemini-[\d.]+-(?:flash|pro)$/;

export function resolveAntigravityModel(model, effort) {
  return SUFFIXED_FAMILIES.test(model) ? `${model}-${effort}` : model;
}

function protocolError(message) {
  const error = new Error(`Antigravity protocol error: ${message}`);
  error.failureKind = 'protocol';
  return error;
}

function deniedActions(events) {
  return events.flatMap((event) => {
    const denied = event?.result?.denied_actions ?? event?.denied_actions;
    return Array.isArray(denied) ? denied : [];
  });
}

function actionRequiredError(actions) {
  const error = new Error(
    `Antigravity action required: headless permission policy denied ${actions.length} tool action${actions.length === 1 ? '' : 's'}`
  );
  error.failureKind = 'action-required';
  error.actionRequired = 'permission';
  error.deniedActionCount = actions.length;
  return error;
}

export function sanitizeAntigravityUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const sanitized = {};
  for (const [source, target] of Object.entries(TOKEN_FIELDS)) {
    const value = usage[source];
    if (Number.isFinite(value) && value >= 0) sanitized[target] = value;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function parseAntigravityOutput(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const events = lines.map((line) => {
    try { return JSON.parse(line); }
    catch { throw protocolError('stdout contains invalid NDJSON'); }
  });
  const results = events.filter((event) => event?.event === 'result').map((event) => event.result);
  if (results.length !== 1 || !results[0] || typeof results[0] !== 'object') {
    throw protocolError(`expected exactly one terminal result event, received ${results.length}`);
  }
  const result = results[0];
  const usage = sanitizeAntigravityUsage(result.usage);
  if (result.status !== 'SUCCESS') {
    const error = new Error(`Antigravity worker ended with status ${String(result.status ?? 'unknown')}`);
    error.providerMessage = typeof result.error === 'string' ? result.error : '';
    if (usage) error.usage = usage;
    throw error;
  }
  const denied = deniedActions(events);
  if (denied.length > 0) {
    const error = actionRequiredError(denied);
    if (usage) error.usage = usage;
    throw error;
  }
  if (!result.structured_output || typeof result.structured_output !== 'object' || Array.isArray(result.structured_output)) {
    const error = protocolError('successful result omitted structured_output');
    if (usage) error.usage = usage;
    throw error;
  }
  return { receipt: result.structured_output, usage };
}

export function buildAntigravityCommand({
  prompt,
  route,
  write = false,
  schemaPath,
  cwd,
  agent,
  agentInstructions,
  executable = 'agy'
}) {
  if (!route?.model || !route?.effort) throw new TypeError('route.model and route.effort are required');
  if (!schemaPath) throw new TypeError('schemaPath is required');
  if (!cwd) throw new TypeError('cwd is required');
  const model = resolveAntigravityModel(route.model, route.effort);
  if (!SUBSCRIPTION_MODELS.has(model)) {
    throw new Error(`Antigravity model ${model} is not in the verified subscription model catalog`);
  }
  const instructions = agentInstructions ? `${agentInstructions.trim()}\n\n${HEADLESS_CONSTRAINTS}` : HEADLESS_CONSTRAINTS;
  const content = `${instructions}\n\n${prompt}`;
  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--json-schema', schemaPath,
    '--add-dir', cwd,
    '--model', model,
    // Suffixed Gemini slugs already encode the effort; Antigravity Sonnet 4.6
    // rejects the CLI effort option.
    ...(model !== route.model || model === 'claude-sonnet-4-6' ? [] : ['--effort', route.effort]),
    '--mode', write ? 'accept-edits' : 'plan',
    '--sandbox'
  ];
  if (agent) args.push('--agent', agent);
  return {
    command: executable,
    args,
    stdin: `${JSON.stringify({ event: 'user', message: { content } })}\n`,
    env: { AORCH_WORKER: '1' },
    unsetEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY']
  };
}
