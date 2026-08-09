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
