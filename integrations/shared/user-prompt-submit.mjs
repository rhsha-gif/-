#!/usr/bin/env node
import { buildGateContext, classifyPrompt } from './gate.mjs';

if (process.env.AORCH_WORKER === '1' || process.env.AORCH_VERIFIER === '1') process.exit(0);

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

let input;
try {
  input = await readInput();
} catch (error) {
  process.stderr.write(`adaptive-orchestrator hook input error: ${error.message}\n`);
  process.exit(1);
}

const prompt = typeof input.prompt === 'string' ? input.prompt : '';
const classification = classifyPrompt(prompt);
const context = buildGateContext(classification);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: context
  }
}));
