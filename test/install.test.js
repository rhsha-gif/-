import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installProject } from '../src/install.js';

// Installs record themselves in a user-level registry; keep these tests out of
// the real home directory.
process.env.AORCH_HOME = await mkdtemp(path.join(os.tmpdir(), 'aorch-home-install-'));

test('installs both CLI integrations idempotently without editing root instruction files', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-install-'));
  await installProject({ projectRoot, target: 'both' });
  await installProject({ projectRoot, target: 'both' });

  const claudeSettings = JSON.parse(await readFile(path.join(projectRoot, '.claude/settings.json'), 'utf8'));
  const codexHooks = JSON.parse(await readFile(path.join(projectRoot, '.codex/hooks.json'), 'utf8'));
  assert.equal(claudeSettings.hooks.UserPromptSubmit.length, 1);
  // The Stop-gate premise (durable run state) was pruned; completion gating
  // now lives inside the exec loop, so no Stop hook may be installed.
  assert.equal(claudeSettings.hooks.Stop, undefined);
  assert.equal(claudeSettings.hooks.SessionEnd, undefined);
  assert.equal(claudeSettings.hooks.PreToolUse.length, 1);
  assert.equal(claudeSettings.hooks.PreToolUse[0].matcher, 'Task|Agent');
  assert.match(claudeSettings.hooks.PreToolUse[0].hooks[0].command, /subagent-gate\.mjs/);
  // The installed gate must know where this package lives so it can invoke
  // the classify CLI from an arbitrary project.
  const installedGate = await readFile(path.join(projectRoot, '.aorch/hooks/subagent-gate.mjs'), 'utf8');
  assert.ok(!installedGate.includes('{{AORCH_ROOT}}'), 'gate placeholder must be resolved at install time');
  assert.match(installedGate, /src[/\\]cli\.js|src', 'cli\.js/);
  assert.equal(codexHooks.hooks.UserPromptSubmit.length, 1);
  assert.equal(codexHooks.hooks.Stop, undefined);
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

  // The downshift skill must actually ship and point at this package, not at
  // an unresolved placeholder or a nonexistent repo path.
  const downshiftSkill = await readFile(path.join(projectRoot, '.claude/skills/aorch-downshift/SKILL.md'), 'utf8');
  assert.match(downshiftSkill, /classify --objective/);
  assert.ok(!downshiftSkill.includes('{{AORCH_ROOT}}'), 'placeholder must be resolved at install time');
  assert.match(downshiftSkill, /src\/cli\.js/);
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

test('role agents install without a pinned model, and scout keeps its own', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-agents-'));
  await installProject({ projectRoot, target: 'both' });

  const read = (rel) => readFile(path.join(projectRoot, rel), 'utf8');

  // Dispatch injects the model for the three dispatchable roles, so a preset
  // that pinned one would silently override the router's decision.
  for (const role of ['worker', 'reviewer', 'fixer']) {
    const claude = await read(`.claude/agents/aorch-${role}.md`);
    assert.doesNotMatch(claude, /^model:/m, `.claude aorch-${role} must not pin a model`);
    assert.doesNotMatch(claude, /^effort:/m, `.claude aorch-${role} must not pin an effort`);

    const codex = await read(`.codex/agents/aorch_${role}.toml`.replace(`aorch_${role}`, `aorch-${role}`));
    assert.doesNotMatch(codex, /^model\s*=/m, `.codex aorch-${role} must not pin a model`);
    assert.doesNotMatch(codex, /^model_reasoning_effort\s*=/m, `.codex aorch-${role} must not pin an effort`);
  }

  // Scouting is deliberately not delegated (reconnaissance stays with the lead),
  // so the scout preset is a lead tool and keeps its fixed cheap tier.
  const scout = await read('.claude/agents/aorch-scout.md');
  assert.match(scout, /^model: haiku$/m);
  assert.match(await read('.codex/agents/aorch-scout.toml'), /^model\s*=/m);
});

