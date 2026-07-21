import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

function runArgv(argv, { cwd }) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== 'string')) {
    throw new TypeError('Commands must be non-empty argv arrays of strings');
  }

  const [command, ...args] = argv;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
  });
}

async function git(root, args) {
  const result = await runArgv(['git', ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

export async function runReleaseHarness({ root = process.cwd(), runId = randomUUID(), commands }) {
  const resolvedRoot = await realpath(root);
  const sourceSha = await git(resolvedRoot, ['rev-parse', 'HEAD']);
  const toolVersions = {
    node: process.version,
    git: await git(resolvedRoot, ['--version'])
  };
  const evidenceDirectory = path.join(resolvedRoot, '.release-harness', sourceSha, runId);
  await mkdir(evidenceDirectory, { recursive: true });

  const results = [];
  for (const entry of commands ?? []) {
    const result = await runArgv(entry.argv, { cwd: resolvedRoot });
    results.push({ name: entry.name, argv: entry.argv, sourceSha, toolVersions, ...result });
  }

  const manifest = {
    schemaVersion: 1,
    runId,
    createdAt: new Date().toISOString(),
    status: results.every((entry) => entry.exitCode === 0) ? 'pass' : 'fail',
    sourceSha,
    toolVersions,
    commands: results
  };
  const manifestPath = path.join(evidenceDirectory, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ...manifest, manifestPath };
}
