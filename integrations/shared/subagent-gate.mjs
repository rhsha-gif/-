#!/usr/bin/env node
// Advisory only: preserve native inheritance, preset pins and user overrides.
// This optimization hook is not a safety boundary and never rewrites inputs.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.env.AORCH_WORKER === '1' || process.env.AORCH_VERIFIER === '1' || process.env.AORCH_NO_ENFORCE === '1') {
  process.exit(0);
}

// Resolved to the package location at install time; a development checkout
// still has the raw placeholder, so fall back to the repo-relative path.
const AORCH_ROOT = '{{AORCH_ROOT}}';

function resolveCliPath() {
  if (!AORCH_ROOT.startsWith('{{')) {
    const installed = path.join(AORCH_ROOT, 'src', 'cli.js');
    if (existsSync(installed)) return installed;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/cli.js');
}

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

try {
  const input = await readInput();
  if (!['Task', 'Agent', 'spawn_agent'].includes(input.tool_name)) process.exit(0);
  const toolInput = input.tool_input ?? {};
  const provider = process.argv[2] ?? (input.tool_name === 'spawn_agent' || 'message' in toolInput ? 'openai' : 'anthropic');
  if (!['anthropic', 'openai'].includes(provider)) process.exit(0);

  // Combine the short description with the prompt's first line: the
  // classifier is keyword-based and the description alone is often too terse.
  const prompt = toolInput.prompt ?? toolInput.message;
  const firstPromptLine = typeof prompt === 'string'
    ? prompt.split('\n', 1)[0].trim()
    : '';
  const objective = [toolInput.description, firstPromptLine]
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join(' — ')
    .slice(0, 300);
  if (!objective) process.exit(0);

  const result = spawnSync(process.execPath, [
    resolveCliPath(), 'classify', '--objective', objective, '--providers', provider,
    ...(typeof input.cwd === 'string' && input.cwd ? ['--cwd', input.cwd] : [])
  ], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0 || !result.stdout) process.exit(0);

  const { classification, route } = JSON.parse(result.stdout);
  if (route?.provider !== provider || typeof route.model !== 'string') process.exit(0);
  const guidance = `aorch advisory (${provider} only): ${classification.kind}/${classification.complexity}; ` +
    `optional model ${route.model}, effort ${route.effort}. ` +
    `Preserve parent inheritance, preset model/effort and explicit user overrides; missing model is valid. ` +
    `Do not retry or rewrite this call for this recommendation. ` +
    `Native agents may share context for analysis/review or isolated low/standard writes on nonoverlapping paths. ` +
    `High/critical writes and cross-provider work use sequential aorch dispatch. ` +
    `The lead checks actual native diffs/tests; native results are not automatic change-guard/verify observations. No recursive workers.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', additionalContext: guidance
  } }));
  process.exit(0);
} catch (error) {
  process.stderr.write(`aorch subagent-gate: ${error.message}\n`);
  process.exit(0);
}
