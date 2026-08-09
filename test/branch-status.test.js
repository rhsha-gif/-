import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { detectMainBranch, collectBranches, computeBranchStatus } from '../src/branch-status.js';

const execFileAsync = promisify(execFile);
async function git(cwd, ...args) { return execFileAsync('git', args, { cwd }); }

async function repo(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-branch-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await git(cwd, 'init', '--quiet', '--initial-branch=main');
  await writeFile(path.join(cwd, 'a.txt'), 'a\n');
  await git(cwd, 'add', '.');
  await git(cwd, '-c', 'user.name=T', '-c', 'user.email=t@t.invalid', 'commit', '--quiet', '-m', 'init');
  return cwd;
}

test('detectMainBranch honours an explicit configured name', async (t) => {
  const cwd = await repo(t);
  assert.deepEqual(await detectMainBranch(cwd, 'develop'), { mainBranch: 'develop', confident: true });
});

test('detectMainBranch falls back to a local main when no origin/HEAD', async (t) => {
  const cwd = await repo(t);
  assert.deepEqual(await detectMainBranch(cwd, null), { mainBranch: 'main', confident: true });
});

test('detectMainBranch is unconfident when it cannot tell', async (t) => {
  const cwd = await repo(t);
  await git(cwd, 'branch', '-m', 'main', 'wip');   // no main/master, no origin
  assert.deepEqual(await detectMainBranch(cwd, null), { mainBranch: null, confident: false });
});

test('collectBranches reports ahead/behind, merged, and cleanup candidates', async (t) => {
  const cwd = await repo(t);                 // main has 1 commit
  await git(cwd, 'checkout', '--quiet', '-b', 'merged-feature');
  await writeFile(path.join(cwd, 'b.txt'), 'b\n');
  await git(cwd, 'add', '.');
  await git(cwd, '-c', 'user.name=T', '-c', 'user.email=t@t.invalid', 'commit', '--quiet', '-m', 'feature');
  await git(cwd, 'checkout', '--quiet', 'main');
  await git(cwd, 'merge', '--no-ff', '--quiet', '-m', 'merge feature', 'merged-feature');

  const { branches, cleanupCandidates } = await collectBranches(cwd, 'main', { staleDays: 30, nowMs: Date.parse('2026-08-09T00:00:00Z') });
  const merged = branches.find((b) => b.name === 'merged-feature');
  assert.equal(merged.mergedIntoMain, true);
  assert.ok(cleanupCandidates.mergedLocal.includes('merged-feature'));
  assert.ok(!cleanupCandidates.mergedLocal.includes('main'));
});

test('computeBranchStatus flags on-main position risk and a clean tree', async (t) => {
  const cwd = await repo(t);   // on main, clean
  const status = await computeBranchStatus({ cwd, config: {}, nowMs: Date.parse('2026-08-09T00:00:00Z') });
  assert.equal(status.currentBranch, 'main');
  assert.equal(status.mainBranch, 'main');
  assert.equal(status.positionRisk, 'on-main');
  assert.equal(status.workingTreeClean, true);
  assert.equal(status.repoIntegration, 'direct');   // no origin remote in temp repo
});

test('computeBranchStatus recommends finish when ahead of main on a clean feature branch', async (t) => {
  const cwd = await repo(t);
  await git(cwd, 'checkout', '--quiet', '-b', 'feat/x');
  await writeFile(path.join(cwd, 'c.txt'), 'c\n');
  await git(cwd, 'add', '.');
  await git(cwd, '-c', 'user.name=T', '-c', 'user.email=t@t.invalid', 'commit', '--quiet', '-m', 'work');
  const status = await computeBranchStatus({ cwd, config: {}, nowMs: Date.parse('2026-08-09T00:00:00Z') });
  assert.equal(status.positionRisk, null);
  assert.equal(status.recommendedAction, 'finish');
});
