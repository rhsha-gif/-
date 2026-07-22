import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(root, 'scripts/run-tests.mjs');

function runTests(args) {
  return new Promise((resolve, reject) => {
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const child = spawn(process.execPath, [runner, ...args], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => {
      resolve({ pid: child.pid, status, signal, stdout, stderr });
    });
  });
}

function diagnostics(result) {
  return [
    `pid: ${result.pid}`,
    `status: ${result.status}`,
    `signal: ${result.signal}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`
  ].join('\n');
}

test('package test scripts delegate to the deterministic runner after syntax checking', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

  assert.equal(packageJson.scripts.test, 'node scripts/run-tests.mjs');
  assert.equal(packageJson.scripts.check, 'node scripts/check-syntax.mjs && node scripts/run-tests.mjs');
});

test('run-tests forwards test arguments and adds the platform concurrency setting', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aorch-run-tests-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'filtered.test.js');
  await writeFile(fixture, `
    import test from 'node:test';
    import assert from 'node:assert/strict';

    test('runner-selected', () => {
      const hasWindowsConcurrency = process.execArgv.includes('--test-concurrency=1');
      assert.equal(hasWindowsConcurrency, process.platform === 'win32');
    });

    test('runner-not-selected', () => {
      assert.fail('the name filter was not forwarded');
    });
  `);

  const result = await runTests(['--test-name-pattern=^runner-selected$', fixture]);

  assert.equal(result.status, 0, diagnostics(result));
  assert.equal(result.signal, null, diagnostics(result));
  assert.match(result.stdout, /runner-selected/, diagnostics(result));
});

test('run-tests turns a failing test run into a nonzero exit', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aorch-run-tests-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'failing.test.js');
  await writeFile(fixture, `
    import test from 'node:test';
    test('fails', () => { throw new Error('expected fixture failure'); });
  `);

  const result = await runTests([fixture]);

  assert.notEqual(result.status, 0, diagnostics(result));
});
