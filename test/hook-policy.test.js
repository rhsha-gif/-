import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluateHostToolUse } from '../src/hook-policy.mjs';
import { createDispatchPermit } from '../src/dispatch-permit.js';

const PROTECTED = ['.aorch/config.json', '.claude/settings.json'];

async function evaluate(input, options = {}) {
  return evaluateHostToolUse(input, { projectRoot: options.projectRoot ?? '/proj', protectedFiles: PROTECTED, ...options });
}

test('host product edits are denied while inbox task envelopes are allowed', async () => {
  for (const tool of ['Edit', 'Write', 'MultiEdit']) {
    const denied = await evaluate({ tool_name: tool, tool_input: { file_path: 'src/app.js' } });
    assert.equal(denied.allowed, false, `${tool} on product files must be denied`);
    assert.match(denied.reason, /bootstrap-only|delegate|worker/i);
  }

  const inbox = await evaluate({ tool_name: 'Write', tool_input: { file_path: '.aorch/inbox/T1.json' } });
  assert.equal(inbox.allowed, true);

  const escape = await evaluate({ tool_name: 'Write', tool_input: { file_path: '.aorch/inbox/../config.json' } });
  assert.equal(escape.allowed, false);

  const protectedFile = await evaluate({ tool_name: 'Edit', tool_input: { file_path: '.claude/settings.json' } });
  assert.equal(protectedFile.allowed, false);
});

test('codex apply_patch is denied for product files and allowed for inbox-only patches', async () => {
  const productPatch = await evaluate({
    tool_name: 'apply_patch',
    tool_input: { input: '*** Begin Patch\n*** Update File: src/app.js\n@@\n-a\n+b\n*** End Patch\n' }
  });
  assert.equal(productPatch.allowed, false);

  const inboxPatch = await evaluate({
    tool_name: 'apply_patch',
    tool_input: { input: '*** Begin Patch\n*** Add File: .aorch/inbox/T2.json\n+{}\n*** End Patch\n' }
  });
  assert.equal(inboxPatch.allowed, true);

  const unparseable = await evaluate({ tool_name: 'apply_patch', tool_input: { input: 'garbage with no file markers' } });
  assert.equal(unparseable.allowed, false, 'unparseable patches fail closed');
});

test('read-only tools remain allowed', async () => {
  for (const tool of ['Read', 'Glob', 'Grep']) {
    const result = await evaluate({ tool_name: tool, tool_input: { file_path: 'src/app.js' } });
    assert.equal(result.allowed, true, `${tool} must stay allowed`);
  }
});

test('host bash allows aorch and read-only commands only', async () => {
  for (const command of [
    'aorch lane --task .aorch/inbox/T1.json',
    'aorch exec --task .aorch/inbox/T1.json',
    'git status',
    'git diff',
    'ls -la src',
    'rg "pattern" src'
  ]) {
    const result = await evaluate({ tool_name: 'Bash', tool_input: { command } });
    assert.equal(result.allowed, true, `${command} must be allowed`);
  }

  for (const command of [
    'echo data > src/app.js',
    'rm -rf src',
    'git commit -m "host commit"',
    'git push origin main',
    'npm install left-pad',
    'sed -i s/a/b/ src/app.js',
    'cat src/app.js | tee src/other.js',
    'aorch lane && rm -rf src',
    'ls $(rm -rf src)',
    'ls `rm -rf src`',
    'AORCH_WORKER=1 node evil.js',
    'export ANTHROPIC_API_KEY=sk-x',
    'claude --dangerously-skip-permissions -p "do work"'
  ]) {
    const result = await evaluate({ tool_name: 'Bash', tool_input: { command } });
    assert.equal(result.allowed, false, `${command} must be denied`);
  }
});

test('agent invocations require a matching unconsumed dispatch permit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-permit-hook-'));

  const noPermit = await evaluate({
    tool_name: 'Task',
    tool_input: { subagent_type: 'aorch-worker', prompt: 'work on T1' }
  }, { stateRoot: root });
  assert.equal(noPermit.allowed, false);

  const permit = await createDispatchPermit({
    root, runId: 'R1', taskId: 'T1', provider: 'anthropic', profileId: 'sonnet-fixture',
    model: 'sonnet', effort: 'high', ttlMs: 60_000
  });
  const prompt = `${permit.marker}\nDo the bounded task T1.`;

  const wrongAgent = await evaluate({
    tool_name: 'Task',
    tool_input: { subagent_type: 'general-purpose', prompt }
  }, { stateRoot: root });
  assert.equal(wrongAgent.allowed, false);

  const wrongModel = await evaluate({
    tool_name: 'Task',
    tool_input: { subagent_type: 'aorch-worker', prompt, model: 'opus' }
  }, { stateRoot: root });
  assert.equal(wrongModel.allowed, false);

  const allowed = await evaluate({
    tool_name: 'Task',
    tool_input: { subagent_type: 'aorch-worker', prompt, model: 'sonnet' }
  }, { stateRoot: root });
  assert.equal(allowed.allowed, true);

  const replay = await evaluate({
    tool_name: 'Task',
    tool_input: { subagent_type: 'aorch-worker', prompt, model: 'sonnet' }
  }, { stateRoot: root });
  assert.equal(replay.allowed, false, 'a consumed permit cannot authorize a second dispatch');
});

test('expired permits deny agent dispatch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-permit-expired-'));
  const permit = await createDispatchPermit({
    root, runId: 'R1', taskId: 'T2', provider: 'anthropic', profileId: 'sonnet-fixture',
    model: 'sonnet', effort: 'high', ttlMs: -1000
  });
  const result = await evaluate({
    tool_name: 'Task',
    tool_input: { subagent_type: 'aorch-worker', prompt: `${permit.marker}\nwork` }
  }, { stateRoot: root });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /expired|permit/i);
});

test('installed pre-tool-use entry denies product edits and allows inbox writes end to end', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdir, copyFile } = await import('node:fs/promises');
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-hook-e2e-'));
  const hooksDir = path.join(projectRoot, '.aorch', 'hooks');
  await mkdir(hooksDir, { recursive: true });
  for (const script of ['hook-policy.mjs', 'pre-tool-use.mjs']) {
    await copyFile(new URL(`../integrations/shared/${script}`, import.meta.url), path.join(hooksDir, script));
  }

  const run = (event) => {
    const result = spawnSync(process.execPath, [path.join(hooksDir, 'pre-tool-use.mjs')], {
      input: JSON.stringify(event),
      encoding: 'utf8',
      env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: projectRoot }
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).hookSpecificOutput;
  };

  const denied = run({ tool_name: 'Edit', tool_input: { file_path: 'src/app.js' } });
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /bootstrap-only|delegate/i);

  const allowed = run({ tool_name: 'Write', tool_input: { file_path: '.aorch/inbox/T1.json' } });
  assert.equal(allowed.permissionDecision, 'allow');

  const hookSelfDefense = run({ tool_name: 'Write', tool_input: { file_path: '.aorch/hooks/pre-tool-use.mjs' } });
  assert.equal(hookSelfDefense.permissionDecision, 'deny');
});
