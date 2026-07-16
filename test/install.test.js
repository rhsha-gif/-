import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
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
  assert.equal(claudeSettings.hooks.SessionEnd.length, 1);
  assert.equal(codexHooks.hooks.UserPromptSubmit.length, 1);
  assert.equal(codexHooks.hooks.Stop.length, 1);
  const codexPromptCommand = codexHooks.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.match(codexPromptCommand, /git rev-parse.*\|\| pwd/);
  if (process.platform !== 'win32') {
    const hookResult = spawnSync('/bin/sh', ['-lc', codexPromptCommand], {
      cwd: projectRoot,
      input: JSON.stringify({ prompt: 'Explain this project.', cwd: projectRoot }),
      encoding: 'utf8'
    });
    assert.equal(hookResult.status, 0, hookResult.stderr);
    assert.match(JSON.parse(hookResult.stdout).hookSpecificOutput.additionalContext, /orchestrator must run first/i);
  }
  assert.match(await readFile(path.join(projectRoot, '.aorch/hooks/gate.mjs'), 'utf8'), /classifyPrompt/);
  assert.match(await readFile(path.join(projectRoot, '.aorch/hooks/journal.mjs'), 'utf8'), /appendJournalRecord/);
  const claudeSkill = await readFile(path.join(projectRoot, '.claude/skills/adaptive-orchestrate/SKILL.md'), 'utf8');
  assert.match(claudeSkill, /task decomposition/i);
  assert.match(claudeSkill, /verifier attestation/i);
  assert.match(claudeSkill, /phase.*confidence.*blockers/i);
  assert.match(await readFile(path.join(projectRoot, '.agents/skills/adaptive-orchestrate/SKILL.md'), 'utf8'), /task decomposition/i);
  assert.match(await readFile(path.join(projectRoot, '.claude/skills/post-run-reflection/SKILL.md'), 'utf8'), /user approval/i);
  assert.match(await readFile(path.join(projectRoot, '.agents/skills/post-run-reflection/SKILL.md'), 'utf8'), /user approval/i);
});

test('rejects unknown installation targets', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-install-target-'));
  await assert.rejects(() => installProject({ projectRoot, target: 'mystery' }), /target/i);
});
