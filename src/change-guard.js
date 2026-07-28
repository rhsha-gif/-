import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from './executor.js';

export async function runGit(args, cwd) {
  return runCommand(
    { command: 'git', args, env: { AORCH_WORKER: '1' } },
    { cwd, timeoutMs: 10_000 }
  );
}

function repoPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const slashed = value.replaceAll('\\', '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:\//u.test(slashed)) return null;
  const normalized = path.posix.normalize(slashed).replace(/^\.\//u, '');
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function parseStatus(output) {
  const parts = output.split('\0');
  const statuses = new Map();
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const current = repoPath(entry.slice(3));
    if (current) statuses.set(current, status);
    if (/[RC]/u.test(status)) {
      const original = repoPath(parts[index + 1]);
      if (original) statuses.set(original, `${status}:source`);
      index += 1;
    }
  }
  return statuses;
}

function parseIndex(output) {
  const entries = new Map();
  for (const entry of output.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    if (tab === -1) continue;
    const file = repoPath(entry.slice(tab + 1));
    if (file) entries.set(file, entry.slice(0, tab));
  }
  return entries;
}

async function worktreeFingerprint(root, file) {
  const filePath = path.resolve(root, ...file.split('/'));
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink()) return `symlink:${await readlink(filePath)}`;
    if (!stats.isFile()) return `type:${stats.mode}`;
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(`file:${hash.digest('hex')}`));
  });
}

export async function captureGitSnapshot({ cwd = process.cwd() } = {}) {
  const probe = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  if (probe.exitCode !== 0 || probe.stdout.trim() !== 'true') {
    return {
      applicable: false,
      reason: 'not-git-repository',
      root: null,
      head: null,
      entries: {}
    };
  }

  const [rootResult, headResult, statusResult, indexResult] = await Promise.all([
    runGit(['rev-parse', '--show-toplevel'], cwd),
    runGit(['rev-parse', '--verify', 'HEAD'], cwd),
    runGit(['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd),
    runGit(['ls-files', '--stage', '-z'], cwd)
  ]);
  if (rootResult.exitCode !== 0 || statusResult.exitCode !== 0 || indexResult.exitCode !== 0) {
    throw new Error('Unable to capture Git state for change guard');
  }

  const root = path.resolve(rootResult.stdout.trim());
  const statuses = parseStatus(statusResult.stdout);
  const indexEntries = parseIndex(indexResult.stdout);
  const entries = {};
  await Promise.all([...statuses.entries()].map(async ([file, status]) => {
    entries[file] = {
      status,
      index: indexEntries.get(file) ?? null,
      worktree: await worktreeFingerprint(root, file)
    };
  }));
  return {
    applicable: true,
    reason: null,
    root,
    head: headResult.exitCode === 0 ? headResult.stdout.trim() : null,
    entries
  };
}

function globRegex(pattern) {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          expression += '(?:.*/)?';
        } else {
          expression += '.*';
        }
      } else {
        expression += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      expression += '[^/]';
      continue;
    }
    expression += /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${expression}$`, 'u');
}

function matchesScope(file, patterns) {
  return patterns.some((pattern) => {
    const normalized = repoPath(pattern);
    return normalized !== null && globRegex(normalized).test(file);
  });
}

function changedFiles(before, after) {
  const paths = new Set([
    ...Object.keys(before.entries ?? {}),
    ...Object.keys(after.entries ?? {})
  ]);
  return [...paths]
    .filter((file) => JSON.stringify(before.entries?.[file] ?? null) !== JSON.stringify(after.entries?.[file] ?? null))
    .sort();
}

function ignoredPrefixes(paths, root) {
  if (!root) return [];
  return paths
    .map((entry) => path.isAbsolute(entry) ? path.relative(root, entry) : entry)
    .map(repoPath)
    .filter(Boolean);
}

export function evaluateChangeGuard({ task, receipt, before, after, ignoredPaths = [] }) {
  const rawClaims = Array.isArray(receipt?.filesChanged) ? receipt.filesChanged : [];
  const invalidClaimedFiles = rawClaims.filter((file) => repoPath(file) === null).sort();
  const claimedFiles = [...new Set(rawClaims.map(repoPath).filter(Boolean))].sort();
  const sameRepository = before?.applicable === true
    && after?.applicable === true
    && before.root === after.root;
  const applicable = sameRepository;
  const reason = applicable
    ? null
    : (before?.reason === 'not-git-repository' && after?.reason === 'not-git-repository'
        ? 'not-git-repository'
        : 'repository-changed');
  const ignored = ignoredPrefixes(ignoredPaths, before?.root);
  const actualFiles = applicable
    ? changedFiles(before, after).filter((file) => !ignored.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)))
    : [];
  const actualSet = new Set(actualFiles);
  const claimedSet = new Set(claimedFiles);
  const unclaimedFiles = actualFiles.filter((file) => !claimedSet.has(file));
  const overclaimedFiles = claimedFiles.filter((file) => !actualSet.has(file));
  const write = task?.write === true;
  const allowedScope = Array.isArray(task?.allowedScope) ? task.allowedScope : [];
  const forbiddenScope = Array.isArray(task?.forbiddenScope) ? task.forbiddenScope : [];
  const outOfScopeFiles = write
    ? actualFiles.filter((file) => !matchesScope(file, allowedScope))
    : [];
  const forbiddenFiles = write
    ? actualFiles.filter((file) => matchesScope(file, forbiddenScope))
    : [];
  const readOnlyFiles = write ? [] : actualFiles;
  const headChanged = applicable && before.head !== after.head;
  const violations = [
    invalidClaimedFiles,
    unclaimedFiles,
    overclaimedFiles,
    outOfScopeFiles,
    forbiddenFiles,
    readOnlyFiles
  ];
  const passed = applicable
    ? !headChanged && violations.every((entries) => entries.length === 0)
    : reason === 'not-git-repository'
      && !write
      && claimedFiles.length === 0
      && invalidClaimedFiles.length === 0;

  return {
    applicable,
    passed,
    reason,
    headBefore: before?.head ?? null,
    headAfter: after?.head ?? null,
    headChanged,
    actualFiles,
    claimedFiles,
    invalidClaimedFiles,
    unclaimedFiles,
    overclaimedFiles,
    outOfScopeFiles,
    forbiddenFiles,
    readOnlyFiles
  };
}
