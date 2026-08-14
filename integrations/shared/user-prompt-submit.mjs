#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildGateContext, classifyPrompt } from './gate.mjs';

if (process.env.AORCH_WORKER === '1' || process.env.AORCH_VERIFIER === '1') process.exit(0);

// Resolved to the package location at install time; a raw placeholder means
// this is the package's own checkout, which has no installed copy to refresh.
const AORCH_ROOT = '{{AORCH_ROOT}}';

// Installed hooks, skills, and schemas are snapshots of the package and go
// stale whenever it changes. Check that here (a content hash of ~20 small
// files) and let a detached process do the copying, so this hook stays well
// inside its 3-second host timeout. Convenience only: never fails the prompt,
// never writes to stdout.
async function refreshInstallInBackground() {
  if (AORCH_ROOT.startsWith('{{')) return;
  try {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const { refreshIfStale } = await import(pathToFileURL(path.join(AORCH_ROOT, 'src', 'self-update.js')).href);
    await refreshIfStale({ projectRoot });
  } catch (error) {
    process.stderr.write(`aorch auto-update skipped: ${error.message}\n`);
  }
}

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

await refreshInstallInBackground();

const prompt = typeof input.prompt === 'string' ? input.prompt : '';
const classification = classifyPrompt(prompt);
const context = buildGateContext(classification);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: context
  }
}));
