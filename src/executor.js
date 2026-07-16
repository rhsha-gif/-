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
      signal
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer = null;
    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
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
    child.on('close', (code, closeSignal) => {
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
    });

    if (spec.stdin !== null && spec.stdin !== undefined) child.stdin.end(spec.stdin);
    else child.stdin.end();
  });
}
