import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runReleaseHarness, verifyReleaseManifest } from '../scripts/release-harness.mjs';

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

test('does not report a release with zero commands as passing', async (t) => {
  const root = await createRepository(t);
  const result = await runReleaseHarness({ root, runId: 'zero-commands-fixture', commands: [] });

  assert.equal(result.status, 'inconclusive');
});

test('CLI runs the default npm check as argv and emits verifiable evidence', async (t) => {
  const root = await createRepository(t);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { check: "node -e \"process.exit(0)\"" }
  }));
  git(root, ['add', 'package.json']);
  git(root, ['commit', '--quiet', '--message', 'add check command']);
  const harnessPath = fileURLToPath(new URL('../scripts/release-harness.mjs', import.meta.url));
  const invocation = spawnSync(process.execPath, [harnessPath, '--root', root], { encoding: 'utf8' });

  assert.equal(invocation.status, 0, invocation.stderr);
  const result = JSON.parse(invocation.stdout);
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.commands[0].argv.slice(-2), ['run', 'check']);
  await verifyReleaseManifest(result.manifestPath, { sourceSha: result.sourceSha });
});

test('preserves completed evidence when a later argv command times out', async (t) => {
  const root = await createRepository(t);
  const result = await runReleaseHarness({
    root,
    runId: 'partial-timeout-fixture',
    timeoutMs: 1_000,
    commands: [
      { name: 'completed', argv: [process.execPath, '-e', 'process.exit(0)'] },
      { name: 'timeout', argv: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 4_000)'] }
    ]
  });

  assert.equal(result.status, 'fail');
  assert.equal(result.commands.length, 2);
  assert.equal(result.commands[0].exitCode, 0);
  assert.equal(result.commands[0].timedOut, false);
  assert.equal(result.commands[1].timedOut, true);
  assert.equal(result.commands[1].sourceSha, result.sourceSha);
  assert.deepEqual(result.commands[1].toolVersions, result.toolVersions);
});

test('rejects a source mutation after the source SHA is frozen', async (t) => {
  const root = await createRepository(t);
  const sourceSha = git(root, ['rev-parse', 'HEAD']);
  const result = await runReleaseHarness({
    root,
    runId: 'source-mutation-fixture',
    commands: [{
      name: 'mutate-source',
      argv: [process.execPath, '-e', "require('node:fs').writeFileSync('source.txt', 'mutated source\\n')"]
    }]
  });

  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection, 'source-mutated-after-freeze');
  assert.equal(result.sourceSha, sourceSha);
  assert.equal(result.commands.length, 1);
  assert.match(git(root, ['status', '--porcelain=v1']), /source\.txt/);
});

test('rejects output path traversal and a symlinked evidence directory', async (t) => {
  const root = await createRepository(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'a3 harness outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));

  await assert.rejects(
    () => runReleaseHarness({ root, runId: 'path-traversal-fixture', outputDirectory: '../outside', commands: [] }),
    /output directory must stay inside the source root/i
  );

  const evidenceLink = path.join(root, '.release-harness');
  await symlink(outside, evidenceLink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await lstat(evidenceLink)).isSymbolicLink(), true);
  await assert.rejects(
    () => runReleaseHarness({ root, runId: 'symlink-fixture', commands: [] }),
    /symlink/i
  );
});

test('rejects a manifest bound to the wrong full source SHA', async (t) => {
  const root = await createRepository(t);
  const result = await runReleaseHarness({ root, runId: 'wrong-sha-fixture', commands: [] });
  const wrongSha = '0'.repeat(result.sourceSha.length);
  const tampered = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  tampered.sourceSha = wrongSha;
  await writeFile(result.manifestPath, `${JSON.stringify(tampered)}\n`);

  await assert.rejects(
    () => verifyReleaseManifest(result.manifestPath, { sourceSha: result.sourceSha }),
    /source SHA/i
  );
});

test('does not reuse a stale generic evidence filename', async (t) => {
  const root = await createRepository(t);
  const genericPath = path.join(root, '.release-harness', 'manifest.json');
  const stale = `${JSON.stringify({ schemaVersion: 1, sourceSha: '0'.repeat(40) })}\n`;
  await mkdir(path.dirname(genericPath), { recursive: true });
  await writeFile(genericPath, stale);

  const result = await runReleaseHarness({ root, runId: 'fresh-evidence-fixture', commands: [] });
  assert.notEqual(result.manifestPath, genericPath);
  assert.equal(await readFile(genericPath, 'utf8'), stale);
  await assert.rejects(
    () => verifyReleaseManifest(genericPath, { sourceSha: result.sourceSha }),
    /source SHA/i
  );
});

test('rejects an evidence run ID collision and traversal', async (t) => {
  const root = await createRepository(t);
  const runId = 'collision-fixture';
  await runReleaseHarness({ root, runId, commands: [] });

  await assert.rejects(
    () => runReleaseHarness({ root, runId, commands: [] }),
    /already exists/i
  );
  await assert.rejects(
    () => runReleaseHarness({ root, runId: '../escape', commands: [] }),
    /run ID/i
  );
});

test('cleans up child-process descendants when a command times out', async (t) => {
  const root = await createRepository(t);
  let descendantPid = null;
  let descendantReaped = false;
  t.after(() => {
    if (descendantPid !== null && !descendantReaped) {
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill.exe', ['/pid', String(descendantPid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          process.kill(descendantPid, 'SIGKILL');
        }
      } catch {}
    }
  });
  const parentCode = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' });",
    'console.log(child.pid);',
    'setInterval(() => {}, 1_000);'
  ].join(' ');

  const result = await runReleaseHarness({
    root,
    runId: 'descendant-cleanup-fixture',
    timeoutMs: 3_000,
    commands: [{ name: 'spawns-descendant', argv: [process.execPath, '-e', parentCode] }]
  });
  descendantPid = Number(result.commands[0].stdout.trim());
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(result.status, 'fail');
  assert.equal(result.commands[0].timedOut, true);
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
  assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' });
  descendantReaped = true;
});
