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
