import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'src/cli.js');
const defaultConfig = path.join(root, 'config/aorch.config.json');
const npmCli = process.env.npm_execpath ?? path.join(
  path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'
);
const CLI_TIMEOUT_MS = 30_000;

function spawnCommand(command, args) {
  if (process.platform !== 'win32' || path.extname(command).toLowerCase() !== '.cmd') {
    return { command, args, shell: false };
  }

  const commandLine = [command, ...args]
    .map((argument) => '"' + argument.replaceAll('"', '""') + '"')
    .join(' ');
  return { command: commandLine, args: [], shell: true };
}

function runCli(command, args, {
  cwd = root,
  timeoutMs = CLI_TIMEOUT_MS,
  terminate = (child) => {
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true
      });
      killer.once('error', () => child.kill('SIGKILL'));
    } else {
      child.kill('SIGKILL');
    }
  }
} = {}) {
  return new Promise((resolve) => {
    const invocation = spawnCommand(command, args);
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      shell: invocation.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let error;
    let settled = false;
    let timeout;

    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ command, args, pid: child.pid, status, signal, stdout, stderr, timedOut, error });
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (spawnError) => {
      error = spawnError;
      finish(null, null);
    });
    child.once('close', finish);
    timeout = setTimeout(() => {
      timedOut = true;
      terminate(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      finish(null, null);
    }, timeoutMs);
  });
}

function diagnostics(result) {
  return [
    'command: ' + result.command,
    'pid: ' + result.pid,
    'status: ' + result.status,
    'signal: ' + result.signal,
    'timed out: ' + result.timedOut,
    'error: ' + (result.error?.message ?? 'none'),
    'stdout:\n' + result.stdout,
    'stderr:\n' + result.stderr
  ].join('\n');
}

function assertCliSucceeded(result) {
  assert.equal(result.timedOut, false, diagnostics(result));
  assert.equal(result.error, undefined, diagnostics(result));
  assert.equal(result.signal, null, diagnostics(result));
  assert.equal(result.status, 0, diagnostics(result));
}

async function makeTempDir(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('route command returns a concrete provider, model, and effort', async (t) => {
  const dir = await makeTempDir(t, 'aorch-cli-');
  const taskPath = path.join(dir, 'task.json');
  await writeFile(taskPath, JSON.stringify({
    id: 'T1', kind: 'implementation', role: 'executor', risk: 'standard', tags: []
  }));
  const result = await runCli(process.execPath, [cli, 'route', '--config', defaultConfig, '--task', taskPath]);
  assertCliSucceeded(result);
  const route = JSON.parse(result.stdout);
  assert.ok(route.provider);
  assert.ok(route.model);
  assert.ok(route.effort);
});

test('help exposes the intentionally small command surface', async () => {
  const result = await runCli(process.execPath, [cli, '--help']);
  assertCliSucceeded(result);
  assert.match(result.stdout, /route/);
  assert.match(result.stdout, /exec/);
  assert.match(result.stdout, /record/);
  assert.match(result.stdout, /install/);
  assert.match(result.stdout, /run/);
  assert.match(result.stdout, /lessons/);
});

test('CLI timeout diagnostics settle even when process-tree termination does not', async (t) => {
  let pid;
  t.after(() => {
    if (!pid) return;
    try {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.unref();
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {}
  });
  const started = Date.now();
  const result = await runCli(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 100,
    terminate: (child) => { pid = child.pid; }
  });

  assert.equal(result.timedOut, true, diagnostics(result));
  assert.ok(Date.now() - started < 2_000, diagnostics(result));
  assert.match(diagnostics(result), /pid: \d+/);
});

test('npm-style bin entrypoints execute the CLI entrypoint', async (t) => {
  if (process.platform === 'win32') {
    const dir = await makeTempDir(t, 'aorch-bin-project-');
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ private: true }));
    const packed = await runCli(process.execPath, [npmCli,
      'pack', root,
      '--json',
      '--pack-destination', dir
    ], { cwd: dir });
    assertCliSucceeded(packed);
    const tarball = path.join(dir, JSON.parse(packed.stdout)[0].filename);
    const install = await runCli(process.execPath, [npmCli,
      'install',
      '--ignore-scripts',
      '--no-package-lock',
      '--no-save',
      tarball
    ], { cwd: dir });
    assertCliSucceeded(install);

    const binPath = path.join(dir, 'node_modules', '.bin', 'aorch.cmd');
    const result = await runCli(binPath, ['--help'], { cwd: dir });
    assertCliSucceeded(result);
    assert.match(result.stdout, /Adaptive Orchestrator/);
    return;
  }

  const dir = await makeTempDir(t, 'aorch-bin-');
  const binPath = path.join(dir, 'aorch');
  await symlink(cli, binPath);
  const result = await runCli(binPath, ['--help']);
  assertCliSucceeded(result);
  assert.match(result.stdout, /Adaptive Orchestrator/);
});

