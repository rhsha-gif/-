import { spawn } from 'node:child_process';

const args = [
  '--test',
  ...(process.platform === 'win32' ? ['--test-concurrency=1'] : []),
  ...process.argv.slice(2)
];

const child = spawn(process.execPath, args, { stdio: 'inherit' });

child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  process.exitCode = signal || code === null ? 1 : code;
});
