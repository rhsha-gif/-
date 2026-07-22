import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommand, terminateWithEscalation } from '../src/executor.js';

test('runs an argv-safe command and captures evidence', async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ['-e', 'process.stdout.write(process.env.AORCH_WORKER + ":ok")'],
    env: { AORCH_WORKER: '1' },
    stdin: null
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '1:ok');
  assert.equal(result.status, 'complete');
});

test('non-zero exits are reported as failed rather than hidden', async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ['-e', 'process.stderr.write("bad"); process.exit(7)'],
    env: {},
    stdin: null
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, 'bad');
  assert.equal(result.status, 'failed');
});

test('termination escalation sends SIGTERM and then SIGKILL after the grace period', () => {
  const signals = [];
  let scheduledDelay = null;
  terminateWithEscalation(
    { kill: (signal) => signals.push(signal) },
    30,
    (callback, delay) => {
      scheduledDelay = delay;
      callback();
      return Symbol('timer');
    }
  );

  assert.equal(scheduledDelay, 30);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('marks a timed-out worker failed and terminates it promptly', async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 60000)'],
    env: {},
    stdin: null,
    trackProcessTree: true
  }, { timeoutMs: 100, killGraceMs: 30 });
  assert.equal(result.timedOut, true);
  assert.equal(result.status, 'failed');
  if (process.platform === 'win32') assert.equal(result.signal, null);
  else assert.ok(['SIGTERM', 'SIGKILL'].includes(result.signal));
  assert.ok(result.durationMs < 30_000, `worker lived for ${result.durationMs}ms`);
  if (process.platform === 'win32') {
    assert.equal(result.termination.completed, true, JSON.stringify(result.termination));
    assert.deepEqual(result.termination.survivors, []);
  }
});

test('a tracked worker is reaped when the orchestrator exits', async (t) => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aorch-exit-reap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidPath = path.join(dir, 'pid.txt');
  const workerCode = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000)`;
  const helper = `
    import { runCommand } from ${JSON.stringify(new URL('../src/executor.js', import.meta.url).href)};
    runCommand({ command: process.execPath, args: ['-e', ${JSON.stringify(workerCode)}], stdin: null, trackProcessTree: true }, { timeoutMs: 60000 });
    setTimeout(() => process.exit(0), 1200);
  `;
  const runner = spawnSync(process.execPath, ['--input-type=module', '-e', helper], { encoding: 'utf8' });
  assert.equal(runner.status, 0, runner.stderr);
  const workerPid = Number(await readFile(pidPath, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.throws(() => process.kill(workerPid, 0), { code: 'ESRCH' });
});
