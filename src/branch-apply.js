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
