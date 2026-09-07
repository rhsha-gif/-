import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('classify routes from observations without launching live plugin or quota probes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aorch-classify-offline-'));
  const preload = path.join(dir, 'offline.mjs');
  const launchLog = path.join(dir, 'launches.jsonl');
  const observations = path.join(dir, 'observations.jsonl');
  await writeFile(preload, `
    import childProcess from 'node:child_process';
    import os from 'node:os';
    import { appendFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    os.homedir = () => ${JSON.stringify(dir)};
    childProcess.spawn = (command, args) => {
      appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify({ command, args }) + '\\n');
      throw new Error('Live provider probes are forbidden in this test');
    };
    syncBuiltinESMExports();
  `);
  const classify = () => spawnSync(process.execPath, [
    '--import', pathToFileURL(preload).href, path.join(root, 'src/cli.js'), 'classify',
    '--config', path.join(root, 'config/aorch.config.json'), '--cwd', dir,
    '--objective', 'Extract the atomic write helper into a shared module', '--observations', observations
  ], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: path.join(dir, '.codex') }, timeout: 5000 });

  const coldResult = classify();
  assert.equal(coldResult.status, 0, coldResult.stderr);
  const cold = JSON.parse(coldResult.stdout);
  assert.equal(cold.route.provider, 'anthropic');
  assert.equal(cold.route.model, 'haiku');
  await assert.rejects(readFile(launchLog, 'utf8'), { code: 'ENOENT' });

  await writeFile(observations, Array.from({ length: 12 }, () => JSON.stringify({
    recordedAt: new Date().toISOString(), provider: cold.route.provider, model: cold.route.model,
    effort: cold.route.effort, taskKind: cold.classification.kind, quality: 0.2, reviewed: true
  })).join('\n') + '\n');
  const warmedResult = classify();
  assert.equal(warmedResult.status, 0, warmedResult.stderr);
  assert.notEqual(JSON.parse(warmedResult.stdout).route.model, 'haiku');

  await writeFile(observations, '{broken\n');
  const malformedResult = classify();
  assert.equal(malformedResult.status, 0, malformedResult.stderr);
  assert.deepEqual(JSON.parse(malformedResult.stdout).route, cold.route);
  assert.match(malformedResult.stderr, /ignoring unreadable observations/);
  await assert.rejects(readFile(launchLog, 'utf8'), { code: 'ENOENT' });
});
