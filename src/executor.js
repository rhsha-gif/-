import { spawn } from 'node:child_process';
import {
  captureWindowsProcessIdentity,
  terminateWindowsProcessTree,
  terminateWindowsProcessTreeSync
} from './windows-process-tree.js';

export function terminateWithEscalation(child, killGraceMs, schedule = setTimeout) {
  try { child.kill('SIGTERM'); } catch {}
  return schedule(() => {
    try { child.kill('SIGKILL'); } catch {}
  }, killGraceMs);
}

const liveChildren = new Set();
const signalHandlers = new Map();
let handlersInstalled = false;

function killRoot(child) {
  try { child.kill('SIGKILL'); } catch {}
}

function reapAllChildren() {
  for (const entry of liveChildren) {
    if (process.platform === 'win32' && entry.identity) {
      terminateWindowsProcessTreeSync(entry.identity);
    } else {
      killRoot(entry.child);
    }
  }
}

function ensureCleanupHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on('exit', reapAllChildren);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      reapAllChildren();
      process.removeListener(signal, handler);
      if (process.platform === 'win32') process.exit(1);
      else process.kill(process.pid, signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function registerChild(child, trackProcessTree) {
  if (!trackProcessTree) return null;
  const entry = { child, identity: null, identityPromise: Promise.resolve(null) };
  if (process.platform === 'win32') {
    entry.identityPromise = captureWindowsProcessIdentity(child.pid).then((identity) => {
      entry.identity = identity;
      return identity;
    });
  }
  liveChildren.add(entry);
  ensureCleanupHandlers();
  return entry;
}

function unregisterChild(entry) {
  if (!entry) return;
  liveChildren.delete(entry);
  if (liveChildren.size === 0 && handlersInstalled) {
    handlersInstalled = false;
    process.removeListener('exit', reapAllChildren);
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    signalHandlers.clear();
  }
}

async function terminateTrackedChild(entry, child) {
  const deadline = Date.now() + 30_000;
  const identity = await entry.identityPromise;
  if (!identity) {
    killRoot(child);
    return {
      method: 'cim-snapshot', attempted: false, completed: false, identity: null,
      captured: [], survivors: [], errors: ['root process identity was not captured']
    };
  }
  const termination = await terminateWindowsProcessTree(identity, {
    timeoutMs: Math.max(1, deadline - Date.now())
  });
  if (!termination.completed) killRoot(child);
  return termination;
}

export function runCommand(spec, {
  cwd = process.cwd(),
  timeoutMs = 0,
  killGraceMs = 1000,
  onStdout,
  onStderr,
  signal
} = {}) {
  if (!spec?.command || !Array.isArray(spec.args)) throw new TypeError('command specification is invalid');
  if (!Number.isFinite(killGraceMs) || killGraceMs < 0) throw new RangeError('killGraceMs must be non-negative');
  const startedAt = new Date();

  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: { ...process.env, ...(spec.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsVerbatimArguments: spec.windowsVerbatimArguments === true,
      signal
    });
    const tracked = registerChild(child, spec.trackProcessTree === true);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer = null;
    let settled = false;
    let outcome = null;
    let termination = null;
    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimers();
      unregisterChild(tracked);
      callback(value);
    };
    const finish = () => {
      if (!outcome && !termination) return;
      const endedAt = new Date();
      settle(resolve, {
        status: outcome?.code === 0 && !timedOut ? 'complete' : 'failed',
        exitCode: outcome?.code ?? null,
        signal: outcome?.signal ?? null,
        timedOut,
        stdout,
        stderr,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
        ...(termination ? { termination } : {})
      });
    };
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && tracked) {
        void terminateTrackedChild(tracked, child).then((value) => {
          termination = value;
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish();
        });
      } else {
        killTimer = terminateWithEscalation(child, killGraceMs);
      }
    }, timeoutMs) : null;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onStderr?.(text);
    });
    child.on('error', (error) => {
      settle(reject, error);
    });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
        settle(reject, error);
      }
    });
    child.on('close', (code, closeSignal) => {
      outcome = { code, signal: closeSignal };
      if (!timedOut || process.platform !== 'win32' || !tracked) finish();
    });

    if (spec.stdin !== null && spec.stdin !== undefined) child.stdin.end(spec.stdin);
    else child.stdin.end();
  });
}
