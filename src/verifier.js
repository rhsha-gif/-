import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from './executor.js';
import { atomicWriteJson, atomicWriteText } from './file-store.js';
import { redactSecrets, redactValue } from './security.js';
import { sanitizeSubscriptionWorkerEnv } from './subscription.js';

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

function sortedFileList(entries) {
  return Object.keys(entries).sort().map((filePath) => ({ path: filePath, fingerprint: entries[filePath].fingerprint }));
}

export async function captureWorkspaceState(cwd, { ignorePaths = [], evidenceFiles = [], snapshotDir } = {}) {
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
    const normalizedEvidenceFiles = [...new Set(evidenceFiles.map(normalizePath).filter(Boolean))];
    for (const filePath of normalizedEvidenceFiles) {
      if (ignored(filePath, normalizedIgnore)) continue;
      entries[filePath] = {
        status: 'evidence',
        fingerprint: await fileFingerprint(path.join(cwd, filePath))
      };
    }

    // Capture the patch bytes once, at capture time. Verification later
    // materializes from these bytes; it never re-reads the live diff, so a
    // workspace mutation between capture and verification cannot change what
    // gets verified (git binary patches are ASCII-safe base85).
    let patch = null;
    let patchSha256 = null;
    if (head) {
      const patchResult = await gitCommand(['diff', '--binary', 'HEAD'], { cwd, timeoutMs: 30000 });
      if (patchResult.exitCode !== 0) {
        return { available: false, kind: 'git', reason: patchResult.stderr.trim() || 'git diff failed', entries: {} };
      }
      patch = patchResult.stdout;
      patchSha256 = sha256(patch);
    }

    // Immutable copies of content the patch cannot reproduce (untracked and
    // explicit evidence files). Without a snapshotDir the copies are skipped
    // and verification falls back to live copies re-checked by fingerprint.
    let snapshotRoot = null;
    if (snapshotDir) {
      snapshotRoot = path.resolve(snapshotDir);
      await mkdir(snapshotRoot, { recursive: true });
      for (const [filePath, entry] of Object.entries(entries)) {
        if (entry.status !== '??' && entry.status !== 'evidence') continue;
        if (entry.fingerprint === 'missing') continue;
        const source = path.join(cwd, filePath);
        const target = path.join(snapshotRoot, filePath);
        await mkdir(path.dirname(target), { recursive: true });
        await cp(source, target, { recursive: true, force: true });
      }
    }

    const state = {
      available: true,
      kind: 'git',
      head,
      entries,
      evidenceFiles: normalizedEvidenceFiles,
      capturedAt: new Date().toISOString(),
      patch,
      patchSha256,
      snapshotRoot
    };
    state.snapshotDigest = sha256({ head, patchSha256, files: sortedFileList(entries) });
    return state;
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

function buildShellCommand(command, baseEnv) {
  const env = { ...baseEnv, AORCH_WORKER: '1', AORCH_VERIFIER: '1' };
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', command],
      stdin: null,
      env,
      envMode: 'replace'
    };
  }
  // Non-login shell: a login shell could source user profiles that print into
  // the captured stdout/stderr evidence and change PATH between worker and
  // verifier runs. The environment is a sanitized replacement set, never the
  // orchestrator's full environment.
  return {
    command: '/bin/sh',
    args: ['-c', command],
    stdin: null,
    env,
    envMode: 'replace'
  };
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = escaped.replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('\u0000', '.*');
  return new RegExp(`^${regex}$`);
}

export function pathsIntersectProtectedScope(paths, protectedScope = []) {
  if (protectedScope.length === 0) return [];
  const matchers = protectedScope.map((pattern) => {
    const normalized = normalizePath(pattern);
    if (/[*?[]/.test(normalized)) {
      const regex = globToRegExp(normalized);
      return (candidate) => regex.test(candidate);
    }
    return (candidate) => candidate === normalized || candidate.startsWith(`${normalized}/`);
  });
  return paths.filter((candidate) => matchers.some((matches) => matches(normalizePath(candidate))));
}

async function copyUntrackedFiles({ sourceRoot, targetRoot, state }) {
  for (const [filePath, entry] of Object.entries(state?.entries ?? {})) {
    if (entry.status !== '??') continue;
    if (entry.fingerprint === 'missing') continue;
    const source = path.join(sourceRoot, filePath);
    const target = path.join(targetRoot, filePath);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true });
  }
}