test('progress command accepts a task graph directly', async (t) => {
  const dir = await makeTempDir(t, 'aorch-progress-');
  const tasksPath = path.join(dir, 'tasks.json');
  await writeFile(tasksPath, JSON.stringify([
    { id: 'A', weight: 1, status: 'complete' },
    { id: 'B', weight: 1, status: 'running', fraction: 0.5 }
  ]));
  const result = await runCli(process.execPath, [cli, 'progress', '--config', defaultConfig, '--tasks', tasksPath]);
  assertCliSucceeded(result);
  assert.equal(JSON.parse(result.stdout).percent, 75);
});

test('run command supports start, finish, reflection, feedback, and consent recording', async (t) => {
  const dir = await makeTempDir(t, 'aorch-run-cli-');
  const manifestPath = path.join(dir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify({ prompt: 'build it', runId: 'RCLI', tasks: [] }));

  const start = await runCli(process.execPath, [cli, 'run', '--action', 'start', '--config', defaultConfig, '--cwd', dir, '--input', manifestPath]);
  assertCliSucceeded(start);
  assert.equal(JSON.parse(start.stdout).run.id, 'RCLI');

  const finish = await runCli(process.execPath, [cli, 'run', '--action', 'finish', '--config', defaultConfig, '--cwd', dir, '--run', 'active', '--status', 'completed']);
  assertCliSucceeded(finish);
  assert.equal(JSON.parse(finish.stdout).run.reviewStatus, 'pending');

  const reflectionPath = path.join(dir, 'reflection.json');
  await writeFile(reflectionPath, JSON.stringify({
    outcome: 'completed', summary: 'Done and verified.',
    whatWorked: [], errors: [], inefficiencies: [], technicalDebt: [],
    proposals: [{
      id: 'P1', category: 'efficiency', title: 'Reduce duplicate context',
      rationale: 'The same context appeared twice.', expectedBenefit: 'Less irrelevant context.',
      risks: [], affectedFiles: ['integrations/shared/user-prompt-submit.mjs']
    }]
  }));
  const reflect = await runCli(process.execPath, [cli, 'run', '--action', 'reflect', '--config', defaultConfig, '--cwd', dir, '--run', 'active', '--input', reflectionPath]);
  assertCliSucceeded(reflect);
  assert.equal(JSON.parse(reflect.stdout).retrospective.proposals[0].status, 'pending');

  const feedbackPath = path.join(dir, 'feedback.json');
  await writeFile(feedbackPath, JSON.stringify({ rating: 5, comment: 'The task result is correct.' }));
  const feedback = await runCli(process.execPath, [cli, 'run', '--action', 'feedback', '--config', defaultConfig, '--cwd', dir, '--run', 'RCLI', '--input', feedbackPath]);
  assertCliSucceeded(feedback);
  assert.equal(JSON.parse(feedback.stdout).retrospective.userFeedback.length, 1);

  const decide = await runCli(process.execPath, [cli, 'run', '--action', 'decide', '--config', defaultConfig, '--cwd', dir, '--run', 'RCLI', '--proposal', 'P1', '--decision', 'approved']);
  assertCliSucceeded(decide);
  const proposal = JSON.parse(decide.stdout).retrospective.proposals[0];
  assert.equal(proposal.status, 'approved');
  assert.equal(proposal.applied, false);
});

