import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'src/cli.js');
const defaultConfig = path.join(root, 'config/aorch.config.json');

test('route command returns a concrete provider, model, and effort', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aorch-cli-'));
  const taskPath = path.join(dir, 'task.json');
  await writeFile(taskPath, JSON.stringify({
    id: 'T1', kind: 'implementation', role: 'executor', risk: 'standard', tags: []
  }));
  const result = spawnSync(process.execPath, [cli, 'route', '--config', defaultConfig, '--task', taskPath], {
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const route = JSON.parse(result.stdout);
  assert.ok(route.provider);
  assert.ok(route.model);
  assert.ok(route.effort);
});

test('help exposes the intentionally small command surface', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /route/);
  assert.match(result.stdout, /exec/);
  assert.match(result.stdout, /record/);
  assert.match(result.stdout, /install/);
  assert.match(result.stdout, /run/);
  assert.match(result.stdout, /lessons/);
});



test('npm-style bin symlinks execute the CLI entrypoint', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aorch-bin-'));
  const binPath = path.join(dir, 'aorch');
  await symlink(cli, binPath);

  const result = spawnSync(binPath, ['--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Adaptive Orchestrator/);
});

test('progress command accepts a task graph directly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aorch-progress-'));
  const tasksPath = path.join(dir, 'tasks.json');
  await writeFile(tasksPath, JSON.stringify([
    { id: 'A', weight: 1, status: 'complete' },
    { id: 'B', weight: 1, status: 'running', fraction: 0.5 }
  ]));
  const result = spawnSync(process.execPath, [cli, 'progress', '--config', defaultConfig, '--tasks', tasksPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).percent, 75);
});

test('run command supports start, finish, reflection, feedback, and consent recording', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aorch-run-cli-'));
  const manifestPath = path.join(dir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify({ prompt: 'build it', runId: 'RCLI', tasks: [] }));

  const start = spawnSync(process.execPath, [cli, 'run', '--action', 'start', '--config', defaultConfig, '--cwd', dir, '--input', manifestPath], { encoding: 'utf8' });
  assert.equal(start.status, 0, start.stderr);
  assert.equal(JSON.parse(start.stdout).run.id, 'RCLI');

  const finish = spawnSync(process.execPath, [cli, 'run', '--action', 'finish', '--config', defaultConfig, '--cwd', dir, '--run', 'active', '--status', 'completed'], { encoding: 'utf8' });
  assert.equal(finish.status, 0, finish.stderr);
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
  const reflect = spawnSync(process.execPath, [cli, 'run', '--action', 'reflect', '--config', defaultConfig, '--cwd', dir, '--run', 'active', '--input', reflectionPath], { encoding: 'utf8' });
  assert.equal(reflect.status, 0, reflect.stderr);
  assert.equal(JSON.parse(reflect.stdout).retrospective.proposals[0].status, 'pending');

  const feedbackPath = path.join(dir, 'feedback.json');
  await writeFile(feedbackPath, JSON.stringify({ rating: 5, comment: 'The task result is correct.' }));
  const feedback = spawnSync(process.execPath, [cli, 'run', '--action', 'feedback', '--config', defaultConfig, '--cwd', dir, '--run', 'RCLI', '--input', feedbackPath], { encoding: 'utf8' });
  assert.equal(feedback.status, 0, feedback.stderr);
  assert.equal(JSON.parse(feedback.stdout).retrospective.userFeedback.length, 1);

  const decide = spawnSync(process.execPath, [cli, 'run', '--action', 'decide', '--config', defaultConfig, '--cwd', dir, '--run', 'RCLI', '--proposal', 'P1', '--decision', 'approved'], { encoding: 'utf8' });
  assert.equal(decide.status, 0, decide.stderr);
  const proposal = JSON.parse(decide.stdout).retrospective.proposals[0];
  assert.equal(proposal.status, 'approved');
  assert.equal(proposal.applied, false);
});

test('lessons command returns relevant operational prevention rules', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aorch-lessons-cli-'));
  const learningDir = path.join(dir, '.aorch/learning');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(learningDir, { recursive: true }));
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
  const result = spawnSync(process.execPath, [cli, 'lessons', '--config', defaultConfig, '--cwd', dir, '--query', 'test path'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const lessons = JSON.parse(result.stdout);
  assert.equal(lessons.length, 1);
  assert.match(lessons[0].prevention, /project root/i);
  assert.equal(lessons[0].advisory, true);

  const lint = spawnSync(process.execPath, [cli, 'lessons', '--config', defaultConfig, '--cwd', dir, '--lint'], { encoding: 'utf8' });
  assert.equal(lint.status, 0, lint.stderr);
  assert.equal(JSON.parse(lint.stdout).status, 'pass');
});

test('verify command creates an independent attestation from a task and worker claim', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aorch-verify-cli-'));
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
  const result = spawnSync(process.execPath, [cli, 'verify', '--config', defaultConfig, '--cwd', dir, '--task', taskPath, '--receipt', receiptPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.attestation.status, 'pass');
  assert.ok(output.attestationPath.endsWith('attestation.json'));
});

test('unknown options and boolean flags with junk values fail instead of being silently ignored', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aorch-cli-flags-'));
  const taskPath = path.join(dir, 'task.json');
  await writeFile(taskPath, JSON.stringify({
    id: 'T1', kind: 'implementation', role: 'executor', risk: 'standard'
  }));

  const typo = spawnSync(process.execPath, [cli, 'route', '--config', defaultConfig, '--taks', taskPath], { encoding: 'utf8' });
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /unknown option.*--taks/i);

  const junkBool = spawnSync(process.execPath, [cli, 'lessons', '--config', defaultConfig, '--cwd', dir, '--lint=yes'], { encoding: 'utf8' });
  assert.equal(junkBool.status, 1);
  assert.match(junkBool.stderr, /boolean flag/i);

  const boolWithValue = spawnSync(process.execPath, [cli, 'lessons', '--config', defaultConfig, '--cwd', dir, '--lint', 'true'], { encoding: 'utf8' });
  assert.equal(boolWithValue.status, 0, boolWithValue.stderr);
  assert.equal(JSON.parse(boolWithValue.stdout).status, 'pass');

  const badTimeout = spawnSync(process.execPath, [cli, 'exec', '--config', defaultConfig, '--task', taskPath, '--timeout-ms', '30s'], { encoding: 'utf8' });
  assert.equal(badTimeout.status, 1);
  assert.match(badTimeout.stderr, /--timeout-ms must be/i);
});
