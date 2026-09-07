import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installProject, hookCommand } from '../src/install.js';

// Installs record themselves in a user-level registry; keep these tests out of
// the real home directory.
process.env.AORCH_HOME = await mkdtemp(path.join(os.tmpdir(), 'aorch-home-install-'));

test('installs both CLI integrations idempotently without editing root instruction files', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-install-'));
  await installProject({ projectRoot, target: 'both' });
  await installProject({ projectRoot, target: 'both' });

  const claudeSettings = JSON.parse(await readFile(path.join(projectRoot, '.claude/settings.json'), 'utf8'));
  await assert.rejects(() => access(path.join(projectRoot, '.claude/settings.local.json')), /ENOENT/);
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
  assert.match(codexPromptCommand, /\.aorch[/\\]hooks[/\\]user-prompt-submit\.mjs/);
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
  const receiptSchema = await readFile(path.join(projectRoot, '.aorch/schemas/worker-receipt.schema.json'), 'utf8');
  assert.match(receiptSchema, /filesChanged/);
  // The auditor role writes its ranked findings here; an installed copy
  // without the field would make the CLI reject every auditor receipt.
  assert.match(receiptSchema, /"findings"/);
  assert.match(await readFile(path.join(projectRoot, '.aorch/hooks/gate.mjs'), 'utf8'), /classifyPrompt/);
  const claudeSkill = await readFile(path.join(projectRoot, '.claude/skills/adaptive-orchestrate/SKILL.md'), 'utf8');
  assert.match(claudeSkill, /task decomposition/i);
  assert.match(claudeSkill, /phase.*confidence.*blockers/i);
  assert.match(await readFile(path.join(projectRoot, '.agents/skills/adaptive-orchestrate/SKILL.md'), 'utf8'), /task decomposition/i);
  const codexUpgradeSkill = await readFile(path.join(projectRoot, '.agents/skills/aorch-model-upgrade/SKILL.md'), 'utf8');
  assert.match(codexUpgradeSkill, /plan-model-upgrade\.json/);
  assert.match(codexUpgradeSkill, /challenger/);

  // The downshift skill must actually ship and point at this package, not at
  // an unresolved placeholder or a nonexistent repo path.
  const downshiftSkill = await readFile(path.join(projectRoot, '.claude/skills/aorch-downshift/SKILL.md'), 'utf8');
  assert.match(downshiftSkill, /classify --objective/);
  assert.ok(!downshiftSkill.includes('{{AORCH_ROOT}}'), 'placeholder must be resolved at install time');
  assert.match(downshiftSkill, /src\/cli\.js/);

  // The model-upgrade runbook ships with the package so a project can run it
  // without reaching back into the aorch checkout.
  const upgradeSkill = await readFile(path.join(projectRoot, '.claude/skills/aorch-model-upgrade/SKILL.md'), 'utf8');
  assert.match(upgradeSkill, /plan-model-upgrade\.json/);
  assert.match(upgradeSkill, /challenger/);
  assert.match(await readFile(path.join(projectRoot, '.claude/agents/aorch-auditor.md'), 'utf8'), /findings/);
  const managerSkill = await readFile(path.join(projectRoot, '.claude/skills/aorch-manager-map/SKILL.md'), 'utf8');
  assert.match(managerSkill, /plan-manager-map\.json/);
  assert.match(await readFile(path.join(projectRoot, '.agents/skills/aorch-manager-map/SKILL.md'), 'utf8'), /manager-map-check/);
});

test('rejects unknown installation targets', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-install-target-'));
  await assert.rejects(() => installProject({ projectRoot, target: 'mystery' }), /target/i);
});

