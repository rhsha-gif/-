import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function buildTestInvocations(args, {
  platform = process.platform,
  supportsConcurrency = supportsTestConcurrency(),
  discoveredFiles = []
} = {}) {
  if (platform !== 'win32' || supportsConcurrency) {
    return [['--test', ...(platform === 'win32' ? ['--test-concurrency=1'] : []), ...args]];
  }

  const explicitFiles = args.filter((value) => !value.startsWith('-') && /\.test\.[cm]?js$/i.test(value));
  const options = args.filter((value) => !explicitFiles.includes(value));
  const files = explicitFiles.length > 0 ? explicitFiles : discoveredFiles;
  return files.map((file) => ['--test', ...options, file]);
}

export function supportsTestConcurrency(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major > 20 || (major === 20 && minor >= 10);
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.once('error', (error) => {
      console.error(error);
      resolve(1);
    });
    child.once('exit', (code, signal) => resolve(signal || code === null ? 1 : code));
  });
}

async function main(args) {
  const supportsConcurrency = supportsTestConcurrency();
  let discoveredFiles = [];
  if (process.platform === 'win32' && !supportsConcurrency
    && !args.some((value) => !value.startsWith('-') && /\.test\.[cm]?js$/i.test(value))) {
    discoveredFiles = (await readdir('test'))
      .filter((value) => /\.test\.[cm]?js$/i.test(value))
      .sort()
      .map((value) => path.join('test', value));
  }
  const invocations = buildTestInvocations(args, { supportsConcurrency, discoveredFiles });
  if (invocations.length === 0) throw new Error('No test files were discovered');
  for (const invocation of invocations) {
    const exitCode = await run(invocation);
    if (exitCode !== 0) return exitCode;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (exitCode) => { process.exitCode = exitCode; },
    (error) => { console.error(error); process.exitCode = 1; }
  );
}
