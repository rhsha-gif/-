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
