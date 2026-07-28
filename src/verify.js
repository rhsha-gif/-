import { runCommand } from './executor.js';

// Escalation evidence budget: only the tail of each stream survives, so a
// noisy test runner cannot blow up the retry prompt.
const EVIDENCE_TAIL_CHARS = 2048;

function tail(text) {
  return text.length > EVIDENCE_TAIL_CHARS ? text.slice(-EVIDENCE_TAIL_CHARS) : text;
}

// Verification commands are user-authored shell one-liners from the task
// envelope, so they run through the platform shell rather than argv parsing.
// On Windows the whole command is wrapped in quotes and passed verbatim:
// cmd.exe /s strips that outer pair, preserving any quoting inside.
function shellSpec(command) {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${command}"`],
      verbatim: true
    };
  }
  return { command: '/bin/sh', args: ['-c', command] };
}

export async function runVerificationCommands({
  commands = [],
  cwd = process.cwd(),
  timeoutMs = 15 * 60 * 1000
}) {
  const results = [];
  for (const command of commands) {
    if (typeof command !== 'string' || command.trim() === '') {
      throw new TypeError('verification commands must be non-empty strings');
    }
    const result = await runCommand(
      { ...shellSpec(command), env: { AORCH_VERIFIER: '1' } },
      { cwd, timeoutMs }
    );
    results.push({
      command,
      status: result.status,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr)
    });
    // Fail fast: later commands usually assume earlier ones passed, and their
    // output would bury the actual failure evidence.
    if (result.status !== 'complete') break;
  }
  return {
    passed: results.length === commands.length && results.every((entry) => entry.status === 'complete'),
    results
  };
}
