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

test('a worker whose orphaned child holds the stdio pipes still resolves promptly after exit', async () => {
  // Codex-style CLIs spawn helper processes that inherit stdio; waiting for
  // the 'close' event alone would then hang long after the worker exited.
  const started = Date.now();
  const result = await runCommand({
    command: process.execPath,
    args: ['-e', 'const{spawn}=require("child_process");spawn(process.execPath,["-e","setTimeout(()=>{},8000)"],{stdio:"inherit"}).unref();process.stdout.write("done")'],
    env: {},
    stdin: null
  });
  const elapsedMs = Date.now() - started;
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'complete');
  assert.match(result.stdout, /done/);
  assert.ok(elapsedMs < 6000, `runCommand took ${elapsedMs}ms waiting for an orphan`);
});

test('marks a timed-out worker failed and terminates it promptly', async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 5000)'],
    env: {},
    stdin: null
  }, { timeoutMs: 100, killGraceMs: 30 });
  assert.equal(result.timedOut, true);
  assert.equal(result.status, 'failed');
  assert.ok(['SIGTERM', 'SIGKILL'].includes(result.signal));
  // Wide margin below the 5s natural exit: this asserts the kill escalation
  // fired, not a machine-speed-dependent bound.
  assert.ok(result.durationMs < 3000, `worker lived for ${result.durationMs}ms`);
});
