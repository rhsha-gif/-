import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as executor from '../src/executor.js';

const { runCommand, terminateWithEscalation } = executor;

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

test('non-Windows command resolution leaves argv execution unchanged', () => {
  const spec = { command: 'codex', args: ['exec'], stdin: 'prompt' };
  const resolved = executor.resolveWindowsCommandSpec(spec, {
    platform: 'linux',
    env: { PATH: '/tmp/bin' },
    isFile: () => true
  });

  assert.equal(resolved, spec);
});

test('Windows command resolution respects PATH order before a later native executable', () => {
  const shimDir = 'C:\\shims';
  const nativeDir = 'C:\\native';
  const nativeExecutable = path.win32.join(nativeDir, 'codex.exe');
  const files = new Set([
    path.win32.join(shimDir, 'codex.cmd').toLowerCase(),
    nativeExecutable.toLowerCase()
  ]);
  const resolved = executor.resolveWindowsCommandSpec(
    { command: 'codex', args: ['exec'], stdin: 'prompt' },
    {
      platform: 'win32',
      env: {
        PATH: `${shimDir};${nativeDir}`,
        PATHEXT: '.EXE;.CMD;.BAT',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe'
      },
      isFile: (candidate) => files.has(candidate.toLowerCase())
    }
  );

  assert.equal(resolved.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(resolved.verbatim, true);
  assert.match(resolved.args[3], /C:\\shims\\codex\.cmd/i);
  assert.equal(resolved.stdin, 'prompt');
});

test('Windows command resolution executes a PATH command shim with argv and stdin intact', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows command shim behavior');
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aorch cmd shim-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const scriptPath = path.join(dir, 'echo-argv.js');
  const shimPath = path.join(dir, 'fixture.cmd');
  await writeFile(
    scriptPath,
    'let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",(chunk)=>{input+=chunk});process.stdin.on("end",()=>process.stdout.write(JSON.stringify({args:process.argv.slice(2),stdin:input})))'
  );
  await writeFile(
    shimPath,
    `@ECHO off\r\n"${process.execPath}" "%~dp0\\echo-argv.js" %*\r\n`
  );
  const spec = {
    command: 'fixture',
    args: ['space value', 'model_reasoning_effort="high"'],
    stdin: 'shim input',
    env: {
      PATH: dir,
      PATHEXT: '.EXE;.CMD;.BAT',
      ComSpec: process.env.ComSpec
    }
  };

  const resolved = executor.resolveWindowsCommandSpec(spec);
  const result = await runCommand(resolved);

  assert.equal(resolved.command, process.env.ComSpec);
  assert.equal(resolved.verbatim, true);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    args: ['space value', 'model_reasoning_effort="high"'],
    stdin: 'shim input'
  });
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
