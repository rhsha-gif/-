#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);

// SourceTextModule is still flag-gated on supported Node 20/22 releases. Re-exec
// once with the parser enabled instead of spawning one `node --check` process
// per source file. The old implementation created dozens of short-lived
// runtimes for every release check and multiplied that startup cost on repeats.
if (typeof vm.SourceTextModule !== 'function') {
  const result = spawnSync(process.execPath, [
    '--no-warnings',
    '--experimental-vm-modules',
    scriptPath,
    '--vm-child'
  ], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const root = path.resolve(path.dirname(scriptPath), '..');
const sourceRoots = ['src', 'test', 'integrations', 'scripts'];
const jsonRoots = ['config', 'schemas', 'examples', 'integrations'];

async function collect(directory, predicate) {
  const absolute = path.join(root, directory);
  const files = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(relative, predicate));
    else if (predicate(entry.name)) files.push(relative);
  }
  return files.sort();
}

const sourceFiles = (await Promise.all(sourceRoots.map((directory) => (
  collect(directory, (name) => name.endsWith('.js') || name.endsWith('.mjs'))
)))).flat().sort();

for (const relative of sourceFiles) {
  const absolute = path.join(root, relative);
  const source = (await readFile(absolute, 'utf8')).replace(/^#![^\n]*(?:\n|$)/, '\n');
  try {
    // Construction performs a full ESM parse without executing or linking the
    // module, so syntax checking remains deterministic and side-effect free.
    new vm.SourceTextModule(source, { identifier: pathToFileURL(absolute).href });
  } catch (error) {
    process.stderr.write(`Syntax check failed: ${relative}\n${error.stack ?? error.message}\n`);
    process.exit(1);
  }
}

const jsonFiles = (await Promise.all(jsonRoots.map((directory) => (
  collect(directory, (name) => name.endsWith('.json'))
)))).flat();
jsonFiles.push('package.json');
for (const relative of [...new Set(jsonFiles)].sort()) {
  JSON.parse(await readFile(path.join(root, relative), 'utf8'));
}

process.stdout.write(`Checked ${sourceFiles.length} source files and ${new Set(jsonFiles).size} JSON files.\n`);
