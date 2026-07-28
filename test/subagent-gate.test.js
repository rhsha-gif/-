import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const hook = path.resolve(here, '../integrations/shared/subagent-gate.mjs');

function run(toolInput, { env = {}, toolName = 'Agent', raw } = {}) {
  return spawnSync(process.execPath, [hook], {
    input: raw ?? JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      cwd: process.cwd()
    }),
    encoding: 'utf8',
    env: { ...process.env, AORCH_NO_ENFORCE: '', AORCH_WORKER: '', AORCH_VERIFIER: '', ...env },
    timeout: 30_000
  });
}

function denyReason(result) {
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  return output.hookSpecificOutput.permissionDecisionReason;
}

function assertAllowed(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
}

test('an over-tier subagent spawn is denied with the exact downshifted model', () => {
  const result = run({
    description: 'Write unit tests',
    prompt: 'Write unit tests for the config parser edge cases.',
    subagent_type: 'general-purpose',
    model: 'opus'
  });
  const reason = denyReason(result);
  assert.match(reason, /haiku/);
  assert.match(reason, /AORCH_NO_ENFORCE/);
});

test('a spawn already at or below the classified tier is allowed', () => {
  assertAllowed(run({
    description: 'Write unit tests',
    prompt: 'Write unit tests for the config parser edge cases.',
    model: 'haiku'
  }));
  // Below the recommendation is a cheaper choice, never blocked.
  assertAllowed(run({
    description: 'Implement the parser',
    prompt: 'Implement the new config parser module with error handling.',
    model: 'haiku'
  }));
});

test('a spawn without an explicit model is denied and told what to set', () => {
  const reason = denyReason(run({
    description: 'Write unit tests',
    prompt: 'Write unit tests for the config parser edge cases.'
  }));
  assert.match(reason, /model/i);
  assert.match(reason, /haiku/);
});

test('full model identifiers are recognized when ranking tiers', () => {
  const reason = denyReason(run({
    description: 'Format the docs',
    prompt: 'Format this JSON documentation file and fix indentation.',
    model: 'claude-opus-5'
  }));
  assert.match(reason, /haiku/);
});

test('high-complexity work is not downshifted and its matching spawn passes', () => {
  assertAllowed(run({
    description: 'Design auth architecture',
    prompt: 'Design the authentication architecture and threat model.',
    model: 'opus'
  }));
});

test('escape hatches bypass enforcement entirely', () => {
  const input = {
    description: 'Write unit tests',
    prompt: 'Write unit tests for the config parser edge cases.',
    model: 'opus'
  };
  assertAllowed(run(input, { env: { AORCH_NO_ENFORCE: '1' } }));
  assertAllowed(run(input, { env: { AORCH_WORKER: '1' } }));
});

test('the gate fails open on malformed input and unrelated tools', () => {
  assertAllowed(run(null, { raw: '{not-json' }));
  assertAllowed(run({ description: 'anything', model: 'opus' }, { toolName: 'Bash' }));
  // An unrecognized model tier is a user experiment, not a violation.
  assertAllowed(run({
    description: 'Write unit tests',
    prompt: 'Write unit tests for the config parser edge cases.',
    model: 'my-custom-local-model'
  }));
});
