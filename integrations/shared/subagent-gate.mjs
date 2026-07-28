#!/usr/bin/env node
// PreToolUse gate for subagent spawns (Task/Agent tools): asks aorch classify
// for the right model tier and denies over-tier or tierless spawns with the
// exact model to use, so one corrected retry converges. This is cost
// optimization, not a safety control, so every failure path fails open.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.env.AORCH_WORKER === '1' || process.env.AORCH_VERIFIER === '1' || process.env.AORCH_NO_ENFORCE === '1') {
  process.exit(0);
}

const TIER_RANK = Object.freeze({ haiku: 0, sonnet: 1, opus: 2, fable: 3 });

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

function tierOf(modelString) {
  if (typeof modelString !== 'string') return null;
  const lower = modelString.toLowerCase();
  for (const tier of Object.keys(TIER_RANK)) {
    if (lower.includes(tier)) return tier;
  }
  return null;
}

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  }));
  process.exit(0);
}

try {
  const input = await readInput();
  if (!['Task', 'Agent'].includes(input.tool_name)) process.exit(0);
  const toolInput = input.tool_input ?? {};

  // Combine the short description with the prompt's first line: the
  // classifier is keyword-based and the description alone is often too terse.
  const firstPromptLine = typeof toolInput.prompt === 'string'
    ? toolInput.prompt.split('\n', 1)[0].trim()
    : '';
  const objective = [toolInput.description, firstPromptLine]
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join(' — ')
    .slice(0, 300);
  if (!objective) process.exit(0);

  const result = spawnSync(process.execPath, [
    resolveCliPath(), 'classify', '--objective', objective,
    ...(typeof input.cwd === 'string' && input.cwd ? ['--cwd', input.cwd] : [])
  ], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0 || !result.stdout) process.exit(0);

  const { classification, route } = JSON.parse(result.stdout);
  const recommendedTier = tierOf(route?.model);
  if (!recommendedTier) process.exit(0);

  const guidance = `aorch classified this subtask as ${classification.kind}/${classification.complexity} → ` +
    `spawn it with model "${route.model}" (effort ${route.effort}). ` +
    `Re-issue the same call with model: "${route.model}". Set AORCH_NO_ENFORCE=1 to bypass this gate.`;

  if (toolInput.model === undefined || toolInput.model === null || toolInput.model === '') {
    deny(`No model was specified for this subagent. ${guidance}`);
  }
  const spawnTier = tierOf(toolInput.model);
  // An unrecognized model is a deliberate user experiment; stand aside.
  if (!spawnTier) process.exit(0);
  if (TIER_RANK[spawnTier] > TIER_RANK[recommendedTier]) {
    deny(`Model "${toolInput.model}" is over-tier for this subtask. ${guidance}`);
  }
  process.exit(0);
} catch (error) {
  process.stderr.write(`aorch subagent-gate: ${error.message}\n`);
  process.exit(0);
}
