import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { installProject } from '../src/install.js';

test('installs both CLI integrations idempotently without editing root instruction files', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-install-'));
  await installProject({ projectRoot, target: 'both' });
  await installProject({ projectRoot, target: 'both' });

  const claudeSettings = JSON.parse(await readFile(path.join(projectRoot, '.claude/settings.json'), 'utf8'));
  const codexHooks = JSON.parse(await readFile(path.join(projectRoot, '.codex/hooks.json'), 'utf8'));
  assert.equal(claudeSettings.hooks.UserPromptSubmit.length, 1);
  assert.equal(claudeSettings.hooks.Stop.length, 1);
  assert.equal(claudeSettings.hooks.SessionEnd, undefined);
  assert.equal(codexHooks.hooks.UserPromptSubmit.length, 1);
  assert.equal(codexHooks.hooks.Stop.length, 1);
  const codexPromptCommand = codexHooks.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.match(codexPromptCommand, /\.aorch\/hooks\/user-prompt-submit\.mjs/);
  if (process.platform !== 'win32') {
    // Use a non-login shell: hosts execute hook commands with `sh -c`, and a
    // login shell would source user profiles that may pollute stdout. Run from
    // a nested directory to prove the hook locates the install upward
    // (monorepo package installs must not depend on the git toplevel).
    const nested = path.join(projectRoot, 'packages/app');
    await mkdir(nested, { recursive: true });
    const hookResult = spawnSync('/bin/sh', ['-c', codexPromptCommand], {
      cwd: nested,
      input: JSON.stringify({ prompt: 'Explain this project.', cwd: nested }),
      encoding: 'utf8'
    });
    assert.equal(hookResult.status, 0, hookResult.stderr);
    assert.match(JSON.parse(hookResult.stdout).hookSpecificOutput.additionalContext, /orchestrator must run first/i);
  }
  assert.match(await readFile(path.join(projectRoot, '.aorch/schemas/worker-receipt.schema.json'), 'utf8'), /filesChanged/);
  assert.match(await readFile(path.join(projectRoot, '.aorch/hooks/gate.mjs'), 'utf8'), /classifyPrompt/);
  const claudeSkill = await readFile(path.join(projectRoot, '.claude/skills/adaptive-orchestrate/SKILL.md'), 'utf8');
  assert.match(claudeSkill, /task decomposition/i);
  assert.match(claudeSkill, /phase.*confidence.*blockers/i);
  assert.match(await readFile(path.join(projectRoot, '.agents/skills/adaptive-orchestrate/SKILL.md'), 'utf8'), /task decomposition/i);
});

test('rejects unknown installation targets', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-install-target-'));
  await assert.rejects(() => installProject({ projectRoot, target: 'mystery' }), /target/i);
});

test('install preserves pre-existing user hooks and settings keys and never touches root instruction files', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { access } = await import('node:fs/promises');
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-install-merge-'));
  await mkdir(path.join(projectRoot, '.claude'), { recursive: true });
  const userHook = {
    hooks: [{ type: 'command', command: 'node my-own-hook.mjs' }]
  };
  await writeFile(path.join(projectRoot, '.claude/settings.json'), JSON.stringify({
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: { UserPromptSubmit: [userHook] }
  }));

  await installProject({ projectRoot, target: 'claude' });
  await installProject({ projectRoot, target: 'claude' });

  const settings = JSON.parse(await readFile(path.join(projectRoot, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] });
  assert.equal(settings.hooks.UserPromptSubmit.length, 2);
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, 'node my-own-hook.mjs');

  for (const rootFile of ['CLAUDE.md', 'AGENTS.md']) {
    await assert.rejects(() => access(path.join(projectRoot, rootFile)), /ENOENT/, rootFile);
  }
});

test('install refuses to run when an existing settings file is malformed, before mutating anything', async () => {
  const { writeFile, access } = await import('node:fs/promises');
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-install-broken-'));
  await mkdir(path.join(projectRoot, '.claude'), { recursive: true });
  await writeFile(path.join(projectRoot, '.claude/settings.json'), '{ broken');

  await assert.rejects(
    () => installProject({ projectRoot, target: 'claude' }),
    /Cannot parse existing JSON at .*settings\.json/
  );
  await assert.rejects(() => access(path.join(projectRoot, '.aorch')), /ENOENT/);
});
