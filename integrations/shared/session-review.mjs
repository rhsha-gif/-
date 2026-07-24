#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

async function resolveReal(candidate) {
  try { return await realpath(candidate); }
  catch { return path.resolve(candidate); }
}

if (process.env.AORCH_WORKER === '1' || process.env.AORCH_VERIFIER === '1') process.exit(0);

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

async function readActiveRun(cwd) {
  let stateRoot = path.resolve(cwd, '.aorch');
  try {
    const config = JSON.parse(await readFile(path.join(cwd, '.aorch/config.json'), 'utf8'));
    if (typeof config.paths?.stateDir === 'string' && config.paths.stateDir.trim()) {
      stateRoot = path.resolve(cwd, config.paths.stateDir);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let pointerRaw;
  try {
    pointerRaw = await readFile(path.join(stateRoot, 'active-run.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const pointer = JSON.parse(pointerRaw);
  if (typeof pointer.runPath !== 'string' || pointer.runPath.trim() === '') {
    throw new Error('Active run pointer is invalid');
  }
  const runPath = path.resolve(pointer.runPath);
  // Compare realpaths so a symlinked project alias does not misclassify a
  // legitimate pointer as escaping the state root.
  const relative = path.relative(await resolveReal(stateRoot), await resolveReal(runPath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Active run pointer resolves outside the state root');
  }
  // A pointer whose target run is missing is corrupt state, not "no active
  // run": swallowing it would silently disable the Stop lifecycle gate.
  try {
    const run = JSON.parse(await readFile(runPath, 'utf8'));
    return { ...run, path: runPath, stateRoot };
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Active run pointer targets a missing run state: ${runPath}.`);
    }
    throw error;
  }
}

let input;
try {
  input = await readInput();
} catch (error) {
  process.stderr.write(`adaptive-orchestrator lifecycle hook input error: ${error.message}\n`);
  process.exit(1);
}

// Only the Stop event gates the session; SessionEnd and worker/verifier
// subprocesses pass through untouched.
if (input.hook_event_name !== 'Stop' || input.stop_hook_active === true) process.exit(0);

const cwd = path.resolve(input.cwd ?? process.cwd());
let run;
try {
  run = await readActiveRun(cwd);
} catch (error) {
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `Adaptive-orchestrator state could not be verified: ${error.message}. Explicitly close the run state before stopping.`
  }));
  process.exit(0);
}

if (!run) process.exit(0);

if (run.status === 'running') {
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `Orchestration run ${run.id} is still running. Resume its remaining tasks, or explicitly finish it as completed, partial, blocked, failed, or cancelled before stopping.`
  }));
}
