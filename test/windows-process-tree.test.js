import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import {
  captureWindowsProcessIdentity,
  terminateWindowsProcessTree
} from '../src/windows-process-tree.js';

test('Windows cleanup refuses to kill a PID whose creation identity does not match', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-specific process identity contract');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', windowsHide: true
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const identity = await captureWindowsProcessIdentity(child.pid);
  assert.ok(identity?.creationDate);

  const result = await terminateWindowsProcessTree({
    ...identity, creationDate: `${identity.creationDate}-mismatch`
  });

  assert.equal(result.completed, false);
  assert.match(result.errors.join('\n'), /identity mismatch/i);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
});

test('Windows cleanup removes descendants bound to the captured root identity', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-specific process identity contract');
  const child = spawn(process.execPath, ['-e', [
    "const {spawn}=require('node:child_process')",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
    "console.log(child.pid)",
    "setInterval(()=>{},1000)"
  ].join(';')], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const identity = await captureWindowsProcessIdentity(child.pid);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const descendantPid = Number(output.trim());

  const result = await terminateWindowsProcessTree(identity);

  assert.equal(result.completed, true, JSON.stringify(result));
  assert.deepEqual(result.survivors, []);
  assert.ok(result.captured.some((entry) => entry.pid === descendantPid));
  assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' });
});
