import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function evidenceDigest(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function isFullGitSha(value) {
  return typeof value === 'string' && (/^[a-f0-9]{40}$/.test(value) || /^[a-f0-9]{64}$/.test(value));
}

function validateRunId(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) {
    throw new Error('Release evidence run ID is unsafe');
  }
  return runId;
}

function defaultReleaseCommands() {
  return [{
    name: 'npm-run-check',
    argv: [
      process.execPath,
      process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      'run',
      'check'
    ]
  }];
}

function terminateProcessTree(child) {
  if (!child.pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        resolve();
      };
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true
      });
      const fallback = setTimeout(() => {
        child.kill('SIGKILL');
        finish();
      }, 5_000);
      killer.once('error', () => {
        child.kill('SIGKILL');
        finish();
      });
      killer.once('close', finish);
    });
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  return Promise.resolve();
}

function runArgv(argv, { cwd, timeoutMs = 120_000 }) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== 'string')) {
    throw new TypeError('Commands must be non-empty argv arrays of strings');
  }

  const [command, ...args] = argv;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== 'win32',
      shell: false,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let terminationGrace;
    let termination;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(terminationGrace);
      callback(value);
    };
    const finish = (exitCode, signal) => {
      const result = { exitCode, signal, stdout, stderr, timedOut };
      if (timedOut && termination) {
        void termination.then(() => settle(resolve, result));
        return;
      }
      settle(resolve, result);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      termination = terminateProcessTree(child);
      terminationGrace = setTimeout(() => settle(resolve, {
        exitCode: null, signal: 'SIGKILL', stdout, stderr, timedOut
      }), 5_000);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      settle(reject, error);
    });
    child.once('exit', (exitCode, signal) => {
      if (timedOut) finish(exitCode, signal);
    });
    child.once('close', (exitCode, signal) => {
      finish(exitCode, signal);
    });
  });
}

async function git(root, args) {
  const result = await runArgv(['git', ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

async function sourceIsFrozen(root, sourceSha) {
  const [currentSha, status] = await Promise.all([
    git(root, ['rev-parse', 'HEAD']),
    git(root, ['status', '--porcelain=v1', '--untracked-files=all'])
  ]);
  return currentSha === sourceSha && status === '';
}

async function resolveOutputDirectory(root, outputDirectory) {
  if (typeof outputDirectory !== 'string' || outputDirectory.length === 0) {
    throw new TypeError('Output directory must be a non-empty path');
  }
  const resolved = path.resolve(root, outputDirectory);
  const relative = path.relative(root, resolved);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Output directory must stay inside the source root');
  }

  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Output directory contains a symlink: ${current}`);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  return resolved;
}

export async function runReleaseHarness({
  root = process.cwd(), runId = randomUUID(), commands = defaultReleaseCommands(), timeoutMs, outputDirectory = '.release-harness'
}) {
  const resolvedRoot = await realpath(root);
  const sourceSha = await git(resolvedRoot, ['rev-parse', 'HEAD']);
  if (!(await sourceIsFrozen(resolvedRoot, sourceSha))) {
    throw new Error('Source must be clean before the source SHA is frozen');
  }
  const toolVersions = {
    node: process.version,
    git: await git(resolvedRoot, ['--version'])
  };
  const evidenceRoot = await resolveOutputDirectory(resolvedRoot, outputDirectory);
  const sourceEvidenceDirectory = path.join(evidenceRoot, sourceSha);
  await mkdir(sourceEvidenceDirectory, { recursive: true });
  if ((await lstat(sourceEvidenceDirectory)).isSymbolicLink()) {
    throw new Error(`Output directory contains a symlink: ${sourceEvidenceDirectory}`);
  }
  const evidenceDirectory = path.join(sourceEvidenceDirectory, validateRunId(runId));
  try {
    await mkdir(evidenceDirectory);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Release evidence run directory already exists: ${runId}`);
    throw error;
  }

  const results = [];
  let rejection = null;
  for (const entry of commands ?? []) {
    const result = await runArgv(entry.argv, { cwd: resolvedRoot, timeoutMs: entry.timeoutMs ?? timeoutMs });
    results.push({ name: entry.name, argv: entry.argv, sourceSha, toolVersions, ...result });
    if (!(await sourceIsFrozen(resolvedRoot, sourceSha))) {
      rejection = 'source-mutated-after-freeze';
      break;
    }
    if (result.exitCode !== 0 || result.timedOut) break;
  }

  const manifest = {
    schemaVersion: 1,
    runId,
    createdAt: new Date().toISOString(),
    status: rejection
      ? 'rejected'
      : (results.length === 0 ? 'inconclusive' : (results.every((entry) => entry.exitCode === 0 && !entry.timedOut) ? 'pass' : 'fail')),
    sourceSha,
    toolVersions,
    commands: results,
    ...(rejection ? { rejection } : {})
  };
  manifest.evidenceDigest = evidenceDigest(manifest);
  const manifestPath = path.join(evidenceDirectory, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ...manifest, manifestPath };
}

export async function verifyReleaseManifest(manifestPath, { sourceSha, runId } = {}) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid release manifest: ${error.message}`);
  }
  if (manifest?.schemaVersion !== 1) throw new Error('Release manifest schema version is not supported');
  if (!isFullGitSha(manifest.sourceSha)) throw new Error('Release manifest requires a full source SHA');
  if (sourceSha !== undefined && manifest.sourceSha !== sourceSha) {
    throw new Error('Release manifest source SHA does not match the frozen source SHA');
  }
  if (runId !== undefined && manifest.runId !== runId) throw new Error('Release manifest run ID does not match');
  if (!manifest.toolVersions || typeof manifest.toolVersions.node !== 'string' || typeof manifest.toolVersions.git !== 'string') {
    throw new Error('Release manifest requires Node and Git tool versions');
  }
  if (!Array.isArray(manifest.commands)) throw new Error('Release manifest requires command evidence');
  for (const command of manifest.commands) {
    if (!Array.isArray(command?.argv) || command.sourceSha !== manifest.sourceSha) {
      throw new Error('Release command evidence is not bound to the manifest source SHA');
    }
    if (JSON.stringify(stableValue(command.toolVersions)) !== JSON.stringify(stableValue(manifest.toolVersions))) {
      throw new Error('Release command evidence is not bound to the manifest tool versions');
    }
  }
  const { evidenceDigest: declaredDigest, ...unsigned } = manifest;
  if (typeof declaredDigest !== 'string' || declaredDigest !== evidenceDigest(unsigned)) {
    throw new Error('Release manifest evidence digest is invalid');
  }
  return manifest;
}

function parseCliArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--root') {
      options.root = argv[++index];
    } else if (value === '--timeout-ms') {
      options.timeoutMs = Number(argv[++index]);
    } else {
      throw new Error(`Unknown release-harness option: ${value}`);
    }
  }
  if (options.root !== undefined && (typeof options.root !== 'string' || options.root.length === 0)) {
    throw new Error('--root requires a directory path');
  }
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error('--timeout-ms requires a positive integer');
  }
  return options;
}

async function main(argv) {
  const result = await runReleaseHarness(parseCliArguments(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'pass' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
