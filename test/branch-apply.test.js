import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { applyBranchAction } from '../src/branch-apply.js';

const execFileAsync = promisify(execFile);
async function git(cwd, ...args) { return execFileAsync('git', args, { cwd }); }
async function repo(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-apply-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await git(cwd, 'init', '--quiet', '--initial-branch=main');
  await writeFile(path.join(cwd, 'a.txt'), 'a\n');
  await git(cwd, 'add', '.');
  await git(cwd, '-c', 'user.name=T', '-c', 'user.email=t@t.invalid', 'commit', '--quiet', '-m', 'init');
  return cwd;
}

test('apply refuses to execute without explicit approval', async (t) => {
  const cwd = await repo(t);
  const result = await applyBranchAction({
    cwd, config: {}, action: 'start', approved: false, options: { name: 'feat/x' }
  });
  assert.equal(result.executed, false);
  assert.ok(Array.isArray(result.plan) && result.plan.length > 0);
  // no new branch created
  const branches = (await git(cwd, 'branch', '--format=%(refname:short)')).stdout;
  assert.ok(!branches.includes('feat/x'));
});

test('start creates the branch from main and carries uncommitted work via stash', async (t) => {
  const cwd = await repo(t);
  await writeFile(path.join(cwd, 'wip.txt'), 'wip\n');    // uncommitted
  const result = await applyBranchAction({
    cwd, config: {}, action: 'start', approved: true, options: { name: 'feat/y' }
  });
  assert.equal(result.executed, true);
  const current = (await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
  assert.equal(current, 'feat/y');
  // the uncommitted file followed us onto the new branch
  const status = (await git(cwd, 'status', '--porcelain')).stdout;
  assert.ok(status.includes('wip.txt'));
});

async function bareRemote(t, cwd) {
  const remote = await mkdtemp(path.join(os.tmpdir(), 'aorch-remote-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  await git(remote, 'init', '--quiet', '--bare');
  await git(cwd, 'remote', 'add', 'origin', remote);
  await git(cwd, 'push', '--quiet', '-u', 'origin', 'main');
  return remote;
}

test('finish merges to main and pushes only when the verify gate passes', async (t) => {
  const cwd = await repo(t);
  await bareRemote(t, cwd);
  await git(cwd, 'checkout', '--quiet', '-b', 'feat/done');
  await writeFile(path.join(cwd, 'd.txt'), 'd\n');
  await git(cwd, 'add', '.');
  await git(cwd, '-c', 'user.name=T', '-c', 'user.email=t@t.invalid', 'commit', '--quiet', '-m', 'done');

  const passingVerify = async () => ({ passed: true, results: [] });
  const result = await applyBranchAction({
    cwd, config: {}, action: 'finish', approved: true,
    options: { runVerificationImpl: passingVerify }
  });
  assert.equal(result.executed, true);
  assert.equal((await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim(), 'main');
  const branches = (await git(cwd, 'branch', '--format=%(refname:short)')).stdout;
  assert.ok(!branches.includes('feat/done'));            // deleted after merge
  assert.ok(result.undo && typeof result.undo.preMergeMainSha === 'string');
});

test('finish is blocked when the verify gate fails', async (t) => {
  const cwd = await repo(t);
  await git(cwd, 'checkout', '--quiet', '-b', 'feat/red');
  await writeFile(path.join(cwd, 'e.txt'), 'e\n');
  await git(cwd, 'add', '.');
  await git(cwd, '-c', 'user.name=T', '-c', 'user.email=t@t.invalid', 'commit', '--quiet', '-m', 'red');
  const failingVerify = async () => ({ passed: false, results: [{ command: 'npm test', exitCode: 1 }] });
  const result = await applyBranchAction({
    cwd, config: {}, action: 'finish', approved: true, options: { runVerificationImpl: failingVerify }
  });
  assert.equal(result.executed, false);
  assert.ok(result.blockers.some((b) => /verif/i.test(b)));
});
