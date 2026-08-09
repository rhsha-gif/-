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
  // Catch up before finishing: a branch behind main must sync first, so a
  // diverged (ahead AND behind) branch is never sent straight into a finish
  // merge that could conflict on main.
  else if (current && current.behind > 0) recommendedAction = 'sync';
  else if (current && current.ahead > 0 && workingTreeClean) recommendedAction = 'finish';

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
