import { spawn } from 'node:child_process';

export function terminateWithEscalation(child, killGraceMs, schedule = setTimeout) {
  child.kill('SIGTERM');
  return schedule(() => child.kill('SIGKILL'), killGraceMs);
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
      // cmd.exe does not understand Node's backslash-escaped quotes; callers
      // spawning it pass a pre-quoted command line and opt out of escaping.
      windowsVerbatimArguments: spec.verbatim === true,
      signal
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer = null;
    let drainTimer = null;
    let settled = false;
    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
    };
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      killTimer = terminateWithEscalation(child, killGraceMs);
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
      clearTimers();
      reject(error);
    });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
        clearTimers();
        reject(error);
      }
    });
    const settle = (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      const endedAt = new Date();
      resolve({
        status: code === 0 && !timedOut ? 'complete' : 'failed',
        exitCode: code,
        signal: closeSignal,
        timedOut,
        stdout,
        stderr,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime()
      });
    };
    // 'close' waits for every stdio consumer; a worker that leaves behind a
    // helper process holding the inherited pipes would park us here forever.
    // After the worker itself exits, allow a short drain window and settle.
    child.on('exit', (code, exitSignal) => {
      drainTimer = setTimeout(() => settle(code, exitSignal), 2000);
    });
    child.on('close', settle);

    if (spec.stdin !== null && spec.stdin !== undefined) child.stdin.end(spec.stdin);
    else child.stdin.end();
  });
}
