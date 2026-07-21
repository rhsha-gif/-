import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runReleaseHarness } from '../scripts/release-harness.mjs';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function createRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'a3 harness path with spaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'harness@example.test']);
  git(root, ['config', 'user.name', 'Release Harness Test']);
  await writeFile(path.join(root, '.gitignore'), '.release-harness/\n');
  await writeFile(path.join(root, 'source.txt'), 'frozen source\n');
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '--message', 'baseline']);
  return root;
}

test('records an argv run from a path with spaces with full source SHA and tool versions', async (t) => {
  const root = await createRepository(t);
  const expectedSha = git(root, ['rev-parse', 'HEAD']);
  const argv = [
    process.execPath,
    '-e',
    "if (process.argv[1] !== 'argument with spaces') process.exit(9)",
    'argument with spaces'
  ];

  const result = await runReleaseHarness({
    root,
    runId: 'argv-space-fixture',
    commands: [{ name: 'argv-space', argv }]
  });

  assert.equal(result.status, 'pass');
  assert.equal(result.sourceSha, expectedSha);
  assert.match(result.sourceSha, /^[0-9a-f]{40,64}$/);
  assert.match(result.toolVersions.node, /^v\d+/);
  assert.match(result.toolVersions.git, /^git version /);
  assert.deepEqual(result.commands[0].argv, argv);
  assert.equal(result.commands[0].sourceSha, expectedSha);
  assert.deepEqual(result.commands[0].toolVersions, result.toolVersions);

  const persisted = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  assert.equal(persisted.sourceSha, expectedSha);
  assert.deepEqual(persisted.toolVersions, result.toolVersions);
  assert.deepEqual(persisted.commands[0].argv, argv);
});

test('keeps release-harness evidence as ignored output', async () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ignoreRules = await readFile(path.join(repositoryRoot, '.gitignore'), 'utf8');

  assert.match(ignoreRules, /^\.release-harness\/$/m);
});
