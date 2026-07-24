import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from './executor.js';

function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return createHash('sha256').update(input).digest('hex');
}

function normalizePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function ignored(filePath, ignorePaths) {
  const normalized = normalizePath(filePath);
  return ignorePaths.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

async function fileFingerprint(filePath) {
  try {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink()) return `symlink:${await readlink(filePath)}`;
    if (stat.isFile()) return `file:${sha256(await readFile(filePath))}`;
    if (stat.isDirectory()) return 'directory';
    return `other:${stat.mode}:${stat.size}`;
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

function parsePorcelain(raw) {
  const records = raw.split('\0').filter(Boolean);
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    const filePath = normalizePath(record.slice(3));
    entries.push({ status, path: filePath });
    if (status.includes('R') || status.includes('C')) {
      const previous = records[index + 1];
      if (previous) {
        entries.push({ status: `${status}:source`, path: normalizePath(previous) });
        index += 1;
      }
    }
  }
  return entries;
}

async function gitCommand(args, { cwd, stdin = null, timeoutMs = 10000 } = {}) {
  return runCommand({
    command: 'git',
    args,
    stdin,
    env: { AORCH_WORKER: '1', AORCH_VERIFIER: '1' }
  }, { cwd, timeoutMs });
}

async function resolveGitPath(cwd, value) {
  const resolved = path.resolve(cwd, value.trim());
  try { return await realpath(resolved); }
  catch { return resolved; }
}

export async function inspectWorkspaceIsolation(cwd = process.cwd()) {
  try {
    const probe = await gitCommand(['rev-parse', '--is-inside-work-tree'], { cwd });
    if (probe.exitCode !== 0 || probe.stdout.trim() !== 'true') {
      return { available: false, linkedWorktree: false, submodule: false, reason: 'not a git worktree' };
    }
    const [gitDirResult, commonDirResult, superprojectResult] = await Promise.all([
      gitCommand(['rev-parse', '--git-dir'], { cwd }),
      gitCommand(['rev-parse', '--git-common-dir'], { cwd }),
      gitCommand(['rev-parse', '--show-superproject-working-tree'], { cwd })
    ]);
    if (gitDirResult.exitCode !== 0 || commonDirResult.exitCode !== 0) {
      return { available: false, linkedWorktree: false, submodule: false, reason: 'unable to inspect git directories' };
    }
    const gitDir = await resolveGitPath(cwd, gitDirResult.stdout);
    const commonDir = await resolveGitPath(cwd, commonDirResult.stdout);
    const submodule = superprojectResult.exitCode === 0 && superprojectResult.stdout.trim() !== '';
    return {
      available: true,
      linkedWorktree: !submodule && gitDir !== commonDir,
      submodule,
      gitDir,
      commonDir
    };
  } catch (error) {
    return { available: false, linkedWorktree: false, submodule: false, reason: error.message };
  }
}

export async function captureWorkspaceState(cwd, { ignorePaths = [] } = {}) {
  const normalizedIgnore = ignorePaths.map(normalizePath).filter(Boolean);
  try {
    const probe = await gitCommand(['rev-parse', '--is-inside-work-tree'], { cwd });
    if (probe.exitCode !== 0 || probe.stdout.trim() !== 'true') {
      return { available: false, kind: 'none', reason: 'not a git worktree', entries: {} };
    }
    const headResult = await gitCommand(['rev-parse', 'HEAD'], { cwd });
    const head = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
    const statusResult = await gitCommand(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd });
    if (statusResult.exitCode !== 0) {
      return { available: false, kind: 'git', reason: statusResult.stderr.trim() || 'git status failed', entries: {} };
    }
    const entries = {};
    for (const entry of parsePorcelain(statusResult.stdout)) {
      if (!entry.path || ignored(entry.path, normalizedIgnore)) continue;
      entries[entry.path] = {
        status: entry.status,
        fingerprint: await fileFingerprint(path.join(cwd, entry.path))
      };
    }
    return { available: true, kind: 'git', head, entries };
  } catch (error) {
    return { available: false, kind: 'none', reason: error.message, entries: {} };
  }
}

export function changedPathsBetween(beforeState, afterState) {
  if (!beforeState?.available || !afterState?.available) return null;
  const before = beforeState.entries ?? {};
  const after = afterState.entries ?? {};
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths]
    .filter((filePath) => JSON.stringify(before[filePath] ?? null) !== JSON.stringify(after[filePath] ?? null))
    .sort();
}

// Cheap claim-versus-reality guard built only on `git status`: a read-only task
// must not have written anything, a worker must not commit, and a write task's
// claimed file set must match what actually changed. This is the quality-floor
// safety net, not an attestation of trust.
export function validateClaimedChanges({ task, receipt, beforeState, afterState }) {
  if (task.write === true && (!beforeState?.available || !afterState?.available)) {
    throw new Error('Write-task claims require before/after workspace snapshots; '
      + 'only the aorch exec flow captures them');
  }
  if (beforeState?.available && afterState?.available && beforeState.head !== afterState.head) {
    throw new Error('Bounded worker changed Git HEAD; commits are not allowed during task execution');
  }

  const actual = changedPathsBetween(beforeState, afterState);
  if (actual === null) return { status: 'not-available', actualChangedFiles: [] };
  const claimed = [...new Set((receipt.filesChanged ?? []).map(normalizePath))].sort();
  if (JSON.stringify(actual) !== JSON.stringify(claimed)) {
    throw new Error(`Worker claim does not match actual changes; claimed=${claimed.join(',') || '<none>'}; actual=${actual.join(',') || '<none>'}`);
  }
  if (task.write !== true && actual.length > 0) {
    throw new Error(`Read-only worker changed files: ${actual.join(', ')}`);
  }
  return { status: 'verified', actualChangedFiles: actual };
}

function buildShellCommand(command) {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', command],
      stdin: null,
      env: { AORCH_WORKER: '1', AORCH_VERIFIER: '1' }
    };
  }
  // Non-login shell: the child inherits the orchestrator's environment; a login
  // shell could source user profiles that print into captured output.
  return {
    command: '/bin/sh',
    args: ['-c', command],
    stdin: null,
    env: { AORCH_WORKER: '1', AORCH_VERIFIER: '1' }
  };
}

export class VerificationError extends Error {
  constructor(message, verification) {
    super(message);
    this.name = 'VerificationError';
    this.verification = verification;
  }
}

// The verification gate: run the task's own verification commands in the
// workspace and pass only if they all succeed. "Run the tests, do not ask an
// LLM." No hidden checks, no attestation digests, no isolated replay.
export async function runVerificationGate({
  commands = [],
  cwd = process.cwd(),
  timeoutMs = 15 * 60 * 1000,
  onStep
}) {
  const checks = [];
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    const result = await runCommand(buildShellCommand(command), { cwd, timeoutMs });
    checks.push({
      command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs
    });
    onStep?.(index + 1, commands.length);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new VerificationError(`Verification command failed: ${command}`, { status: 'fail', checks });
    }
  }
  return { status: 'pass', checks };
}
