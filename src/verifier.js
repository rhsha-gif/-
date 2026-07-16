import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from './executor.js';
import { atomicWriteJson, atomicWriteText } from './file-store.js';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(stableValue(value)));
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

export function validateClaimedChanges({ task, receipt, beforeState, afterState }) {
  if (task.write === true && (!beforeState?.available || !afterState?.available)) {
    throw new Error('Write-task claims require before/after workspace snapshots; '
      + 'only the aorch exec flow captures them, so manual aorch verify cannot attest a write claim');
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
  // Non-login shell: the child inherits the orchestrator's environment, and a
  // login shell could source user profiles that print into the captured
  // stdout/stderr evidence and change PATH between worker and verifier runs.
  return {
    command: '/bin/sh',
    args: ['-c', command],
    stdin: null,
    env: { AORCH_WORKER: '1', AORCH_VERIFIER: '1' }
  };
}

async function copyUntrackedFiles({ sourceRoot, targetRoot, state }) {
  for (const [filePath, entry] of Object.entries(state?.entries ?? {})) {
    if (entry.status !== '??') continue;
    const source = path.join(sourceRoot, filePath);
    const target = path.join(targetRoot, filePath);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true });
  }
}

async function prepareVerificationWorkspace({ cwd, state, isolationMode }) {
  if (isolationMode !== 'git-worktree') {
    return { cwd, isolation: 'same-workspace', cleanup: async () => {} };
  }
  if (!state?.available || state.kind !== 'git' || !state.head) {
    throw new Error('git-worktree verification requires a Git repository with a committed HEAD');
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-verifier-'));
  const worktree = path.join(tempRoot, 'worktree');
  let added = false;
  try {
    const add = await gitCommand(['worktree', 'add', '--detach', worktree, state.head], { cwd, timeoutMs: 30000 });
    if (add.exitCode !== 0) throw new Error(add.stderr.trim() || 'git worktree add failed');
    added = true;

    const patch = await gitCommand(['diff', '--binary', 'HEAD'], { cwd, timeoutMs: 30000 });
    if (patch.exitCode !== 0) throw new Error(patch.stderr.trim() || 'git diff failed');
    if (patch.stdout.length > 0) {
      const apply = await gitCommand(['apply', '--binary', '--whitespace=nowarn', '-'], {
        cwd: worktree,
        stdin: patch.stdout,
        timeoutMs: 30000
      });
      if (apply.exitCode !== 0) throw new Error(apply.stderr.trim() || 'git apply failed');
    }
    await copyUntrackedFiles({ sourceRoot: cwd, targetRoot: worktree, state });
    return {
      cwd: worktree,
      isolation: 'git-worktree',
      cleanup: async () => {
        await gitCommand(['worktree', 'remove', '--force', worktree], { cwd, timeoutMs: 30000 }).catch(() => {});
        await rm(tempRoot, { recursive: true, force: true });
      }
    };
  } catch (error) {
    if (added) await gitCommand(['worktree', 'remove', '--force', worktree], { cwd, timeoutMs: 30000 }).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function persistJson(filePath, value) {
  await atomicWriteJson(filePath, value);
}

async function runChecks({ checks, cwd, evidenceDir, timeoutMs, onStep }) {
  const results = [];
  for (let index = 0; index < checks.length; index += 1) {
    const check = checks[index];
    const result = await runCommand(buildShellCommand(check.command), { cwd, timeoutMs });
    const prefix = `${String(index + 1).padStart(2, '0')}-${check.visibility}`;
    const stdoutPath = path.join(evidenceDir, `${prefix}.stdout.log`);
    const stderrPath = path.join(evidenceDir, `${prefix}.stderr.log`);
    await atomicWriteText(stdoutPath, result.stdout);
    await atomicWriteText(stderrPath, result.stderr);
    const record = {
      command: check.command,
      visibility: check.visibility,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdoutSha256: sha256(result.stdout),
      stderrSha256: sha256(result.stderr),
      stdoutPath,
      stderrPath
    };
    results.push(record);
    onStep?.(index + 1, checks.length);
    if (result.exitCode !== 0 || result.timedOut) break;
  }
  return results;
}

export class VerificationError extends Error {
  constructor(message, attestation) {
    super(message);
    this.name = 'VerificationError';
    this.attestation = attestation;
  }
}

export async function verifyTaskClaim({
  task,
  receipt,
  cwd = process.cwd(),
  runDir,
  beforeState,
  afterState,
  timeoutMs = 15 * 60 * 1000,
  isolationMode = 'same-workspace',
  onStep
}) {
  if (!runDir) throw new TypeError('runDir is required');
  const verificationId = randomUUID();
  const evidenceDir = path.join(runDir, 'verifier', verificationId);
  await mkdir(evidenceDir, { recursive: true });

  let changeEvidence;
  try {
    changeEvidence = validateClaimedChanges({ task, receipt, beforeState, afterState });
  } catch (error) {
    const attestation = {
      schemaVersion: 1,
      verificationId,
      taskId: task.id,
      runId: task.runId ?? null,
      status: 'fail',
      issuedAt: new Date().toISOString(),
      isolation: 'not-started',
      taskHash: sha256(task),
      claimHash: sha256(receipt),
      changeEvidence: { status: 'mismatch', actualChangedFiles: changedPathsBetween(beforeState, afterState) ?? [] },
      checks: [],
      failure: error.message
    };
    attestation.evidenceDigest = sha256(attestation);
    const attestationPath = path.join(evidenceDir, 'attestation.json');
    await persistJson(attestationPath, attestation);
    await persistJson(path.join(runDir, 'verification-latest.json'), { verificationId, attestationPath });
    throw new VerificationError(`Independent verification failed: ${error.message}`, { ...attestation, path: attestationPath });
  }

  const workspaceState = afterState ?? await captureWorkspaceState(cwd);
  let workspace;
  try {
    workspace = await prepareVerificationWorkspace({ cwd, state: workspaceState, isolationMode });
  } catch (error) {
    const attestation = {
      schemaVersion: 1,
      verificationId,
      taskId: task.id,
      runId: task.runId ?? null,
      status: 'fail',
      issuedAt: new Date().toISOString(),
      isolation: isolationMode,
      taskHash: sha256(task),
      claimHash: sha256(receipt),
      changeEvidence,
      checks: [],
      failure: error.message
    };
    attestation.evidenceDigest = sha256(attestation);
    const attestationPath = path.join(evidenceDir, 'attestation.json');
    await persistJson(attestationPath, attestation);
    await persistJson(path.join(runDir, 'verification-latest.json'), { verificationId, attestationPath });
    throw new VerificationError(`Independent verification failed: ${error.message}`, { ...attestation, path: attestationPath });
  }

  try {
    const checks = [
      ...(task.verificationCommands ?? []).map((command) => ({ command, visibility: 'worker-visible' })),
      ...(task.verifierCommands ?? []).map((command) => ({ command, visibility: 'hidden' }))
    ];
    const results = await runChecks({ checks, cwd: workspace.cwd, evidenceDir, timeoutMs, onStep });
    const failed = results.find((entry) => entry.exitCode !== 0 || entry.timedOut);
    // With zero replayed checks and no verified change evidence there is
    // nothing independent behind this attestation; 'pass' would launder an
    // unverified claim into apparent evidence.
    const inconclusive = !failed && results.length === 0 && changeEvidence.status !== 'verified';
    const attestation = {
      schemaVersion: 1,
      verificationId,
      taskId: task.id,
      runId: task.runId ?? null,
      status: failed ? 'fail' : inconclusive ? 'inconclusive' : 'pass',
      issuedAt: new Date().toISOString(),
      isolation: workspace.isolation,
      taskHash: sha256(task),
      claimHash: sha256(receipt),
      changeEvidence,
      checks: results,
      ...(failed ? { failure: `Verifier check failed: ${failed.command}` } : {})
    };
    attestation.evidenceDigest = sha256(attestation);
    const attestationPath = path.join(evidenceDir, 'attestation.json');
    await persistJson(attestationPath, attestation);
    await persistJson(path.join(runDir, 'verification-latest.json'), { verificationId, attestationPath });
    if (failed) {
      throw new VerificationError(`Independent verification failed: verifier check failed: ${failed.command}`, {
        ...attestation,
        path: attestationPath
      });
    }
    return { ...attestation, path: attestationPath };
  } finally {
    await workspace.cleanup();
  }
}
