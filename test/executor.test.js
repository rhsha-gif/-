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

test('terminates a shell process group including long-lived descendants', { skip: process.platform === 'win32' }, async () => {
  const result = await runCommand({
    command: '/bin/sh',
    args: ['-c', `${process.execPath} -e "setTimeout(() => {}, 60000)"`],
    env: {},
    stdin: null
  }, { timeoutMs: 100, killGraceMs: 30 });

  assert.equal(result.timedOut, true);
  assert.equal(result.terminationReason, 'timeout');
  assert.equal(result.status, 'failed');
  assert.ok(result.durationMs < 3000, `process tree lived for ${result.durationMs}ms`);
});

test('bounds combined worker output and terminates an output flood', async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ['-e', 'for(;;){process.stdout.write("x".repeat(4096));process.stderr.write("y".repeat(4096));}'],
    env: {},
    stdin: null
  }, { timeoutMs: 5000, killGraceMs: 30, maxOutputBytes: 16 * 1024 });

  assert.equal(result.outputLimitExceeded, true);
  assert.equal(result.terminationReason, 'output-limit');
  assert.equal(result.status, 'failed');
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 16 * 1024);
});
