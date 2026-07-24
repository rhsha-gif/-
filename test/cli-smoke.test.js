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

test('run command supports start, finish, and show', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aorch-run-cli-'));
  const manifestPath = path.join(dir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify({ prompt: 'build it', runId: 'RCLI', tasks: [] }));

  const start = spawnSync(process.execPath, [cli, 'run', '--action', 'start', '--config', defaultConfig, '--cwd', dir, '--input', manifestPath], { encoding: 'utf8' });
  assert.equal(start.status, 0, start.stderr);
  assert.equal(JSON.parse(start.stdout).run.id, 'RCLI');

  const finish = spawnSync(process.execPath, [cli, 'run', '--action', 'finish', '--config', defaultConfig, '--cwd', dir, '--run', 'active', '--status', 'completed'], { encoding: 'utf8' });
  assert.equal(finish.status, 0, finish.stderr);
  assert.equal(JSON.parse(finish.stdout).run.status, 'completed');

  const show = spawnSync(process.execPath, [cli, 'run', '--action', 'show', '--config', defaultConfig, '--cwd', dir, '--run', 'RCLI'], { encoding: 'utf8' });
  assert.equal(show.status, 0, show.stderr);
  assert.equal(JSON.parse(show.stdout).run.id, 'RCLI');
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

  const junkBool = spawnSync(process.execPath, [cli, 'inventory', '--config', defaultConfig, '--cwd', dir, '--project-only=yes'], { encoding: 'utf8' });
  assert.equal(junkBool.status, 1);
  assert.match(junkBool.stderr, /boolean flag/i);

  const boolWithValue = spawnSync(process.execPath, [cli, 'inventory', '--config', defaultConfig, '--cwd', dir, '--project-only', 'true'], { encoding: 'utf8' });
  assert.equal(boolWithValue.status, 0, boolWithValue.stderr);
  assert.ok(Array.isArray(JSON.parse(boolWithValue.stdout).providers));

  const badTimeout = spawnSync(process.execPath, [cli, 'exec', '--config', defaultConfig, '--task', taskPath, '--timeout-ms', '30s'], { encoding: 'utf8' });
  assert.equal(badTimeout.status, 1);
  assert.match(badTimeout.stderr, /--timeout-ms must be/i);
});
