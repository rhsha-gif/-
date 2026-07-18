import { spawn } from 'node:child_process';

function killTree(child, signal) {
  if (!child) return false;
  if (process.platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  try {
    return child.kill(signal);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function taskkillTree(child, force = false) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) return killTree(child, force ? 'SIGKILL' : 'SIGTERM');
  const args = ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])];
  const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
  killer.on('error', () => {
    try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* best effort */ }
  });
  return true;
}

function signalProcessTree(child, signal) {
  if (process.platform === 'win32') return taskkillTree(child, signal === 'SIGKILL');
  return killTree(child, signal);
}

export function terminateWithEscalation(child, killGraceMs, schedule = setTimeout) {
  signalProcessTree(child, 'SIGTERM');
  return schedule(() => signalProcessTree(child, 'SIGKILL'), killGraceMs);
}

function appendBounded(current, chunk, remainingBytes) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (remainingBytes <= 0) return { text: current, appended: '', bytes: 0, overflow: buffer.length > 0 };
  const slice = buffer.subarray(0, remainingBytes);
  return {
    text: current + slice.toString(),
    appended: slice.toString(),
    bytes: slice.length,
    overflow: buffer.length > slice.length
  };
}

export function runCommand(spec, {
  cwd = process.cwd(),
  timeoutMs = 0,
  killGraceMs = 1000,
  maxOutputBytes = Number.POSITIVE_INFINITY,
  onStdout,
  onStderr,
  signal
} = {}) {
  if (!spec?.command || !Array.isArray(spec.args)) throw new TypeError('command specification is invalid');
  if (!Number.isFinite(killGraceMs) || killGraceMs < 0) throw new RangeError('killGraceMs must be non-negative');
  if (!(maxOutputBytes === Number.POSITIVE_INFINITY || (Number.isFinite(maxOutputBytes) && maxOutputBytes > 0))) {
    throw new RangeError('maxOutputBytes must be positive or Infinity');
  }
  const startedAt = new Date();

  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    let stdout = '';
    let stderr = '';
    let capturedBytes = 0;
    let timedOut = false;
    let aborted = false;
    let outputLimitExceeded = false;
    let terminationReason = null;
    let timeoutTimer = null;
    let killTimer = null;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener?.('abort', handleAbort);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const beginTermination = (reason) => {
      if (terminationReason || !child) return;
      terminationReason = reason;
      if (reason === 'timeout') timedOut = true;
      if (reason === 'aborted') aborted = true;
      if (reason === 'output-limit') outputLimitExceeded = true;
      killTimer = terminateWithEscalation(child, killGraceMs);
    };
    function handleAbort() {
      beginTermination('aborted');
    }

    try {
      child = spawn(spec.command, spec.args, {
        cwd,
        env: spec.envMode === 'replace' ? { ...(spec.env ?? {}) } : { ...process.env, ...(spec.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true
      });
    } catch (error) {
      rejectOnce(error);
      return;
    }

    if (timeoutMs > 0) timeoutTimer = setTimeout(() => beginTermination('timeout'), timeoutMs);
    if (signal?.aborted) handleAbort();
    else signal?.addEventListener?.('abort', handleAbort, { once: true });

    const capture = (streamName, chunk) => {
      const remaining = maxOutputBytes === Number.POSITIVE_INFINITY
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, maxOutputBytes - capturedBytes);
      const current = streamName === 'stdout' ? stdout : stderr;
      const appended = appendBounded(current, chunk, remaining);
      capturedBytes += appended.bytes;
      if (streamName === 'stdout') {
        stdout = appended.text;
        if (appended.appended) onStdout?.(appended.appended);
      } else {
        stderr = appended.text;
        if (appended.appended) onStderr?.(appended.appended);
      }
      if (appended.overflow || (maxOutputBytes !== Number.POSITIVE_INFINITY && capturedBytes >= maxOutputBytes)) {
        beginTermination('output-limit');
      }
    };

    child.stdout.on('data', (chunk) => capture('stdout', chunk));
    child.stderr.on('data', (chunk) => capture('stderr', chunk));
    child.on('error', rejectOnce);
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') rejectOnce(error);
    });
    child.on('close', (code, closeSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const endedAt = new Date();
      resolve({
        status: code === 0 && !terminationReason ? 'complete' : 'failed',
        exitCode: code,
        signal: closeSignal,
        timedOut,
        aborted,
        outputLimitExceeded,
        terminationReason,
        stdout,
        stderr,
        capturedOutputBytes: capturedBytes,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime()
      });
    });

    if (spec.stdin !== null && spec.stdin !== undefined) child.stdin.end(spec.stdin);
    else child.stdin.end();
  });
}
