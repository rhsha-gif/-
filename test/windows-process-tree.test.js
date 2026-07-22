import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import {
  captureWindowsProcessIdentity,
  terminateWindowsProcessTree
} from '../src/windows-process-tree.js';

function killIfRunning(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

function readJsonLine(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline === -1) return;
      cleanup();
      resolve(JSON.parse(output.slice(0, newline)));
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error('process exited before emitting readiness')); };
    const cleanup = () => {
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

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

test('Windows cleanup captures a grandchild spawned after the initial snapshot', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-specific process identity contract');
  const sleeper = "setInterval(()=>{},1000)";
  const watcherSource = [
    "const {spawn}=require('node:child_process')",
    "const rootPid=Number(process.argv[1])",
    `const sleeper=${JSON.stringify(sleeper)}`,
    "const decoys=Array.from({length:12},()=>spawn(process.execPath,['-e',sleeper],{stdio:'ignore',windowsHide:true}))",
    "console.log(JSON.stringify({decoys:decoys.map(child=>child.pid)}))",
    "let spawned=false",
    "setInterval(()=>{if(spawned)return;try{process.kill(rootPid,0)}catch{spawned=true;spawn(process.execPath,['-e',sleeper],{stdio:'ignore',windowsHide:true})}},1)",
    "setInterval(()=>{},1000)"
  ].join(';');
  const rootSource = [
    "const {spawn}=require('node:child_process')",
    `const watcherSource=${JSON.stringify(watcherSource)}`,
    "const watcher=spawn(process.execPath,['-e',watcherSource,String(process.pid)],{stdio:['ignore','pipe','ignore'],windowsHide:true})",
    "watcher.stdout.pipe(process.stdout)",
    "setInterval(()=>{},1000)"
  ].join(';');
  const root = spawn(process.execPath, ['-e', rootSource], {
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true
  });
  const cleanupPids = new Set([root.pid]);
  let result;
  t.after(() => {
    for (const entry of result?.captured ?? []) cleanupPids.add(entry.pid);
    for (const pid of cleanupPids) killIfRunning(pid);
  });
  const ready = await readJsonLine(root);
  for (const pid of ready.decoys) cleanupPids.add(pid);
  const initialDescendants = new Set(ready.decoys);
  const identity = await captureWindowsProcessIdentity(root.pid);
  assert.ok(identity?.creationDate);

  result = await terminateWindowsProcessTree(identity);

  assert.equal(result.completed, true, JSON.stringify(result));
  const lateGrandchild = result.captured.find((entry) =>
    entry.depth === 2 && !initialDescendants.has(entry.pid));
  assert.ok(lateGrandchild, JSON.stringify(result));
  assert.throws(() => process.kill(lateGrandchild.pid, 0), { code: 'ESRCH' });
});

test('Windows cleanup fails closed when the captured root exits before cleanup', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-specific process identity contract');
  const root = spawn(process.execPath, ['-e', [
    "const {spawn}=require('node:child_process')",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});child.unref()",
    "console.log(child.pid)",
    "process.stdin.resume();process.stdin.once('data',()=>process.exit(0))"
  ].join(';')], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  let output = '';
  root.stdout.setEncoding('utf8');
  root.stdout.on('data', (chunk) => { output += chunk; });
  const rootClosed = new Promise((resolve, reject) => {
    root.once('error', reject);
    root.once('close', resolve);
  });
  const identity = await captureWindowsProcessIdentity(root.pid);
  assert.ok(identity?.creationDate);
  root.stdin.end('exit');
  await rootClosed;
  const descendantPid = Number(output.trim());
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
  t.after(() => { try { process.kill(descendantPid, 'SIGKILL'); } catch {} });

  const result = await terminateWindowsProcessTree(identity);

  assert.equal(result.completed, false, JSON.stringify(result));
  assert.equal(result.attempted, false);
  assert.match(result.errors.join('\n'), /root process exited.*identity-bound/i);
  assert.doesNotThrow(() => process.kill(descendantPid, 0));
});