test('lessons command returns relevant operational prevention rules', async (t) => {
  const dir = await makeTempDir(t, 'aorch-lessons-cli-');
  const learningDir = path.join(dir, '.aorch/learning');
  await mkdir(learningDir, { recursive: true });
  const now = new Date();
  await writeFile(path.join(learningDir, 'lessons.json'), JSON.stringify({
    version: 2,
    lessons: [{
      id: 'L1', type: 'negative', status: 'advisory', description: 'Wrong test path',
      prevention: 'Resolve paths from project root.', scopeTags: ['test', 'path'],
      evidence: ['R1/stderr.log'], confidence: 0.8, occurrences: 1, sourceRunIds: ['R1'],
      counterexamples: [], promotedToPolicy: false, createdAt: now.toISOString(), lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 86400000).toISOString()
    }]
  }));
  const result = await runCli(process.execPath, [cli, 'lessons', '--config', defaultConfig, '--cwd', dir, '--query', 'test path']);
  assertCliSucceeded(result);
  const lessons = JSON.parse(result.stdout);
  assert.equal(lessons.length, 1);
  assert.match(lessons[0].prevention, /project root/i);
  assert.equal(lessons[0].advisory, true);

  const lint = await runCli(process.execPath, [cli, 'lessons', '--config', defaultConfig, '--cwd', dir, '--lint']);
  assertCliSucceeded(lint);
  assert.equal(JSON.parse(lint.stdout).status, 'pass');
});

test('verify command creates an independent attestation from a task and worker claim', async (t) => {
  const dir = await makeTempDir(t, 'aorch-verify-cli-');
  const taskPath = path.join(dir, 'task.json');
  const receiptPath = path.join(dir, 'receipt.json');
  await writeFile(taskPath, JSON.stringify({
    id: 'TCLI-verify', objective: 'Verify claim', kind: 'testing', role: 'executor', risk: 'low',
    write: false, acceptanceCriteria: ['verified'], verificationCommands: ['node --version'], verifierCommands: []
  }));
  await writeFile(receiptPath, JSON.stringify({
    status: 'complete', summary: 'claim', filesInspected: [], filesChanged: [],
    commands: [{ command: 'node --version', exitCode: 0, outcome: process.version }],
    criteria: [{ criterion: 'verified', status: 'pass', evidence: 'claim' }],
    unresolvedRisks: [], confidence: 0.8
  }));
  const result = await runCli(process.execPath, [cli, 'verify', '--config', defaultConfig, '--cwd', dir, '--task', taskPath, '--receipt', receiptPath]);
  assertCliSucceeded(result);
  const output = JSON.parse(result.stdout);
  assert.equal(output.attestation.status, 'pass');
  assert.ok(output.attestationPath.endsWith('attestation.json'));
});

test('unknown options and boolean flags with junk values fail instead of being silently ignored', async (t) => {
  const dir = await makeTempDir(t, 'aorch-cli-flags-');
  const taskPath = path.join(dir, 'task.json');
  await writeFile(taskPath, JSON.stringify({
    id: 'T1', kind: 'implementation', role: 'executor', risk: 'standard'
  }));

  const typo = await runCli(process.execPath, [cli, 'route', '--config', defaultConfig, '--taks', taskPath]);
  assert.equal(typo.status, 1, diagnostics(typo));
  assert.match(typo.stderr, /unknown option.*--taks/i);

  const junkBool = await runCli(process.execPath, [cli, 'lessons', '--config', defaultConfig, '--cwd', dir, '--lint=yes']);
  assert.equal(junkBool.status, 1, diagnostics(junkBool));
  assert.match(junkBool.stderr, /boolean flag/i);

  const boolWithValue = await runCli(process.execPath, [cli, 'lessons', '--config', defaultConfig, '--cwd', dir, '--lint', 'true']);
  assertCliSucceeded(boolWithValue);
  assert.equal(JSON.parse(boolWithValue.stdout).status, 'pass');

  const badTimeout = await runCli(process.execPath, [cli, 'exec', '--config', defaultConfig, '--task', taskPath, '--timeout-ms', '30s']);
  assert.equal(badTimeout.status, 1, diagnostics(badTimeout));
  assert.match(badTimeout.stderr, /--timeout-ms must be/i);
});