test('the installed root skill directs the lead through the plan pipeline', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-skill-'));
  await installProject({ projectRoot, target: 'both' });

  for (const rel of ['.claude/skills/adaptive-orchestrate/SKILL.md', '.agents/skills/adaptive-orchestrate/SKILL.md']) {
    const skill = await readFile(path.join(projectRoot, rel), 'utf8');
    assert.match(skill, /aorch decompose --print-schema/, `${rel} must point at the plan contract`);
    assert.match(skill, /aorch dispatch --plan/, `${rel} must dispatch the plan`);
    assert.match(skill, /`agentRole`/, `${rel} must ask for agentRole`);
    assert.match(skill, /Never write `role` yourself/, `${rel} must forbid a hand-written role`);
    assert.match(skill, /Do not delegate reconnaissance/, `${rel} must keep scouting with the lead`);

    // The old per-task envelope loop must not survive as a second instruction:
    // two routes through the same decision is how the lead ends up skipping the
    // validated one.
    assert.doesNotMatch(skill, /Write each task envelope to JSON/, `${rel} still teaches the old loop`);
    assert.doesNotMatch(skill, /Dispatch with `aorch exec --task/, `${rel} still teaches the old loop`);
  }
});

test('no preset declares a tools allowlist, because that silently kills the receipt', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-tools-'));
  await installProject({ projectRoot, target: 'both' });

  for (const role of ['worker', 'reviewer', 'fixer', 'scout']) {
    const preset = await readFile(path.join(projectRoot, `.claude/agents/aorch-${role}.md`), 'utf8');
    // A frontmatter tools allowlist omits the internal structured-output tool,
    // so --json-schema returns nothing and parseClaudeOutput stores the raw CLI
    // envelope as the receipt. Measured; do not reintroduce.
    assert.doesNotMatch(preset, /^tools:/m, `aorch-${role} must not declare a tools allowlist`);
    assert.match(preset, /^disallowedTools:/m, `aorch-${role} must state its restrictions as a denylist`);
  }

  const reviewer = await readFile(path.join(projectRoot, '.claude/agents/aorch-reviewer.md'), 'utf8');
  assert.match(reviewer, /^disallowedTools:.*\bNotebookEdit\b/m, 'reviewer must deny every editing tool');
});

test('the installed skill does not promise a no-write guarantee the tools cannot give', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-claims-'));
  await installProject({ projectRoot, target: 'both' });

  for (const rel of ['.claude/skills/adaptive-orchestrate/SKILL.md', '.agents/skills/adaptive-orchestrate/SKILL.md']) {
    const skill = await readFile(path.join(projectRoot, rel), 'utf8');
    // Measured: a worker with a shell writes files whether or not Write/Edit
    // were withheld, so the preset never gave this guarantee.
    assert.doesNotMatch(skill, /genuinely cannot write/i, `${rel} overstates the tool boundary`);
    assert.match(skill, /change guard/i, `${rel} must name what actually enforces read-only`);
  }
});

test('the book-production presets install on both hosts with the right pen boundaries', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-book-'));
  await installProject({ projectRoot, target: 'both' });

  for (const role of ['writer', 'editor', 'qa-analyst']) {
    const claude = await readFile(path.join(projectRoot, `.claude/agents/aorch-${role}.md`), 'utf8');
    const codex = await readFile(path.join(projectRoot, `.codex/agents/aorch-${role}.toml`), 'utf8');
    assert.doesNotMatch(claude, /^tools:/m, `aorch-${role} must not declare a tools allowlist`);
    assert.match(claude, /^disallowedTools:/m, `aorch-${role} must state its restrictions as a denylist`);
    assert.match(codex, /developer_instructions = """/, `codex aorch-${role} must carry instructions`);
  }

  // Only the judge is denied the pen; writer and editor hold it, and their
  // narrower mandates live in the instructions, not the tool list.
  const qa = await readFile(path.join(projectRoot, '.claude/agents/aorch-qa-analyst.md'), 'utf8');
  assert.match(qa, /^disallowedTools:.*\bWrite\b.*\bEdit\b.*\bNotebookEdit\b/m, 'qa-analyst must deny every editing tool');
  for (const role of ['writer', 'editor']) {
    const preset = await readFile(path.join(projectRoot, `.claude/agents/aorch-${role}.md`), 'utf8');
    assert.doesNotMatch(preset, /^disallowedTools:.*\bWrite\b/m, `aorch-${role} must keep the pen`);
  }
  const codexQa = await readFile(path.join(projectRoot, '.codex/agents/aorch-qa-analyst.toml'), 'utf8');
  assert.match(codexQa, /sandbox_mode = "read-only"/, 'codex qa-analyst must stay read-only');
});

test('the invest and refactor presets install with the right pen boundaries', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-invref-'));
  await installProject({ projectRoot, target: 'both' });

  for (const role of ['invest-analyst', 'refactorer']) {
    const claude = await readFile(path.join(projectRoot, `.claude/agents/aorch-${role}.md`), 'utf8');
    const codex = await readFile(path.join(projectRoot, `.codex/agents/aorch-${role}.toml`), 'utf8');
    assert.doesNotMatch(claude, /^tools:/m, `aorch-${role} must not declare a tools allowlist`);
    assert.match(claude, /^disallowedTools:/m, `aorch-${role} must state its restrictions as a denylist`);
    assert.match(codex, /developer_instructions = """/, `codex aorch-${role} must carry instructions`);
  }

  const invest = await readFile(path.join(projectRoot, '.claude/agents/aorch-invest-analyst.md'), 'utf8');
  assert.match(invest, /^disallowedTools:.*\bWrite\b.*\bEdit\b.*\bNotebookEdit\b/m, 'invest-analyst must deny every editing tool');
  const codexInvest = await readFile(path.join(projectRoot, '.codex/agents/aorch-invest-analyst.toml'), 'utf8');
  assert.match(codexInvest, /sandbox_mode = "read-only"/, 'codex invest-analyst must stay read-only');
  const refactorer = await readFile(path.join(projectRoot, '.claude/agents/aorch-refactorer.md'), 'utf8');
  assert.doesNotMatch(refactorer, /^disallowedTools:.*\bWrite\b/m, 'refactorer must keep the pen');
  assert.match(refactorer, /never weaken, skip, or rewrite a test/, 'refactorer must carry the no-test-weakening rule');
});

test('the adoption presets install on both hosts and carry their attribution', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-adopt-'));
  await installProject({ projectRoot, target: 'both' });

  for (const role of ['researcher', 'analyst', 'license-reviewer', 'ponytail']) {
    const claude = await readFile(path.join(projectRoot, `.claude/agents/aorch-${role}.md`), 'utf8');
    const codex = await readFile(path.join(projectRoot, `.codex/agents/aorch-${role}.toml`), 'utf8');
    assert.doesNotMatch(claude, /^tools:/m, `aorch-${role} must not declare a tools allowlist`);
    assert.match(claude, /^disallowedTools:.*\bNotebookEdit\b/m, `aorch-${role} must deny every editing tool`);
    assert.match(codex, /developer_instructions = """/, `codex aorch-${role} must carry instructions`);
    assert.match(codex, /sandbox_mode = "read-only"/, `codex aorch-${role} must stay read-only`);
  }

  // ponytail is adapted from an MIT project; the notice travels with the file
  // as well as living in NOTICE, so a preset copied on its own stays compliant.
  for (const rel of ['.claude/agents/aorch-ponytail.md', '.codex/agents/aorch-ponytail.toml']) {
    const preset = await readFile(path.join(projectRoot, rel), 'utf8');
    assert.match(preset, /MIT License/, `${rel} must name the licence`);
    assert.match(preset, /DietrichGebert/, `${rel} must name the copyright holder`);
  }
});

test('NOTICE exists and ships, because attribution left out of the package is a breach', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const notice = await readFile(path.join(root, 'NOTICE'), 'utf8');
  assert.match(notice, /MIT License/);
  assert.match(notice, /DietrichGebert/);

  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('NOTICE'), 'NOTICE must be in the published files list');
});

test('the adoption plan template is valid and reaches every role', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { validateTaskPlan } = await import('../src/decompose.js');
  const plan = validateTaskPlan(JSON.parse(await readFile(path.join(root, 'examples/plan-oss-adoption.json'), 'utf8')));

  assert.deepEqual(plan.tasks.map((t) => t.agentRole),
    ['researcher', 'analyst', 'reviewer', 'license-reviewer', 'ponytail']);
  assert.ok(plan.tasks.every((t) => t.write !== true), 'the adoption plan reads; it does not write');

  // At low complexity no Codex profile is eligible for research at all, so the
  // survey task would have nowhere to route.
  assert.equal(plan.tasks[0].complexity, 'standard');
  // A reviewer sharing a model with the work it reviews agrees too easily.
  assert.deepEqual(plan.tasks[2].allowedProviders, ['openai']);

  for (const rel of ['.claude/skills/adaptive-orchestrate/SKILL.md', '.agents/skills/adaptive-orchestrate/SKILL.md']) {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-tmpl-'));
    await installProject({ projectRoot, target: 'both' });
    const skill = await readFile(path.join(projectRoot, rel), 'utf8');
    assert.match(skill, /examples\/plan-oss-adoption\.json/, `${rel} must point at the template`);
  }
});

test('the ponytail preset keeps the limits on what may be shrunk', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-pony-'));
  await installProject({ projectRoot, target: 'both' });

  // These four were missing from the first version and a self-audit caught it.
  // The role judges rather than edits, but its judgement is the input to a task
  // that acts on it, so a recommended removal here becomes a real one
  // downstream — read-only is not the mitigation it looks like.
  for (const rel of ['.claude/agents/aorch-ponytail.md', '.codex/agents/aorch-ponytail.toml']) {
    const preset = await readFile(path.join(projectRoot, rel), 'utf8');
    for (const limit of ['trust boundary', 'data loss', 'security', 'accessibility']) {
      assert.match(preset, new RegExp(limit, 'i'), `${rel} must protect ${limit} from shrinking`);
    }
    // Understand before judging: "unused" is a claim about every call site.
    assert.match(preset, /every caller/i, `${rel} must require finding the callers`);
  }
});
