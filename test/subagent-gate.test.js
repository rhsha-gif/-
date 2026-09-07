import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const hook = path.resolve(here, '../integrations/shared/subagent-gate.mjs');

// classify reads the project's observation ledger, so running the gate against
// the repo root would make these assertions depend on whatever this checkout
// happens to have recorded. A clean directory pins the packaged priors, which
// is what a fresh install actually gets. Ledger-driven routing is covered by
// test/downshift-matrix.test.js instead.
const cleanCwd = mkdtempSync(path.join(os.tmpdir(), 'aorch-gate-'));

function run(toolInput, { env = {}, toolName = 'Agent', raw, cwd = cleanCwd } = {}) {
  return spawnSync(process.execPath, [hook], {
    input: raw ?? JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      cwd
    }),
    encoding: 'utf8',
    env: { ...process.env, AORCH_NO_ENFORCE: '', AORCH_WORKER: '', AORCH_VERIFIER: '', ...env },
    timeout: 30_000
  });
}

function advisory(result, provider) {
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output), ["hookSpecificOutput"]);
  assert.deepEqual(Object.keys(output.hookSpecificOutput).sort(), ["additionalContext", "hookEventName"]);
  assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, new RegExp(provider + " only"));
  assert.ok(context.includes('parent inheritance, preset model/effort and explicit user overrides'));
  assert.match(context, /Do not retry or rewrite/);
  return context;
}

for (const toolName of ["Task", "Agent", "spawn_agent"]) {
  for (const model of [undefined, "", "inherit", "opus", "gpt-6-astra", "my-custom-model"]) {
    test(toolName + " remains advisory with model " + model, () => {
      const codex = toolName === "spawn_agent";
      const input = codex
        ? { message: "Write unit tests for config parser edge cases.", agent_type: "aorch-scout", model }
        : { prompt: "Write unit tests for config parser edge cases.", description: "Write unit tests", subagent_type: "aorch-scout", model };
      const original = structuredClone(input);
      const context = advisory(run(input, { toolName }), codex ? "openai" : "anthropic");
      assert.match(context, codex ? /optional model gpt-/ : /optional model (haiku|claude-)/);
      assert.deepEqual(input, original);
    });
  }
}

test('Codex Agent alias handles message and preset shape', () => {
  advisory(run({ message: "Implement parser tests", agent_type: "aorch-scout" }), "openai");
});

test('worker, verifier and optimization bypasses return no recommendation', () => {
  for (const key of ["AORCH_WORKER", "AORCH_VERIFIER", "AORCH_NO_ENFORCE"]) {
    const result = run({ description: "Write tests" }, { env: { [key]: "1" } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  }
});

test('malformed input, empty objectives and unrelated tools fail open', () => {
  for (const result of [run(null, { raw: "{bad" }), run({}), run({}, {toolName: "Bash"}), run(null)]) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  }
});
