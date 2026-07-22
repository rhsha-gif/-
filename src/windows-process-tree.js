import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/windows-process-tree.ps1');

function failure(message, identity = null) {
  return {
    method: 'cim-snapshot', attempted: true, completed: false, identity,
    captured: [], survivors: [], errors: [message]
  };
}

function parseResult(stdout, stderr, exitCode, identity = null) {
  try {
    const result = JSON.parse(stdout.trim());
    for (const field of ['captured', 'survivors', 'errors']) {
      const value = result[field];
      result[field] = Array.isArray(value) ? value : value == null ? [] : [value];
    }
    if (stderr.trim()) result.errors.push(stderr.trim());
    if (exitCode !== 0) result.completed = false;
    return result;
  } catch (error) {
    return failure(`cleanup evidence was invalid: ${error.message}`, identity);
  }
}

function runHelper(args, { timeoutMs, identity = null } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT, ...args
    ], { shell: false, windowsHide: true });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish(failure(error.message, identity)));
    child.once('close', (code) => finish(parseResult(stdout, stderr, code, identity)));
    const deadline = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish(failure('cleanup deadline exceeded', identity));
    }, timeoutMs);
  });
}

export async function captureWindowsProcessIdentity(pid, { timeoutMs = 15_000 } = {}) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return null;
  const result = await runHelper([
    '-RootPid', String(pid), '-Mode', 'Snapshot', '-TimeoutMs', String(Math.max(1, timeoutMs - 250))
  ], { timeoutMs });
  return result.completed ? result.identity : null;
}

export function terminateWindowsProcessTree(identity, { timeoutMs = 30_000 } = {}) {
  if (process.platform !== 'win32' || !identity?.pid || !identity.creationDate) {
    return Promise.resolve(failure('captured root process identity is unavailable', identity));
  }
  return runHelper([
    '-RootPid', String(identity.pid), '-Mode', 'Terminate',
    '-ExpectedCreationDate', String(identity.creationDate),
    '-TimeoutMs', String(Math.max(1, timeoutMs - 1_000))
  ], { timeoutMs, identity });
}

export function terminateWindowsProcessTreeSync(identity, { timeoutMs = 5_000 } = {}) {
  if (process.platform !== 'win32' || !identity?.pid || !identity.creationDate) {
    return failure('captured root process identity is unavailable', identity);
  }
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT,
    '-RootPid', String(identity.pid), '-Mode', 'Terminate',
    '-ExpectedCreationDate', String(identity.creationDate),
    '-TimeoutMs', String(Math.max(1, timeoutMs - 250))
  ], { encoding: 'utf8', shell: false, windowsHide: true, timeout: timeoutMs });
  if (result.error) return failure(result.error.message, identity);
  return parseResult(result.stdout ?? '', result.stderr ?? '', result.status, identity);
}
