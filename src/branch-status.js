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
