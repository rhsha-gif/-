import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runVerificationCommands } from '../src/verify.js';

// Quote the interpreter path: it may contain spaces on Windows, and the
// command line goes through a real platform shell.
const node = `"${process.execPath}"`;

async function temporaryDirectory(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aorch-verify-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('a passing command sequence reports passed with per-command evidence', async (t) => {
  const cwd = await temporaryDirectory(t);
  const verification = await runVerificationCommands({
    commands: [`${node} -e "process.exit(0)"`],
    cwd
  });
  assert.equal(verification.passed, true);
  assert.equal(verification.results.length, 1);
  assert.equal(verification.results[0].status, 'complete');
  assert.equal(verification.results[0].exitCode, 0);
});

test('a failing command reports passed=false with the exit code and stderr tail', async (t) => {
  const cwd = await temporaryDirectory(t);
  const verification = await runVerificationCommands({
    commands: [`${node} -e "console.error('boom'); process.exit(3)"`],
    cwd
  });
  assert.equal(verification.passed, false);
  assert.equal(verification.results[0].status, 'failed');
  assert.equal(verification.results[0].exitCode, 3);
  assert.match(verification.results[0].stderrTail, /boom/);
});

test('verification stops at the first failure so later commands cannot bury evidence', async (t) => {
  const cwd = await temporaryDirectory(t);
  const marker = path.join(cwd, 'marker.txt');
  const verification = await runVerificationCommands({
    commands: [
      `${node} -e "process.exit(1)"`,
      `${node} -e "require('fs').writeFileSync('marker.txt', 'ran')"`
    ],
    cwd
  });
  assert.equal(verification.passed, false);
  assert.equal(verification.results.length, 1);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('verification commands run with AORCH_VERIFIER=1 so installed hooks can stand aside', async (t) => {
  const cwd = await temporaryDirectory(t);
  const verification = await runVerificationCommands({
    commands: [`${node} -e "process.exit(process.env.AORCH_VERIFIER === '1' ? 0 : 1)"`],
    cwd
  });
  assert.equal(verification.passed, true);
});

test('output tails are capped so escalation evidence stays within budget', async (t) => {
  const cwd = await temporaryDirectory(t);
  const verification = await runVerificationCommands({
    commands: [`${node} -e "console.error('x'.repeat(5000)); process.exit(1)"`],
    cwd
  });
  assert.equal(verification.passed, false);
  assert.ok(verification.results[0].stderrTail.length <= 2048);
  assert.match(verification.results[0].stderrTail, /x/);
});

test('a blank command is rejected instead of silently passing', async (t) => {
  const cwd = await temporaryDirectory(t);
  await assert.rejects(
    runVerificationCommands({ commands: ['   '], cwd }),
    TypeError
  );
});
