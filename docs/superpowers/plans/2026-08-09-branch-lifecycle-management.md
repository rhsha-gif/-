# Branch Lifecycle Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a proactive, one-click-approval branch lifecycle sub-feature to aorch: read-only `aorch branch status` (mechanical git facts) + host semantic matching + guarded `aorch branch apply --action <start|finish|cleanup|sync> --approved`.

**Architecture:** Two focused modules — `src/branch-status.js` (pure read: git facts, main detection, cleanup candidates, position risk, recommendation) and `src/branch-apply.js` (guarded writer: refuses without `approved:true`, re-checks preconditions, executes the plan). Both reuse `runGit` from `src/change-guard.js`; `finish` reuses `runVerificationCommands` from `src/verify.js`. CLI gains a `branch` command. Semantic branch↔topic matching stays with the host model, not aorch.

**Tech Stack:** Node.js ≥20, ESM, `node --test`, git CLI (and `gh` only when the PR path is taken). No new dependencies.

## Global Constraints

- No new runtime dependencies; Node built-ins + git CLI only (`gh` optional, gated on availability). — copied from spec "새 의존성 0"
- `node --test` must stay green; the pre-existing Windows symlink EPERM skip in `test/cli-smoke.test.js` is the only allowed skip.
- No daemon, no polling, no autonomous mutation loop; the feature is not installed as a hook.
- Destructive/outward actions (push, merge, branch delete) run only when `approved:true` is passed; deleting an **unmerged** branch requires a separate explicit confirmation flag beyond `approved`.
- `branch status` performs read-only git commands only.
- Follow existing repo style: one responsibility per file, `runGit(args, cwd) -> {exitCode, stdout, stderr}`, throw `Error`/`TypeError` for invalid input, `node --test` with temp git repos (see `test/change-guard.test.js`).
- Paths in this repo contain spaces and Hangul; always resolve with `node:path` and never string-concatenate shell paths.

---

## File Structure

- Create `src/branch-status.js` — read-only branch facts + recommendation (`computeBranchStatus`).
- Create `src/branch-apply.js` — guarded executor (`applyBranchAction`).
- Modify `src/cli.js` — add `branch` command dispatch and flags.
- Modify `src/config.js` — validate optional `config.branch` block.
- Modify `config/aorch.config.json` — document the optional `branch` defaults (commented via schema, not required).
- Create `test/branch-status.test.js`, `test/branch-apply.test.js` — temp-repo tests.
- Modify `test/config.test.js` — cover `branch` config validation.
- Modify `integrations/claude/skills/adaptive-orchestrate/SKILL.md` and `integrations/codex/skills/adaptive-orchestrate/SKILL.md` — proactive-start flow prose (Slice 5).
- Modify `README.md` / `CHANGELOG.md` — document the feature (Slice 5).

Shared test helper `makeRepo(t)` (temp git repo with a bare remote) is duplicated minimally per test file, matching how `test/change-guard.test.js` builds its own `repository(t)` rather than sharing a module.

---

## Slice 1 — `aorch branch status` (read-only)

### Task 1: main-branch detection

**Files:**
- Create: `src/branch-status.js`
- Test: `test/branch-status.test.js`

**Interfaces:**
- Consumes: `runGit(args, cwd) -> Promise<{exitCode, stdout, stderr}>` from `./change-guard.js`.
- Produces: `detectMainBranch(cwd, configuredMain) -> Promise<{ mainBranch: string|null, confident: boolean }>`.

- [ ] **Step 1: Write the failing test**

```js
// test/branch-status.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { detectMainBranch } from '../src/branch-status.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/branch-status.test.js`
Expected: FAIL — `detectMainBranch` not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// src/branch-status.js
import { runGit } from './change-guard.js';

