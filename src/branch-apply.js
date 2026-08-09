import { runGit } from './change-guard.js';
import { computeBranchStatus } from './branch-status.js';
import { runVerificationCommands } from './verify.js';

const ACTIONS = new Set(['start', 'finish', 'cleanup', 'sync']);

export async function applyBranchAction({ cwd, config = {}, action, approved = false, options = {} } = {}) {
  if (!ACTIONS.has(action)) throw new Error(`Unknown branch action: ${action}`);
  const planners = { start: planStart, finish: planFinish };   // cleanup/sync added in later tasks
  const planner = planners[action];
  if (!planner) throw new Error(`Branch action not implemented: ${action}`);
  const { plan, run, blockers, verifyBlocking } = await planner({ cwd, config, options });
  if (blockers.length > 0) return { action, executed: false, plan, performed: [], blockers };
  if (approved !== true) return { action, executed: false, plan, performed: [], blockers: [] };
  // A finish gates the merge on a green verify run; run it only at execution
  // time (not for a plan-only preview), and treat a red gate as a blocker
  // rather than a thrown error so the caller gets structured evidence.
  if (verifyBlocking) {
    // Consult the gate whenever finish declares one. With no commands
    // configured, runVerificationCommands passes vacuously (an ungated merge is
    // the config's own choice); a real command set — or an injected gate —
    // that fails blocks the merge.
    const gate = await verifyBlocking.runVerify({
      commands: verifyBlocking.commands,
      cwd,
      timeoutMs: config.verification?.commandTimeoutMs
    });
    if (!gate.passed) return { action, executed: false, plan, performed: [], blockers: ['verification gate failed'] };
  }
  const outcome = await run();
  const performed = Array.isArray(outcome) ? outcome : outcome.performed;
  const undo = Array.isArray(outcome) ? undefined : outcome.undo;
  return { action, executed: true, plan, performed, blockers: [], ...(undo ? { undo } : {}) };
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

async function planFinish({ cwd, config, options }) {
  const status = await computeBranchStatus({ cwd, config });
  const branch = status.currentBranch;
  const main = status.mainBranch;
  const blockers = [];
  if (!branch || branch === main) blockers.push('finish must run on a feature branch, not main/detached');
  if (!status.workingTreeClean) blockers.push('finish requires a clean working tree');
  const current = status.branches.find((b) => b.name === branch);
  if (branch && branch !== main && (!current || current.ahead === 0)) {
    blockers.push('nothing to finish: branch is not ahead of main');
  }

  const commands = options.verificationCommands ?? config.branch?.verificationCommands ?? [];
  const runVerify = options.runVerificationImpl ?? runVerificationCommands;
  const hasRemote = current?.hasRemote || status.branches.find((b) => b.name === main)?.hasRemote;

  const plan = [
    `run verification gate (${commands.length} command(s))`,
    `git switch ${main}`,
    `git merge --no-ff ${branch}`,
    ...(hasRemote ? [`git push origin ${main}`] : []),
    `git branch -d ${branch}`
  ];

  const run = async () => {
    const performed = [];
    const must = async (args, label) => {
      const r = await runGit(args, cwd);
      if (r.exitCode !== 0) throw new Error(`finish failed at ${label}: ${(r.stderr || r.stdout).trim()}`);
      performed.push(label);
    };
    // Record where main was so the caller can undo the merge if needed.
    const preMerge = await runGit(['rev-parse', main], cwd);
    await must(['switch', main], `switch ${main}`);
    await must(['merge', '--no-ff', '-m', `Merge ${branch}`, branch], `merge ${branch}`);
    if (hasRemote) await must(['push', 'origin', main], `push ${main}`);
    await must(['branch', '-d', branch], `delete ${branch}`);
    return { performed, undo: { preMergeMainSha: preMerge.stdout.trim() } };
  };

  return { plan, run, blockers, verifyBlocking: { commands, runVerify } };
}
