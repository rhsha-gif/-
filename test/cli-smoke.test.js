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

test('classify emits a route for a boilerplate objective', () => {
  const result = spawnSync(process.execPath, [
    cli, 'classify', '--config', defaultConfig, '--objective', 'Format the config JSON', '--role', 'executor'
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.classification.complexity, 'low');
  assert.ok(out.route.provider, 'route.provider should be a non-empty string');
  assert.ok(out.route.model, 'route.model should be a non-empty string');
  assert.ok(out.route.effort, 'route.effort should be a non-empty string');
  // Proves the downshift actually happens: a low-complexity task must land
  // on the cheapest in-tier Claude model, not the highest-quality one.
  assert.equal(out.route.provider, 'anthropic');
  assert.match(out.route.model, /haiku/);
});

test('help exposes the intentionally small command surface', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /route/);
  assert.match(result.stdout, /exec/);
  assert.match(result.stdout, /record/);
  assert.match(result.stdout, /install/);
  assert.match(result.stdout, /inventory/);
});



test('npm-style bin symlinks execute the CLI entrypoint', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aorch-bin-'));
  const binPath = path.join(dir, 'aorch');
  await symlink(cli, binPath);

  const result = spawnSync(binPath, ['--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Adaptive Orchestrator/);
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