async function copyEvidenceFiles({ sourceRoot, targetRoot, state }) {
  for (const filePath of state?.evidenceFiles ?? []) {
    const source = path.join(sourceRoot, filePath);
    const target = path.join(targetRoot, filePath);
    try {
      const info = await lstat(source);
      if (info.isSymbolicLink()) throw new Error(`Evidence file must not be a symlink: ${filePath}`);
      if (!info.isFile()) throw new Error(`Evidence path must be a regular file: ${filePath}`);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, { force: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        await rm(target, { force: true });
        continue;
      }
      throw error;
    }
  }
}

// Copied content must still match the fingerprints taken at capture time;
// otherwise the snapshot copy (or the live fallback source) was modified
// between capture and verification and the materialized tree is not the tree
// the worker produced.
async function assertMaterializedFingerprints({ targetRoot, state }) {
  for (const [filePath, entry] of Object.entries(state?.entries ?? {})) {
    if (entry.status.endsWith(':source')) continue;
    const actual = await fileFingerprint(path.join(targetRoot, filePath));
    if (actual !== entry.fingerprint) {
      throw new Error(`Materialized content fingerprint mismatch for ${filePath}: workspace changed between capture and verification`);
    }
  }
}

async function prepareVerificationWorkspace({ cwd, state, isolationMode }) {
  if (isolationMode !== 'git-worktree') {
    return { cwd, isolation: 'same-workspace', cleanup: async () => {} };
  }
  if (!state?.available || state.kind !== 'git' || !state.head) {
    throw new Error('git-worktree verification requires a Git repository with a committed HEAD');
  }
  if (typeof state.patch !== 'string') {
    throw new Error('git-worktree verification requires captured patch bytes; re-capture the workspace state');
  }
  if (state.patchSha256 !== sha256(state.patch)) {
    throw new Error('captured patch bytes do not match their recorded hash');
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aorch-verifier-'));
  const worktree = path.join(tempRoot, 'worktree');
  let added = false;
  try {
    const add = await gitCommand(['worktree', 'add', '--detach', worktree, state.head], { cwd, timeoutMs: 30000 });
    if (add.exitCode !== 0) throw new Error(add.stderr.trim() || 'git worktree add failed');
    added = true;

    if (state.patch.length > 0) {
      const apply = await gitCommand(['apply', '--binary', '--whitespace=nowarn', '-'], {
        cwd: worktree,
        stdin: state.patch,
        timeoutMs: 30000
      });
      if (apply.exitCode !== 0) throw new Error(apply.stderr.trim() || 'git apply failed');
    }
    const copySource = state.snapshotRoot ?? cwd;
    await copyUntrackedFiles({ sourceRoot: copySource, targetRoot: worktree, state });
    await copyEvidenceFiles({ sourceRoot: copySource, targetRoot: worktree, state });
    await assertMaterializedFingerprints({ targetRoot: worktree, state });
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

async function runChecks({ checks, cwd, evidenceDir, timeoutMs, totalTimeoutMs, maxOutputBytes, baseEnv = {}, onStep }) {
  const deadline = Date.now() + totalTimeoutMs;
  const results = [];
  for (let index = 0; index < checks.length; index += 1) {
    const check = checks[index];
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      results.push({ command: check.command, visibility: check.visibility, exitCode: null, timedOut: true, outputLimitExceeded: false, terminationReason: 'verification-deadline', durationMs: 0, stdoutSha256: sha256(''), stderrSha256: sha256(''), stdoutPath: null, stderrPath: null });
      break;
    }
    const result = await runCommand(buildShellCommand(check.command, baseEnv), { cwd, timeoutMs: Math.min(timeoutMs, remainingMs), maxOutputBytes });
    const prefix = `${String(index + 1).padStart(2, '0')}-${check.visibility}`;
    const stdoutPath = path.join(evidenceDir, `${prefix}.stdout.log`);
    const stderrPath = path.join(evidenceDir, `${prefix}.stderr.log`);
    await atomicWriteText(stdoutPath, redactSecrets(result.stdout));
    await atomicWriteText(stderrPath, redactSecrets(result.stderr));
    const record = {
      command: check.command,
      visibility: check.visibility,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      outputLimitExceeded: result.outputLimitExceeded,
      terminationReason: result.terminationReason,
      durationMs: result.durationMs,
      stdoutSha256: sha256(result.stdout),
      stderrSha256: sha256(result.stderr),
      stdoutPath,
      stderrPath
    };
    results.push(record);
    onStep?.(index + 1, checks.length);
    if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded) break;
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

function attestationBase({ verificationId, task, receipt, state }) {
  return {
    schemaVersion: 2,
    verificationId,
    taskId: task.id,
    runId: task.runId ?? null,
    issuedAt: new Date().toISOString(),
    taskHash: sha256(task),
    claimHash: sha256(receipt),
    baseHead: state?.head ?? null,
    patchSha256: state?.patchSha256 ?? null,
    snapshotDigest: state?.snapshotDigest ?? null,
    files: state?.entries
      ? Object.keys(state.entries).sort().map((filePath) => ({ path: filePath, fingerprint: state.entries[filePath].fingerprint }))
      : []
  };
}

// Redact before digesting so the evidenceDigest matches the bytes actually
// persisted; a digest over pre-redaction content could never be re-verified.
async function sealAttestation({ evidenceDir, runDir, verificationId, attestation }) {
  const sealed = redactValue(attestation);
  sealed.evidenceDigest = sha256(sealed);
  const attestationPath = path.join(evidenceDir, 'attestation.json');
  await atomicWriteJson(attestationPath, sealed);
  await atomicWriteJson(path.join(runDir, 'verification-latest.json'), { verificationId, attestationPath });
  return { ...sealed, path: attestationPath };
}

export async function verifyTaskClaim({
  task,
  receipt,
  cwd = process.cwd(),
  runDir,
  beforeState,
  afterState,
  timeoutMs = 15 * 60 * 1000,
  totalTimeoutMs = 30 * 60 * 1000,
  maxOutputBytes = 8 * 1024 * 1024,
  maxChecks = 20,
  isolationMode = 'same-workspace',
  envAllowlist = [],
  onStep
}) {
  if (!runDir) throw new TypeError('runDir is required');
  const verificationId = randomUUID();
  const evidenceDir = path.join(runDir, 'verifier', verificationId);
  await mkdir(evidenceDir, { recursive: true });
  // Checks execute with a sanitized replacement environment: process basics
  // plus explicitly allowlisted names. API credentials and unrelated secrets
  // never reach verification commands, even when allowlisted by mistake.
  const checkEnv = sanitizeSubscriptionWorkerEnv({ env: process.env, provider: 'anthropic', extraAllow: envAllowlist });
  const declaredChecks = (task.verificationCommands?.length ?? 0) + (task.verifierCommands?.length ?? 0);
  if (!Number.isInteger(maxChecks) || maxChecks < 1 || declaredChecks > maxChecks) {
    const failure = `Too many verifier checks: ${declaredChecks}; maximum is ${maxChecks}`;
    const sealed = await sealAttestation({
      evidenceDir, runDir, verificationId,
      attestation: {
        ...attestationBase({ verificationId, task, receipt, state: afterState }),
        status: 'fail', isolation: 'not-started',
        changeEvidence: { status: 'not-checked', actualChangedFiles: [] }, checks: [],
        failure
      }
    });
    throw new VerificationError(`Independent verification failed: ${failure}`, sealed);
  }

  if (task.write === true && declaredChecks === 0 && task.allowChangeEvidenceOnly !== true) {
    const failure = 'Write task has no executable check; low-risk evidence-only work must set allowChangeEvidenceOnly';
    const sealed = await sealAttestation({
      evidenceDir, runDir, verificationId,
      attestation: {
        ...attestationBase({ verificationId, task, receipt, state: afterState }),
        status: 'fail', isolation: 'not-started',
        changeEvidence: { status: 'not-checked', actualChangedFiles: [] }, checks: [],
        failure
      }
    });
    throw new VerificationError(`Independent verification failed: ${failure}`, sealed);
  }

  let changeEvidence;
  try {
    changeEvidence = validateClaimedChanges({ task, receipt, beforeState, afterState });
  } catch (error) {
    const sealed = await sealAttestation({
      evidenceDir, runDir, verificationId,
      attestation: {
        ...attestationBase({ verificationId, task, receipt, state: afterState }),
        status: 'fail', isolation: 'not-started',
        changeEvidence: { status: 'mismatch', actualChangedFiles: changedPathsBetween(beforeState, afterState) ?? [] },
        checks: [],
        failure: error.message
      }
    });
    throw new VerificationError(`Independent verification failed: ${error.message}`, sealed);
  }

  // Anti-gaming boundary: a worker change that touches the files protecting
  // verification (hidden tests, lockfiles, verifier scripts) fails before any
  // check executes, because the checks themselves can no longer be trusted.
  const protectedHits = pathsIntersectProtectedScope(
    changeEvidence.actualChangedFiles ?? [],
    task.verifierProtectedScope ?? []
  );
  if (protectedHits.length > 0) {
    const failure = `Worker changed verifier-protected scope before checks ran: ${protectedHits.join(', ')}`;
    const sealed = await sealAttestation({
      evidenceDir, runDir, verificationId,
      attestation: {
        ...attestationBase({ verificationId, task, receipt, state: afterState }),
        status: 'fail', isolation: 'not-started',
        changeEvidence,
        checks: [],
        failure
      }
    });
    throw new VerificationError(`Independent verification failed: ${failure}`, sealed);
  }

  const workspaceState = afterState ?? await captureWorkspaceState(cwd, {
    evidenceFiles: task.evidenceFiles ?? [],
    snapshotDir: path.join(evidenceDir, 'snapshot')
  });
  let workspace;
  try {
    workspace = await prepareVerificationWorkspace({ cwd, state: workspaceState, isolationMode });
  } catch (error) {
    const sealed = await sealAttestation({
      evidenceDir, runDir, verificationId,
      attestation: {
        ...attestationBase({ verificationId, task, receipt, state: workspaceState }),
        status: 'fail', isolation: isolationMode,
        changeEvidence,
        checks: [],
        failure: error.message
      }
    });
    throw new VerificationError(`Independent verification failed: ${error.message}`, sealed);
  }

  try {
    const checks = [
      ...(task.verifierPrepareCommands ?? []).map((command) => ({ command, visibility: 'prepare' })),
      ...(task.verificationCommands ?? []).map((command) => ({ command, visibility: 'worker-visible' })),
      ...(task.verifierCommands ?? []).map((command) => ({ command, visibility: 'hidden' }))
    ];
    const results = await runChecks({ checks, cwd: workspace.cwd, evidenceDir, timeoutMs, totalTimeoutMs, maxOutputBytes, baseEnv: checkEnv, onStep });
    const failed = results.find((entry) => entry.exitCode !== 0 || entry.timedOut || entry.outputLimitExceeded);
    if (failed && failed.visibility === 'prepare') {
      const sealed = await sealAttestation({
        evidenceDir, runDir, verificationId,
        attestation: {
          ...attestationBase({ verificationId, task, receipt, state: workspaceState }),
          status: 'fail',
          isolation: workspace.isolation,
          changeEvidence,
          checks: results,
          failure: `Verifier prepare failed: ${failed.command}`
        }
      });
      throw new VerificationError(`Independent verification failed: verifier prepare failed: ${failed.command}`, sealed);
    }
    // With zero replayed checks and no verified change evidence there is
    // nothing independent behind this attestation; 'pass' would launder an
    // unverified claim into apparent evidence. Prepare commands set up the
    // workspace but are not verification evidence themselves.
    const replayedChecks = results.filter((entry) => entry.visibility !== 'prepare');
    const inconclusive = !failed && replayedChecks.length === 0 && changeEvidence.status !== 'verified';
    const sealed = await sealAttestation({
      evidenceDir, runDir, verificationId,
      attestation: {
        ...attestationBase({ verificationId, task, receipt, state: workspaceState }),
        status: failed ? 'fail' : inconclusive ? 'inconclusive' : 'pass',
        isolation: workspace.isolation,
        changeEvidence,
        checks: results,
        ...(failed ? { failure: `Verifier check failed: ${failed.command}` } : {})
      }
    });
    if (failed) {
      throw new VerificationError(`Independent verification failed: verifier check failed: ${failed.command}`, sealed);
    }
    return sealed;
  } finally {
    await workspace.cleanup();
  }
}
