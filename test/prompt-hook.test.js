import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const hook = path.resolve(here, '../integrations/shared/user-prompt-submit.mjs');

function run(env = {}, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  return spawnSync(process.execPath, [hook], {
    cwd,
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: options.prompt ?? 'fix it', cwd }),
    encoding: 'utf8',
    // Clear aorch's control vars first so the suite is hermetic even when it is
    // run *by* the verify gate, which sets AORCH_VERIFIER=1 (that would make the
    // hook stand aside and emit nothing). Each test opts into the vars it needs.
    env: { ...process.env, AORCH_VERIFIER: '', AORCH_WORKER: '', AORCH_NO_ENFORCE: '', ...env }
  });
}

test('injects the root orchestration directive for every user prompt', () => {
  const result = run();
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /orchestrator must run first/i);
  assert.match(context, /provider.*model.*reasoning effort.*skills.*hooks.*plugins/i);
  assert.doesNotMatch(context, /selection priority is lexicographic/i);
  assert.match(context, /adaptive-orchestrate/);
  assert.ok(!context.includes('Original prompt: fix it'));
});

test('worker subprocesses bypass the root hook to prevent recursion', () => {
  const result = run({ AORCH_WORKER: '1' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('does not read lessons or perform heavy orchestration in the blocking hook path', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'aorch-hook-thin-'));
  mkdirSync(path.join(cwd, '.aorch/learning'), { recursive: true });
  writeFileSync(path.join(cwd, '.aorch/learning/lessons.json'), '{not-json');

  const started = Date.now();
  const result = run({}, { cwd, prompt: 'Fix the failing verification test path' });
  const elapsedMs = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(context, /prevention lessons/i);
  assert.match(context, /classification:/i);
  assert.ok(elapsedMs < 1500, `hook took ${elapsedMs}ms`);
});
