import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

function environmentValue(env, name) {
  const key = Object.keys(env).find((entry) => entry.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function regularFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function quoteWindowsArgument(value) {
  let quoted = '"';
  let backslashes = 0;
  for (const character of String(value)) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += `${'\\'.repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    quoted += `${'\\'.repeat(backslashes)}${character}`;
    backslashes = 0;
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

export function resolveWindowsCommandSpec(spec, {
  platform = process.platform,
  env = { ...process.env, ...(spec?.env ?? {}) },
  isFile = regularFile
} = {}) {
  if (platform !== 'win32' || typeof spec?.command !== 'string') return spec;
  if (/[\\/]/u.test(spec.command) || path.win32.extname(spec.command) !== '') return spec;

  const searchPath = environmentValue(env, 'PATH') ?? '';
  const directories = searchPath
    .split(';')
    .map((entry) => entry.trim().replace(/^"(.*)"$/u, '$1'))
    .filter(Boolean);
  const pathExt = environmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD';
  const shimExtensions = pathExt
    .split(';')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry === '.cmd' || entry === '.bat');
  for (const directory of directories) {
    const executable = path.win32.join(directory, `${spec.command}.exe`);
    if (isFile(executable)) return { ...spec, command: executable };
    for (const extension of shimExtensions) {
      const candidate = path.win32.join(directory, `${spec.command}${extension}`);
      if (!isFile(candidate)) continue;
      // A .cmd/.bat shim runs through cmd.exe, which re-parses the command line
      // and cannot carry these characters verbatim: an unbalanced quote reopens
      // quote state and '& | < >' then start a fresh command (BatBadBut /
      // CVE-2024-27980), while '%' triggers environment expansion. These never
      // appear in a legitimate model id, effort, or evidence path, so fail
      // closed rather than escape — a bad receipt config must not reach a shell.
      const unsafe = [candidate, ...spec.args].find((argument) => /[&|<>^%\r\n]/u.test(String(argument)));
      if (unsafe !== undefined) {
        throw new Error(`Refusing to launch cmd shim: argument contains characters unsafe for cmd.exe: ${JSON.stringify(unsafe)}`);
      }
      const commandLine = [candidate, ...spec.args].map(quoteWindowsArgument).join(' ');
      return {
        ...spec,
        command: environmentValue(env, 'COMSPEC') ?? 'cmd.exe',
        args: ['/d', '/s', '/c', `"${commandLine}"`],
        verbatim: true
      };
    }
  }
  return spec;
}

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
      drainTimer = setTimeout(() => {
        // Settling alone leaves our read ends of the inherited pipes open while
        // the orphan holds the write ends, keeping the event loop alive so the
        // whole process hangs after this promise resolves. Release them first.
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(code, exitSignal);
      }, 2000);
    });
    child.on('close', settle);

    if (spec.stdin !== null && spec.stdin !== undefined) child.stdin.end(spec.stdin);
    else child.stdin.end();
  });
}