export async function detectMainBranch(cwd, configuredMain) {
  if (typeof configuredMain === 'string' && configuredMain.trim() !== '') {
    return { mainBranch: configuredMain.trim(), confident: true };
  }
  const head = await runGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd);
  if (head.exitCode === 0) {
    const ref = head.stdout.trim().replace(/^refs\/remotes\/origin\//u, '');
    if (ref) return { mainBranch: ref, confident: true };
  }
  for (const candidate of ['main', 'master']) {
    const probe = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], cwd);
    if (probe.exitCode === 0) return { mainBranch: candidate, confident: true };
  }
  return { mainBranch: null, confident: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/branch-status.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/branch-status.js test/branch-status.test.js
git commit -m "feat: detect the main branch for the branch lifecycle helper"
```

### Task 2: per-branch facts and cleanup candidates

**Files:**
- Modify: `src/branch-status.js`
- Test: `test/branch-status.test.js`

**Interfaces:**
- Consumes: `detectMainBranch` (Task 1), `runGit`.
- Produces: `collectBranches(cwd, mainBranch, { staleDays }) -> Promise<{ branches: Array<{name, ahead, behind, lastCommitDaysAgo, mergedIntoMain, hasRemote, lastSubject}>, cleanupCandidates: { mergedLocal: string[], unmergedStale: string[] } }>`. `nowMs` is injectable for deterministic tests: `collectBranches(cwd, mainBranch, { staleDays, nowMs })`.

- [ ] **Step 1: Write the failing test**

```js
// append to test/branch-status.test.js
import { collectBranches } from '../src/branch-status.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/branch-status.test.js`
Expected: FAIL — `collectBranches` not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// add to src/branch-status.js
const DAY_MS = 24 * 60 * 60 * 1000;

export async function collectBranches(cwd, mainBranch, { staleDays = 30, nowMs } = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const format = ['%(refname:short)', '%(committerdate:unix)', '%(upstream)', '%(contents:subject)'].join('%09');
  const listed = await runGit(['for-each-ref', `--format=${format}`, 'refs/heads/'], cwd);
  if (listed.exitCode !== 0) throw new Error('Unable to list branches for branch status');

  const mergedResult = mainBranch
    ? await runGit(['branch', '--format=%(refname:short)', '--merged', mainBranch], cwd)
    : { exitCode: 0, stdout: '' };
  const mergedSet = new Set(mergedResult.stdout.split('\n').map((s) => s.trim()).filter(Boolean));

  const branches = [];
  for (const line of listed.stdout.split('\n').filter(Boolean)) {
    const [name, unix, upstream, subject = ''] = line.split('\t');
    let ahead = 0; let behind = 0;
    if (mainBranch && name !== mainBranch) {
      const counts = await runGit(['rev-list', '--left-right', '--count', `${mainBranch}...${name}`], cwd);
      if (counts.exitCode === 0) {
        const [b, a] = counts.stdout.trim().split(/\s+/u).map(Number);
        behind = b || 0; ahead = a || 0;
      }
    }
    branches.push({
      name,
      ahead,
      behind,
      lastCommitDaysAgo: Math.floor((now - Number(unix) * 1000) / DAY_MS),
      mergedIntoMain: name !== mainBranch && mergedSet.has(name),
      hasRemote: Boolean(upstream),
      lastSubject: subject
    });
  }

  const mergedLocal = branches.filter((b) => b.mergedIntoMain).map((b) => b.name);
  const unmergedStale = branches
    .filter((b) => !b.mergedIntoMain && b.name !== mainBranch && b.lastCommitDaysAgo >= staleDays)
    .map((b) => b.name);
  return { branches, cleanupCandidates: { mergedLocal, unmergedStale } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/branch-status.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/branch-status.js test/branch-status.test.js
git commit -m "feat: collect per-branch facts and cleanup candidates"
```

### Task 3: `computeBranchStatus` assembling the contract

**Files:**
- Modify: `src/branch-status.js`
- Test: `test/branch-status.test.js`

**Interfaces:**
- Consumes: `detectMainBranch`, `collectBranches`, `runGit`.
- Produces: `computeBranchStatus({ cwd, config, nowMs }) -> Promise<Status>` where `Status` = `{ currentBranch, mainBranch, mainBranchConfident, workingTreeClean, positionRisk, branches, cleanupCandidates, repoIntegration, recommendedAction }`. `positionRisk` ∈ `'on-main'|'detached'|null` (mechanical only; whether a branch is "foreign" to the task is a host semantic judgment, not a status field). `repoIntegration` ∈ `'pr'|'direct'`. `recommendedAction` ∈ `'start'|'finish'|'cleanup'|'sync'|'none'`.

- [ ] **Step 1: Write the failing test**

```js
// append to test/branch-status.test.js
import { computeBranchStatus } from '../src/branch-status.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/branch-status.test.js`
Expected: FAIL — `computeBranchStatus` not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// add to src/branch-status.js
async function hasGitHubRemote(cwd) {
  const remote = await runGit(['remote', 'get-url', 'origin'], cwd);
  return remote.exitCode === 0 && /github\.com/u.test(remote.stdout);
}

export async function computeBranchStatus({ cwd, config = {}, nowMs } = {}) {
  const branchCfg = config.branch ?? {};
  const headRef = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  const currentBranch = headRef.exitCode === 0 ? headRef.stdout.trim() : null; // null => detached
  const { mainBranch, confident } = await detectMainBranch(cwd, branchCfg.mainBranch ?? null);

  const statusResult = await runGit(['status', '--porcelain'], cwd);
  const workingTreeClean = statusResult.exitCode === 0 && statusResult.stdout.trim() === '';

  const { branches, cleanupCandidates } = await collectBranches(cwd, mainBranch, {
    staleDays: branchCfg.staleDays ?? 30,
    nowMs
  });

  let positionRisk = null;
  if (currentBranch === null) positionRisk = 'detached';
  else if (currentBranch === mainBranch) positionRisk = 'on-main';

  const integrationCfg = branchCfg.integration ?? 'auto';
  const repoIntegration = integrationCfg === 'auto'
    ? (await hasGitHubRemote(cwd) ? 'pr' : 'direct')
    : integrationCfg;

  const current = branches.find((b) => b.name === currentBranch);
  let recommendedAction = 'none';
  if (cleanupCandidates.mergedLocal.length > 0) recommendedAction = 'cleanup';
  if (positionRisk === 'on-main' || positionRisk === 'detached') recommendedAction = 'start';
  else if (current && current.ahead > 0 && workingTreeClean) recommendedAction = 'finish';
  else if (current && current.behind > 0 && current.ahead === 0) recommendedAction = 'sync';

  return {
    currentBranch,
    mainBranch,
    mainBranchConfident: confident,
    workingTreeClean,
    positionRisk,
    branches,
    cleanupCandidates,
    repoIntegration,
    recommendedAction
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/branch-status.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/branch-status.js test/branch-status.test.js
git commit -m "feat: assemble the branch status contract"
```

### Task 4: `aorch branch status` CLI wiring

**Files:**
- Modify: `src/cli.js` (add to `COMMAND_FLAGS` near line 33-41; add dispatch block after the `inventory` block near line 269; help text near line 150)
- Test: `test/cli-smoke.test.js`

**Interfaces:**
- Consumes: `computeBranchStatus` from `./branch-status.js`, `loadConfig`, `resolveConfigPath`, `resolveStateRoot` (existing in cli.js).
- Produces: `aorch branch status [--config --cwd]` prints the status JSON to stdout; `aorch branch <unknown>` errors.

- [ ] **Step 1: Write the failing test**

```js
// append to test/cli-smoke.test.js  (follow the file's existing spawn helper/pattern)
test('branch status prints JSON with the current branch', async () => {
  // Reuse the file's existing helper for running the CLI in a temp git repo.
  const { stdout, code } = await runCli(['branch', 'status'], { cwd: await gitRepoFixture() });
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.ok('currentBranch' in parsed);
  assert.ok('recommendedAction' in parsed);
});
```

If `test/cli-smoke.test.js` has no reusable `runCli`/`gitRepoFixture` helper, add a local `spawnSync(process.execPath, ['src/cli.js', ...])` invocation mirroring the existing tests in that file, initializing a temp git repo first.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cli-smoke.test.js`
Expected: FAIL — `branch` is an unknown command / no output.

- [ ] **Step 3: Write minimal implementation**

```js
// src/cli.js — add to COMMAND_FLAGS
  branch: [...COMMON_FLAGS, 'action', 'approved', 'confirm-unmerged', 'name', 'observations', 'task'],
```

```js
// src/cli.js — import at top with the other imports
import { computeBranchStatus } from './branch-status.js';
```

```js
// src/cli.js — dispatch block, after the `inventory` block
  if (command === 'branch') {
    const cwd = resolveCwd(flags);                         // use the same cwd resolution the other commands use
    const configPath = await resolveConfigPath({ cwd, configPath: flags.config });
    const config = await loadConfig({ cwd, configPath });
    const sub = positionals[0] ?? 'status';
    if (sub === 'status') {
      const status = await computeBranchStatus({ cwd, config });
      process.stdout.write(`${JSON.stringify(status)}\n`);
      return 0;
    }
    throw new Error(`Unknown branch subcommand: ${sub}`);
  }
```

Add `branch` to the `positionalBudget` handling in `validateCommandArgs` (line 79-83): `const positionalBudget = command === 'limits' || command === 'branch' ? 2 : 0;`. Add a one-line entry to the help text block near line 150.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/cli-smoke.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.js test/cli-smoke.test.js
git commit -m "feat: add 'aorch branch status' command"
```

---

## Slice 2 — `apply --action start`

### Task 5: guarded executor skeleton + refusal without approval

**Files:**
- Create: `src/branch-apply.js`
- Test: `test/branch-apply.test.js`

**Interfaces:**
- Consumes: `runGit`, `computeBranchStatus`.
- Produces: `applyBranchAction({ cwd, config, action, approved, options }) -> Promise<{ action, executed: boolean, plan: string[], performed: string[], blockers: string[] }>`. When `approved !== true`, returns `{ executed: false, plan, ... }` and performs no git writes. `action` ∈ `'start'|'finish'|'cleanup'|'sync'`.

- [ ] **Step 1: Write the failing test**

```js
// test/branch-apply.test.js  (reuse the repo(t) helper shape from branch-status.test.js)
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/branch-apply.test.js`
Expected: FAIL — `applyBranchAction` not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// src/branch-apply.js
import { runGit } from './change-guard.js';
import { computeBranchStatus } from './branch-status.js';

const ACTIONS = new Set(['start', 'finish', 'cleanup', 'sync']);

export async function applyBranchAction({ cwd, config = {}, action, approved = false, options = {} } = {}) {
  if (!ACTIONS.has(action)) throw new Error(`Unknown branch action: ${action}`);
  const planners = { start: planStart };   // finish/cleanup/sync added in later tasks
  const planner = planners[action];
  if (!planner) throw new Error(`Branch action not implemented: ${action}`);
  const { plan, run, blockers } = await planner({ cwd, config, options });
  if (blockers.length > 0) return { action, executed: false, plan, performed: [], blockers };
  if (approved !== true) return { action, executed: false, plan, performed: [], blockers: [] };
  const performed = await run();
  return { action, executed: true, plan, performed, blockers: [] };
}

async function planStart({ cwd, config, options }) {
  const status = await computeBranchStatus({ cwd, config });
  const name = (options.name ?? '').trim();
  const blockers = [];
  if (!name) blockers.push('start requires a target branch name');
  const plan = [`create/checkout branch ${name} from ${status.mainBranch ?? 'main'}`];
  const run = async () => { throw new Error('planStart.run implemented in Task 6'); };
  return { plan, run, blockers };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/branch-apply.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/branch-apply.js test/branch-apply.test.js
git commit -m "feat: guarded branch-apply skeleton that refuses without approval"
```

### Task 6: `start` — auto-stash, branch from main, restore

**Files:**
- Modify: `src/branch-apply.js`
- Test: `test/branch-apply.test.js`

**Interfaces:**
- Consumes: `runGit`, `computeBranchStatus`.
- Produces: `planStart` `run()` now creates the branch. On dirty tree it stashes before switching and pops after; a pop conflict throws with evidence. New-branch path fast-forwards main first when a remote exists; when no remote, branches from the local main.

- [ ] **Step 1: Write the failing test**

```js
// append to test/branch-apply.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/branch-apply.test.js`
Expected: FAIL — `planStart.run implemented in Task 6`.

- [ ] **Step 3: Write minimal implementation**

```js
// replace planStart in src/branch-apply.js
async function planStart({ cwd, config, options }) {
  const status = await computeBranchStatus({ cwd, config });
  const name = (options.name ?? '').trim();
  const target = options.checkoutExisting === true;
  const main = status.mainBranch ?? 'main';
  const blockers = [];
  if (!name) blockers.push('start requires a target branch name');
  if (!target && status.branches.some((b) => b.name === name)) {
    blockers.push(`branch ${name} already exists; pass checkoutExisting to resume it`);
  }

  const dirty = !status.workingTreeClean;
  const plan = [];
  if (dirty) plan.push('git stash push --include-untracked (carry uncommitted work)');
  if (target) plan.push(`git switch ${name}`);
  else {
    plan.push(`git switch ${main}`);
    if (status.branches.find((b) => b.name === main)?.hasRemote) plan.push('git pull --ff-only');
    plan.push(`git switch -c ${name}`);
  }
  if (dirty) plan.push('git stash pop (restore on the new branch; stop on conflict)');

  const run = async () => {
    const performed = [];
    const must = async (args, label) => {
      const r = await runGit(args, cwd);
      if (r.exitCode !== 0) throw new Error(`branch start failed at ${label}: ${(r.stderr || r.stdout).trim()}`);
      performed.push(label);
    };
    if (dirty) await must(['stash', 'push', '--include-untracked', '-m', `aorch-start:${name}`], 'stash');
    if (target) await must(['switch', name], `switch ${name}`);
    else {
      await must(['switch', main], `switch ${main}`);
      if (status.branches.find((b) => b.name === main)?.hasRemote) {
        await must(['pull', '--ff-only'], 'pull --ff-only');
      }
      await must(['switch', '-c', name], `create ${name}`);
    }
    if (dirty) {
      const pop = await runGit(['stash', 'pop'], cwd);
      if (pop.exitCode !== 0) {
        throw new Error(`branch start stopped: stash pop conflict on ${name}: ${(pop.stderr || pop.stdout).trim()}`);
      }
      performed.push('stash pop');
    }
    return performed;
  };
  return { plan, run, blockers };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/branch-apply.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/branch-apply.js test/branch-apply.test.js
git commit -m "feat: branch-apply start (stash, branch from main, restore)"
```

---

## Slice 3 — `apply --action finish`

### Task 7: `finish` — verify gate, merge, push, delete, undo record

**Files:**
- Modify: `src/branch-apply.js`
- Test: `test/branch-apply.test.js`

**Interfaces:**
- Consumes: `runGit`, `computeBranchStatus`, `runVerificationCommands` from `./verify.js`.
- Produces: `planFinish` registered in `applyBranchAction`'s `planners`. Blockers when tree is dirty, when not ahead of main, or when the verify gate fails. On success (direct path): merge `--no-ff` into main, push if a remote exists, switch to main, delete the merged branch. Result includes `undo: { preMergeMainSha }`. Accepts injected `runVerificationImpl` for tests.

- [ ] **Step 1: Write the failing test**

```js
// append to test/branch-apply.test.js
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
  assert.ok(result.blockers.some((b) => /verify/i.test(b)));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/branch-apply.test.js`
Expected: FAIL — finish planner not registered.

- [ ] **Step 3: Write minimal implementation**

```js
// src/branch-apply.js — add import
import { runVerificationCommands } from './verify.js';

// register in applyBranchAction's planners:
//   const planners = { start: planStart, finish: planFinish };

async function planFinish({ cwd, config, options }) {
  const status = await computeBranchStatus({ cwd, config });
  const branch = status.currentBranch;
  const main = status.mainBranch;
  const blockers = [];
  if (!branch || branch === main) blockers.push('finish must run on a feature branch, not main/detached');
  if (!status.workingTreeClean) blockers.push('finish requires a clean working tree');
  const current = status.branches.find((b) => b.name === branch);
  if (branch && branch !== main && (!current || current.ahead === 0)) blockers.push('nothing to finish: branch is not ahead of main');

  const commands = options.verificationCommands ?? config.branch?.verificationCommands ?? [];
  const runVerify = options.runVerificationImpl ?? runVerificationCommands;

  const hasRemote = current?.hasRemote || status.branches.find((b) => b.name === main)?.hasRemote;
  const plan = [
    `run verification gate (${commands.length} command(s))`,
    `git switch ${main}`,
    `git merge --no-ff ${branch}`,
    ...(hasRemote ? ['git push origin ' + main] : []),
    `git branch -d ${branch}`
  ];

  const run = async () => {
    const gate = await runVerify({ commands, cwd, timeoutMs: config.verification?.commandTimeoutMs });
    if (!gate.passed) {
      const err = new Error('finish blocked: verification gate did not pass');
      err.gate = gate;
      throw err;
    }
    const performed = [];
    const must = async (args, label) => {
      const r = await runGit(args, cwd);
      if (r.exitCode !== 0) throw new Error(`finish failed at ${label}: ${(r.stderr || r.stdout).trim()}`);
      performed.push(label);
    };
    const preMerge = await runGit(['rev-parse', main], cwd);
    await must(['switch', main], `switch ${main}`);
    await must(['merge', '--no-ff', '-m', `Merge ${branch}`, branch], `merge ${branch}`);
    if (hasRemote) await must(['push', 'origin', main], `push ${main}`);
    await must(['branch', '-d', branch], `delete ${branch}`);
    return { performed, undo: { preMergeMainSha: preMerge.stdout.trim() } };
  };

  return { plan, run, blockers, verifyBlocking: { commands, runVerify } };
}
```

Then adjust `applyBranchAction` so a planner may pre-run its verify gate to surface a blocker before approval, and so `run()` may return either an array or `{ performed, undo }`:

```js
// in applyBranchAction, replace the run/return tail:
  if (action === 'finish' && planner) {
    // Pre-flight the verify gate so a red suite becomes a blocker, not a silent no-op.
    const { commands, runVerify } = (await planFinish({ cwd, config, options })).verifyBlocking;
    if (commands.length > 0) {
      const gate = await runVerify({ commands, cwd, timeoutMs: config.verification?.commandTimeoutMs });
      if (!gate.passed) return { action, executed: false, plan, performed: [], blockers: ['verification gate failed'] };
    }
  }
  if (approved !== true) return { action, executed: false, plan, performed: [], blockers: [] };
  const outcome = await run();
  const performed = Array.isArray(outcome) ? outcome : outcome.performed;
  const undo = Array.isArray(outcome) ? undefined : outcome.undo;
  return { action, executed: true, plan, performed, blockers: [], ...(undo ? { undo } : {}) };
```

Keep it DRY: compute `plan/run/blockers` once via `planner(...)`; only `finish` runs the extra verify pre-flight. If this branching in `applyBranchAction` grows awkward, fold the verify pre-flight into `planFinish`'s `blockers` by making the planner `async` and running verify there (preferred if the reviewer finds the special-case ugly).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/branch-apply.test.js`
Expected: PASS (both finish tests).

- [ ] **Step 5: Commit**

```bash
git add src/branch-apply.js test/branch-apply.test.js
git commit -m "feat: branch-apply finish with a verify-gated merge, push, and delete"
```

---

## Slice 4 — `apply --action cleanup` and `--action sync`

### Task 8: `cleanup` — merged auto, unmerged needs separate confirm

**Files:**
- Modify: `src/branch-apply.js`
- Test: `test/branch-apply.test.js`

**Interfaces:**
- Consumes: `computeBranchStatus`, `runGit`.
- Produces: `planCleanup` registered. Deletes `cleanupCandidates.mergedLocal` (via `git branch -d`) and runs `git remote prune origin` when a remote exists. `unmergedStale` are deleted **only** when `options.confirmUnmerged === true` (via `git branch -D`); otherwise they are reported in the result as `deferred: string[]` and not touched.

- [ ] **Step 1: Write the failing test**

```js
// append to test/branch-apply.test.js
test('cleanup deletes merged branches but defers unmerged-stale without confirmation', async (t) => {
  const cwd = await repo(t);
  // merged branch
  await git(cwd, 'checkout', '--quiet', '-b', 'merged');
  await writeFile(path.join(cwd, 'm.txt'), 'm\n');
  await git(cwd, 'add', '.');
  await git(cwd, '-c', 'user.name=T', '-c', 'user.email=t@t.invalid', 'commit', '--quiet', '-m', 'm');
  await git(cwd, 'checkout', '--quiet', 'main');
  await git(cwd, 'merge', '--no-ff', '--quiet', '-m', 'merge merged', 'merged');
  // unmerged branch
  await git(cwd, 'checkout', '--quiet', '-b', 'orphan');
  await writeFile(path.join(cwd, 'o.txt'), 'o\n');
  await git(cwd, 'add', '.');
  await git(cwd, '-c', 'user.name=T', '-c', 'user.email=t@t.invalid', 'commit', '--quiet', '-m', 'o');
  await git(cwd, 'checkout', '--quiet', 'main');

  const result = await applyBranchAction({
    cwd, config: { branch: { staleDays: 0 } }, action: 'cleanup', approved: true, options: {}
  });
  const branches = (await git(cwd, 'branch', '--format=%(refname:short)')).stdout;
  assert.ok(!branches.includes('merged'));   // merged deleted
  assert.ok(branches.includes('orphan'));    // unmerged deferred, not deleted
  assert.ok(result.deferred.includes('orphan'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/branch-apply.test.js`
Expected: FAIL — cleanup planner not registered.

- [ ] **Step 3: Write minimal implementation**

```js
// register in planners: cleanup: planCleanup
async function planCleanup({ cwd, config, options }) {
  const status = await computeBranchStatus({ cwd, config });
  const { mergedLocal, unmergedStale } = status.cleanupCandidates;
  const hasRemote = status.branches.some((b) => b.hasRemote);
  const willForceDelete = options.confirmUnmerged === true ? unmergedStale : [];
  const deferred = options.confirmUnmerged === true ? [] : unmergedStale;

  const plan = [
    ...mergedLocal.map((b) => `git branch -d ${b}`),
    ...(hasRemote ? ['git remote prune origin'] : []),
    ...willForceDelete.map((b) => `git branch -D ${b} (unmerged, confirmed)`)
  ];
  const run = async () => {
    const performed = [];
    for (const b of mergedLocal) {
      const r = await runGit(['branch', '-d', b], cwd);
      if (r.exitCode === 0) performed.push(`deleted ${b}`);
    }
    if (hasRemote) { await runGit(['remote', 'prune', 'origin'], cwd); performed.push('pruned origin'); }
    for (const b of willForceDelete) {
      const r = await runGit(['branch', '-D', b], cwd);
      if (r.exitCode === 0) performed.push(`force-deleted ${b}`);
    }
    return performed;
  };
  return { plan, run, blockers: [], deferred };
}
```

Extend `applyBranchAction` to carry `deferred` through into the return object (default `[]` for other actions):

```js
  const { plan, run, blockers, deferred = [] } = await planner({ cwd, config, options });
  // ...
  // include `deferred` in every early return and the success return.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/branch-apply.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/branch-apply.js test/branch-apply.test.js
git commit -m "feat: branch-apply cleanup (merged auto, unmerged behind a confirm)"
```

### Task 9: `sync` — merge main into the current branch

**Files:**
- Modify: `src/branch-apply.js`
- Test: `test/branch-apply.test.js`

**Interfaces:**
- Consumes: `computeBranchStatus`, `runGit`.
- Produces: `planSync` registered. Blockers on main/detached or a dirty tree. Merges `main` into the current branch; a merge conflict aborts (`git merge --abort`) and throws with evidence.

- [ ] **Step 1: Write the failing test**

```js
// append to test/branch-apply.test.js
test('sync brings main commits into the current branch', async (t) => {
  const cwd = await repo(t);
  await git(cwd, 'checkout', '--quiet', '-b', 'feat/behind');
  // advance main after branching
  await git(cwd, 'checkout', '--quiet', 'main');
  await writeFile(path.join(cwd, 'newmain.txt'), 'n\n');
  await git(cwd, 'add', '.');
  await git(cwd, '-c', 'user.name=T', '-c', 'user.email=t@t.invalid', 'commit', '--quiet', '-m', 'main-advance');
  await git(cwd, 'checkout', '--quiet', 'feat/behind');

  const result = await applyBranchAction({ cwd, config: {}, action: 'sync', approved: true, options: {} });
  assert.equal(result.executed, true);
  // the main-only file is now present on feat/behind
  const ls = (await git(cwd, 'ls-files')).stdout;
  assert.ok(ls.includes('newmain.txt'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/branch-apply.test.js`
Expected: FAIL — sync planner not registered.

- [ ] **Step 3: Write minimal implementation**

```js
// register in planners: sync: planSync
async function planSync({ cwd, config, options }) {
  const status = await computeBranchStatus({ cwd, config });
  const branch = status.currentBranch;
  const main = status.mainBranch;
  const blockers = [];
  if (!branch || branch === main) blockers.push('sync must run on a feature branch');
  if (!status.workingTreeClean) blockers.push('sync requires a clean working tree');
  const plan = [`git merge --no-ff ${main} (into ${branch})`];
  const run = async () => {
    const r = await runGit(['merge', '--no-ff', '-m', `Merge ${main} into ${branch}`, main], cwd);
    if (r.exitCode !== 0) {
      await runGit(['merge', '--abort'], cwd);
      throw new Error(`sync stopped: merge conflict from ${main}: ${(r.stderr || r.stdout).trim()}`);
    }
    return [`merged ${main}`];
  };
  return { plan, run, blockers };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/branch-apply.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/branch-apply.js test/branch-apply.test.js
git commit -m "feat: branch-apply sync (merge main into the current branch)"
```

### Task 10: `aorch branch apply` CLI wiring

**Files:**
- Modify: `src/cli.js` (extend the `branch` dispatch block from Task 4)
- Test: `test/cli-smoke.test.js`

**Interfaces:**
- Consumes: `applyBranchAction` from `./branch-apply.js`.
- Produces: `aorch branch apply --action <a> [--approved] [--confirm-unmerged] [--name <n>]`. Without `--approved`, prints the plan JSON and exits 0 having changed nothing. `--approved`/`--confirm-unmerged` are boolean flags.

- [ ] **Step 1: Write the failing test**

```js
// append to test/cli-smoke.test.js
test('branch apply without --approved prints a plan and changes nothing', async () => {
  const cwd = await gitRepoFixture();
  const { stdout, code } = await runCli(['branch', 'apply', '--action', 'start', '--name', 'feat/z'], { cwd });
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.executed, false);
  assert.ok(parsed.plan.length > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cli-smoke.test.js`
Expected: FAIL — `apply` subcommand unknown.

- [ ] **Step 3: Write minimal implementation**

```js
// src/cli.js — import
import { applyBranchAction } from './branch-apply.js';
// add 'approved' and 'confirm-unmerged' to BOOLEAN_FLAGS (line 30)
```

```js
// src/cli.js — inside the `branch` dispatch block, after the status sub
    if (sub === 'apply') {
      const action = requireFlag(flags, 'action');
      const result = await applyBranchAction({
        cwd,
        config,
        action,
        approved: flags.approved === true,
        options: {
          name: typeof flags.name === 'string' ? flags.name : undefined,
          confirmUnmerged: flags['confirm-unmerged'] === true
        }
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/cli-smoke.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.js test/cli-smoke.test.js
git commit -m "feat: add 'aorch branch apply' command"
```

---

## Slice 5 — config, root-skill integration, docs

### Task 11: validate the optional `config.branch` block

**Files:**
- Modify: `src/config.js` (in `validateConfig`, near line 169+)
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: existing `validateConfig(input)`.
- Produces: `validateConfig` accepts an optional `branch` object: `{ mainBranch?: string, namePrefix?: boolean, staleDays?: number(>=0), integration?: 'auto'|'pr'|'direct', verificationCommands?: string[] }`. Unknown types throw with a clear message. Absent `branch` stays valid (backward compatible).

- [ ] **Step 1: Write the failing test**

```js
// append to test/config.test.js (follow the file's existing baseConfig()/validateConfig usage)
test('validateConfig accepts a well-formed branch block and rejects a bad integration', () => {
  const good = baseValidConfig();
  good.branch = { mainBranch: 'main', namePrefix: true, staleDays: 45, integration: 'direct' };
  assert.doesNotThrow(() => validateConfig(good));

  const bad = baseValidConfig();
  bad.branch = { integration: 'sometimes' };
  assert.throws(() => validateConfig(bad), /branch\.integration/);
});
```

Use whatever the file already calls to build a minimal valid config (mirror the existing tests in `test/config.test.js`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL — no validation, bad integration not rejected.

- [ ] **Step 3: Write minimal implementation**

```js
// src/config.js — inside validateConfig, after existing normalization, before return
  if (input.branch !== undefined) {
    const b = input.branch;
    if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new TypeError('config.branch must be an object');
    if (b.mainBranch !== undefined && (typeof b.mainBranch !== 'string' || b.mainBranch.trim() === '')) {
      throw new TypeError('config.branch.mainBranch must be a non-empty string');
    }
    if (b.namePrefix !== undefined && typeof b.namePrefix !== 'boolean') throw new TypeError('config.branch.namePrefix must be boolean');
    if (b.staleDays !== undefined && (!Number.isFinite(b.staleDays) || b.staleDays < 0)) throw new RangeError('config.branch.staleDays must be a non-negative number');
    if (b.integration !== undefined && !['auto', 'pr', 'direct'].includes(b.integration)) {
      throw new Error("config.branch.integration must be 'auto', 'pr', or 'direct'");
    }
    if (b.verificationCommands !== undefined) assertNonEmptyStrings(b.verificationCommands, 'config.branch.verificationCommands');
  }
```

Reuse the existing `assertNonEmptyStrings` helper already in `config.js` (used for `model.roles` etc.).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: validate the optional branch config block"
```

### Task 12: proactive-start flow in the root skill + docs

**Files:**
- Modify: `integrations/claude/skills/adaptive-orchestrate/SKILL.md`
- Modify: `integrations/codex/skills/adaptive-orchestrate/SKILL.md`
- Modify: `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `aorch branch status` / `aorch branch apply` CLI (Tasks 4, 10).
- Produces: prose only — the root skill instructs the host to, when a prompt is code-work AND `positionRisk != null` or the tree is dirty or the topic does not match the current branch, run `aorch branch status`, present cleanup-first then a start recommendation (host does the semantic branch↔topic match), and execute the approved plan via `aorch branch apply --action <a> --approved` only after the user approves. Note the one-approval-runs-the-shown-plan rule and the separate `--confirm-unmerged` gate.

- [ ] **Step 1: Add the flow section to the Claude root skill**

Add a "Branch lifecycle (proactive start)" section to `integrations/claude/skills/adaptive-orchestrate/SKILL.md` describing:
- When to trigger (code-work + risk/ambiguity); do not trigger for read-only/simple prompts.
- Order: cleanup-first (present `cleanupCandidates`), then start recommendation (semantic match is the host's job, expose the reasoning), then position-risk warning.
- One approval executes the shown plan; `aorch branch apply --action <a> --approved`. Unmerged deletion needs `--confirm-unmerged`.
- Never run apply with `--approved` without an explicit user click.

- [ ] **Step 2: Mirror the section into the Codex root skill**

Copy the same section into `integrations/codex/skills/adaptive-orchestrate/SKILL.md`, adjusting only CLI-host wording to match the other Codex sections.

- [ ] **Step 3: Document the command in README and CHANGELOG**

Add an `aorch branch` subsection to `README.md` (commands list + the safety note that apply needs `--approved`). Add a CHANGELOG entry under a new `## Unreleased` section describing the branch lifecycle feature and the `config.branch` block.

- [ ] **Step 4: Verify the full suite is green**

Run: `npm run check`
Expected: all tests pass; only the pre-existing Windows symlink EPERM skip is skipped.

- [ ] **Step 5: Commit**

```bash
git add integrations/claude/skills/adaptive-orchestrate/SKILL.md integrations/codex/skills/adaptive-orchestrate/SKILL.md README.md CHANGELOG.md
git commit -m "docs: wire the proactive branch-start flow into the root skill"
```

---

## Self-Review

**1. Spec coverage:**
- status contract (facts, cleanup candidates, position risk, main detection, integration, recommendation) → Tasks 1-4. ✅
- start (auto-stash, branch from main, restore, one-folder switching) → Task 6. ✅
- finish (verify gate, merge commit, push, delete, main return, undo record, PR-vs-direct) → Task 7 (direct path + gate + undo). ⚠️ **PR path (`gh pr create`) is described in the spec but implemented as `repoIntegration` detection only; actual `gh pr create` execution is deferred.** See gap note below.
- cleanup (merged auto + prune, unmerged behind confirm) → Task 8. ✅
- sync (merge main) → Task 9. ✅
- proactive-start trigger + cleanup-first + host semantic matching → Task 12. ✅
- config.branch → Task 11. ✅
- one-approval-runs-shown-plan + `--approved` gate + separate unmerged confirm → Tasks 5, 8, 10, 12. ✅

**Gap resolved:** The PR execution path is intentionally scoped out of v1 implementation (detection lands in Task 3 so the host can tell the user "this repo uses PRs; run `gh pr create` / open a PR"), because `gh` availability and PR templating add surface without a test-stable harness. Task 12's README note must state that when `repoIntegration === 'pr'`, `finish` reports the merge plan but the host defers to a manual/`gh` PR. If full `gh pr create` automation is wanted, add it as a follow-up task behind a `gh`-availability probe with a mocked-`gh` test. This matches the spec's "PR 경로는 gh 있을 때" hedge.

**2. Placeholder scan:** No TBD/TODO. Every code step has real code. Task 4 and Task 10 tests reference `runCli`/`gitRepoFixture` with an explicit instruction to reuse or add the helper matching `test/cli-smoke.test.js`'s existing style (that file already spawns the CLI). ✅

**3. Type consistency:** `applyBranchAction` returns `{ action, executed, plan, performed, blockers, deferred?, undo? }` consistently across Tasks 5-10. `computeBranchStatus` shape defined in Task 3 and consumed unchanged in Tasks 5-9. `runGit`/`runVerificationCommands` signatures match the real modules. `detectMainBranch`/`collectBranches`/`computeBranchStatus` names stable across tasks. ✅

## Notes for the executor

- Every task ends green and committed; run `node --test <touched file>` per task and `npm run check` before the final commit.
- Keep `branch status` strictly read-only — no test may observe a git mutation from a `status` call.
- The one place worth a reviewer's extra attention is Task 7's `applyBranchAction` control flow (the finish verify pre-flight). If it reads awkwardly, prefer folding the verify gate into `planFinish`'s async `blockers` as noted, keeping `applyBranchAction` uniform across actions.