test('migrates only owned legacy handlers inside mixed groups and preserves custom config', async () => {
  const { writeFile } = await import('node:fs/promises');
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch 한글 space-'));
  const customConfig = '{ "custom": "keep exactly" }\n';
  await mkdir(path.join(projectRoot, '.aorch'), { recursive: true });
  await writeFile(path.join(projectRoot, '.aorch/config.json'), customConfig);
  const user = { type: 'command', command: 'node my-own-hook.mjs', timeout: 7 };
  const legacy = 'node "${CLAUDE_PROJECT_DIR}/.aorch/hooks/subagent-gate.mjs"';
  const legacyCodex = 'ROOT="$PWD"; while [ ! -e "$ROOT/.aorch/hooks/user-prompt-submit.mjs" ] && [ "$ROOT" != "/" ]; do ROOT="$(dirname "$ROOT")"; done; if [ -e "$ROOT/.aorch/hooks/user-prompt-submit.mjs" ]; then node "$ROOT/.aorch/hooks/user-prompt-submit.mjs"; else echo "aorch: no .aorch/hooks above $PWD" >&2; fi';
  for (const [host, name, event, command] of [
    ['.claude', 'settings.json', 'PreToolUse', legacy],
    ['.codex', 'hooks.json', 'UserPromptSubmit', legacyCodex]
  ]) {
    await mkdir(path.join(projectRoot, host), { recursive: true });
    await writeFile(path.join(projectRoot, host, name), JSON.stringify({ custom: 42, hooks: {
      [event]: [{ matcher: '.*', hooks: [user, { type: 'command', command }, { type: 'command', command }] }],
      Stop: [{ hooks: [user] }]
    } }));
  }
  await installProject({ projectRoot });
  const first = await readFile(path.join(projectRoot, '.codex/hooks.json'), 'utf8');
  await installProject({ projectRoot });
  assert.equal(await readFile(path.join(projectRoot, '.codex/hooks.json'), 'utf8'), first);
  assert.equal(await readFile(path.join(projectRoot, '.aorch/config.json'), 'utf8'), customConfig);
  for (const [host, name, event] of [['.claude', 'settings.json', 'PreToolUse'], ['.codex', 'hooks.json', 'UserPromptSubmit']]) {
    const installed = JSON.parse(await readFile(path.join(projectRoot, host, name), 'utf8'));
    assert.equal(installed.custom, 42);
    assert.deepEqual(installed.hooks.Stop, [{ hooks: [user] }]);
    assert.deepEqual(installed.hooks[event][0], { matcher: '.*', hooks: [user] });
    assert.equal(installed.hooks[event].length, 2);
  }
  const codex = JSON.parse(first);
  assert.equal(codex.hooks.PreToolUse[0].matcher, 'Agent|spawn_agent');
  const handler = codex.hooks.PreToolUse[0].hooks[0];
  assert.equal(handler.commandWindows, hookCommand(path.join(projectRoot, '.aorch/hooks/subagent-gate.mjs'), 'openai', 'win32'));
  const nested = path.join(projectRoot, 'nested');
  await mkdir(nested);
  // Exercise the generated command in the host OS shell, from a nested cwd.
  for (const [host, name, provider] of [['.claude', 'settings.json', 'anthropic'], ['.codex', 'hooks.json', 'openai']]) {
    const settings = JSON.parse(await readFile(path.join(projectRoot, host, name), 'utf8'));
    const command = settings.hooks.PreToolUse.at(-1).hooks[0].command;
    const result = spawnSync(command, { shell: true, cwd: nested,
      input: JSON.stringify({ tool_name: host === '.codex' ? 'spawn_agent' : 'Agent', tool_input: { message: 'Write unit tests', description: 'Write unit tests' } }),
      encoding: 'utf8', env: { ...process.env, AORCH_WORKER: '', AORCH_VERIFIER: '', AORCH_NO_ENFORCE: '', AORCH_NO_AUTOUPDATE: '1' } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, new RegExp(provider + ' only'));
  }
});

test('existing local Claude settings receive managed hooks and migrate only owned shared handlers', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch local 한글 space-'));
  await mkdir(path.join(projectRoot, '.claude'));
  const sharedPath = path.join(projectRoot, '.claude/settings.json');
  const localPath = path.join(projectRoot, '.claude/settings.local.json');
  const owned = { type: 'command', command: hookCommand(path.join(projectRoot, '.aorch/hooks/subagent-gate.mjs'), 'anthropic') };
  const user = { type: 'command', command: 'node my-own-hook.mjs', timeout: 7 };
  const shared = {
    permissions: { allow: ['Bash(ls:*)'] }, custom: { shared: true },
    hooks: {
      PreToolUse: [{ matcher: 'Task|Agent', custom: 'shared group', hooks: [user, owned,
        { type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.aorch/hooks/subagent-gate.mjs"' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.aorch/hooks/user-prompt-submit.mjs"' }] }],
      Stop: [{ custom: 'untouched', hooks: [user] }]
    }
  };
  const local = {
    permissions: { deny: ['Bash(rm:*)'] }, custom: { local: true },
    hooks: {
      PreToolUse: [{ matcher: '.*', custom: 'local group', hooks: [user, owned, owned] }],
      UserPromptSubmit: [{ hooks: [user] }], Stop: [{ hooks: [] }]
    }
  };
  await writeFile(sharedPath, JSON.stringify(shared));
  await writeFile(localPath, JSON.stringify(local));
  const result = await installProject({ projectRoot, target: 'claude' });
  assert.ok(result.installed.includes('.claude/settings.local.json'));
  const firstShared = await readFile(sharedPath, 'utf8');
  const firstLocal = await readFile(localPath, 'utf8');
  assert.deepEqual(JSON.parse(firstShared), { ...shared, hooks: {
    ...shared.hooks,
    PreToolUse: [{ matcher: 'Task|Agent', custom: 'shared group', hooks: [user] }],
    UserPromptSubmit: []
  } });
  const installed = JSON.parse(firstLocal);
  assert.deepEqual(installed.permissions, local.permissions);
  assert.deepEqual(installed.custom, local.custom);
  assert.deepEqual(installed.hooks.Stop, local.hooks.Stop);
  assert.deepEqual(installed.hooks.PreToolUse[0], { matcher: '.*', custom: 'local group', hooks: [user] });
  assert.deepEqual(installed.hooks.UserPromptSubmit[0], { hooks: [user] });
  assert.equal(installed.hooks.PreToolUse.length, 2);
  assert.equal(installed.hooks.UserPromptSubmit.length, 2);
  await installProject({ projectRoot, target: 'claude' });
  assert.equal(await readFile(sharedPath, 'utf8'), firstShared);
  assert.equal(await readFile(localPath, 'utf8'), firstLocal);

  const nested = path.join(projectRoot, 'nested');
  await mkdir(nested);
  for (const [event, input, expected] of [
    ['PreToolUse', { tool_name: 'Agent', tool_input: { description: 'Write unit tests' } }, /anthropic only/],
    ['UserPromptSubmit', { prompt: 'Explain this project.', cwd: nested }, /orchestrator must run first/i]
  ]) {
    const command = installed.hooks[event].at(-1).hooks[0].command;
    const execution = spawnSync(command, { shell: true, cwd: nested, input: JSON.stringify(input), encoding: 'utf8',
      env: { ...process.env, AORCH_WORKER: '', AORCH_VERIFIER: '', AORCH_NO_ENFORCE: '', AORCH_NO_AUTOUPDATE: '1' } });
    assert.equal(execution.status, 0, execution.stderr);
    assert.match(JSON.parse(execution.stdout).hookSpecificOutput.additionalContext, expected);
  }
});

test('reinstall replaces generated hooks across Node changes and Windows path casing without removing user wrappers', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "aorch O'Brien 한글 space-"));
  await installProject({ projectRoot, target: 'both' });
  const oldNode = path.join(projectRoot, 'previous node', path.basename(process.execPath));
  const settingsFiles = [['.claude/settings.json', 'anthropic'], ['.codex/hooks.json', 'openai']];
  const expectedUsers = new Map();
  for (const [file, provider] of settingsFiles) {
    const settings = JSON.parse(await readFile(path.join(projectRoot, file), 'utf8'));
    const eventUsers = {};
    for (const [event, script] of [['PreToolUse', 'subagent-gate.mjs'], ['UserPromptSubmit', 'user-prompt-submit.mjs']]) {
      const scriptPath = path.join(projectRoot, '.aorch/hooks', script);
      const oldScriptPath = process.platform === 'win32' ? scriptPath.toUpperCase() : scriptPath;
      const hostProvider = event === 'PreToolUse' ? provider : undefined;
      const previous = { type: 'command', command: hookCommand(oldScriptPath, hostProvider, process.platform, oldNode) };
      if (provider === 'openai') previous.commandWindows = hookCommand(oldScriptPath, hostProvider, 'win32', oldNode);
      const users = [
        { type: 'command', command: `echo ${previous.command}`, timeout: 7 },
        { type: 'command', command: `${previous.command} extra` },
        { type: 'command', command: hookCommand(path.join(projectRoot, 'another-project/.aorch/hooks', script), hostProvider) },
        { type: 'command', command: hookCommand(scriptPath, hostProvider, process.platform, path.join(projectRoot, 'echo')) }
      ];
      if (hostProvider) users.push({ type: 'command', command: hookCommand(scriptPath, provider === 'openai' ? 'anthropic' : 'openai') });
      settings.hooks[event] = [{ matcher: '.*', custom: 'keep mixed group', hooks: [...users, previous, previous] }];
      eventUsers[event] = users;
    }
    expectedUsers.set(file, eventUsers);
    await writeFile(path.join(projectRoot, file), JSON.stringify(settings));
  }
  // Existing local settings also need migration/deduplication with a new Node path.
  await writeFile(path.join(projectRoot, '.claude/settings.local.json'), await readFile(path.join(projectRoot, '.claude/settings.json')));
  const reinstallRoot = process.platform === 'win32' ? projectRoot.toLowerCase() : projectRoot;
  await installProject({ projectRoot: reinstallRoot, target: 'both' });
  for (const [file, users] of [
    ['.claude/settings.json', expectedUsers.get('.claude/settings.json')],
    ['.claude/settings.local.json', expectedUsers.get('.claude/settings.json')],
    ['.codex/hooks.json', expectedUsers.get('.codex/hooks.json')]
  ]) {
    const before = await readFile(path.join(projectRoot, file), 'utf8');
    const settings = JSON.parse(before);
    for (const event of ['PreToolUse', 'UserPromptSubmit']) {
      assert.deepEqual(settings.hooks[event][0], { matcher: '.*', custom: 'keep mixed group', hooks: users[event] }, file);
      assert.equal(settings.hooks[event].length, file === '.claude/settings.json' ? 1 : 2, file);
    }
    await installProject({ projectRoot: reinstallRoot, target: 'both' });
    assert.equal(await readFile(path.join(projectRoot, file), 'utf8'), before, file);
  }
});

test('Windows hook serialization rejects quote and shell metacharacters in every argument', () => {
  for (const unsafe of ['"', '&', '|', '<', '>', '^', '%', '!', '\r', '\n', '\0']) {
    for (const args of [
      [`C:/project${unsafe}/hook.mjs`, 'anthropic', 'win32', 'C:/node/node.exe'],
      ['C:/project/hook.mjs', `anthropic${unsafe}`, 'win32', 'C:/node/node.exe'],
      ['C:/project/hook.mjs', 'anthropic', 'win32', `C:/node${unsafe}/node.exe`]
    ]) assert.throws(() => hookCommand(...args), /unsafe shell characters/);
  }
  assert.equal(hookCommand('C:/한글 space/hook.mjs', 'anthropic', 'win32', 'C:/Program Files/node.exe'),
    '"C:/Program Files/node.exe" "C:/한글 space/hook.mjs" "anthropic"');
  assert.equal(hookCommand("/tmp/O'Brien/hook.mjs", 'anthropic', 'linux', '/usr/bin/node'),
    "'/usr/bin/node' '/tmp/O'\"'\"'Brien/hook.mjs' 'anthropic'");
});

test('local installs leave shared settings untouched when there are no managed handlers', async () => {
  for (const sharedBytes of [null, '{ "permissions": { "allow": [] }, "hooks": { "PreToolUse": [{ "hooks": [] }] } }\n']) {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-local-untouched-'));
    await mkdir(path.join(projectRoot, '.claude'));
    const sharedPath = path.join(projectRoot, '.claude/settings.json');
    await writeFile(path.join(projectRoot, '.claude/settings.local.json'), '{}');
    if (sharedBytes !== null) {
      await writeFile(sharedPath, sharedBytes);
      await utimes(sharedPath, new Date('2000-01-01'), new Date('2000-01-01'));
    }
    const before = sharedBytes !== null ? await stat(sharedPath) : null;
    for (let i = 0; i < 2; i++) {
      const result = await installProject({ projectRoot, target: 'claude' });
      assert.ok(!result.installed.includes('.claude/settings.json'));
      if (sharedBytes === null) {
        await assert.rejects(() => access(sharedPath), /ENOENT/);
      } else {
        assert.equal(await readFile(sharedPath, 'utf8'), sharedBytes);
        assert.equal((await stat(sharedPath)).mtimeMs, before.mtimeMs);
      }
    }
  }
});

test('local installs reject malformed shared or local hook settings before any writes', async () => {
  for (const malformedName of ['settings.json', 'settings.local.json']) {
    for (const malformed of ['{ broken', '[]', '{"hooks": []}', '{"hooks":{"PreToolUse":{}}}', '{"hooks":{"Stop":[{"hooks":{}}]}}', '{"hooks":{"PreToolUse":[{"hooks":[null]}]}}']) {
      const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-local-malformed-'));
      await mkdir(path.join(projectRoot, '.claude'));
      const expected = {};
      for (const name of ['settings.json', 'settings.local.json']) {
        expected[name] = name === malformedName ? malformed : '{}';
        await writeFile(path.join(projectRoot, '.claude', name), expected[name]);
      }
      await assert.rejects(() => installProject({ projectRoot, target: 'both' }), error => {
        assert.ok(error.message.includes(malformedName), error.message);
        return true;
      });
      for (const [name, bytes] of Object.entries(expected)) {
        assert.equal(await readFile(path.join(projectRoot, '.claude', name), 'utf8'), bytes);
      }
      for (const directory of ['.aorch', '.codex', '.claude/skills']) {
        await assert.rejects(() => access(path.join(projectRoot, directory)), /ENOENT/);
      }
    }
  }
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
    const rootSkill = await readFile(path.join(projectRoot, rel), 'utf8');
    assert.match(rootSkill, /original request recipient remains the root lead/, `${rel} must preserve lead identity`);
    assert.match(rootSkill, /Before planning or delegation, read/, `${rel} must require the common workflow first`);
    assert.match(rootSkill, /receipt is a claim/, `${rel} must retain the inline acceptance boundary`);
    assert.match(rootSkill, /write isolation and change guards intact/, `${rel} must retain inline safety boundaries`);
    assert.match(rootSkill, /Do not commit while a dispatch runs/, `${rel} must retain the inline HEAD boundary`);
    const skill = rootSkill + await readFile(path.join(projectRoot, '.aorch/workflow.md'), 'utf8');
    assert.match(skill, /aorch decompose --print-schema/, `${rel} must point at the plan contract`);
    assert.match(skill, /aorch dispatch --plan/, `${rel} must dispatch the plan`);
    assert.match(skill, /`agentRole`/, `${rel} must ask for agentRole`);
    assert.match(skill, /Never write `role` yourself/, `${rel} must forbid a hand-written role`);
    assert.match(skill, /Native agents may share context/, `${rel} must permit native analysis`);

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
    assert.match(skill, /\.aorch\/workflow\.md/, `${rel} must point at the shared workflow`);
    assert.match(await readFile(path.join(projectRoot, '.aorch/workflow.md'), 'utf8'), /examples\/plan-oss-adoption\.json/);
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
