#!/usr/bin/env node
// PreToolUse policy entry: enforces the bootstrap-only host contract. Workers
// and verifiers run in their own transport sandbox and are exempt.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateHostToolUse } from './hook-policy.mjs';

if (process.env.AORCH_WORKER === '1' || process.env.AORCH_VERIFIER === '1') process.exit(0);

const DEFAULT_PROTECTED_FILES = [
  '.aorch/config.json',
  '.aorch/hooks/gate.mjs',
  '.aorch/hooks/hook-policy.mjs',
  '.aorch/hooks/pre-tool-use.mjs',
  '.aorch/hooks/user-prompt-submit.mjs',
  '.aorch/hooks/session-review.mjs',
  '.claude/settings.json',
  '.codex/hooks.json'
];

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function emit(decision) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.allowed ? 'allow' : 'deny',
      permissionDecisionReason: decision.reason
    }
  }));
}

let input;
try {
  input = await readInput();
} catch (error) {
  process.stderr.write(`adaptive-orchestrator hook input error: ${error.message}\n`);
  emit({ allowed: false, reason: 'unreadable PreToolUse input; failing closed' });
  process.exit(0);
}

// This file is installed at <project>/.aorch/hooks/pre-tool-use.mjs.
const projectRoot = process.env.CLAUDE_PROJECT_DIR
  ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let protectedFiles = DEFAULT_PROTECTED_FILES;
try {
  const config = JSON.parse(await readFile(path.join(projectRoot, '.aorch', 'config.json'), 'utf8'));
  if (Array.isArray(config?.controlPlane?.protectedFiles)) {
    protectedFiles = [...new Set([...config.controlPlane.protectedFiles, ...DEFAULT_PROTECTED_FILES])];
  }
} catch {
  // No readable project config: the built-in protected set still applies.
}

try {
  emit(await evaluateHostToolUse(input, { projectRoot, protectedFiles }));
} catch (error) {
  emit({ allowed: false, reason: `policy evaluation error: ${error.message}; failing closed` });
}
