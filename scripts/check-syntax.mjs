#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
  return files;
}

const sourceFiles = (await Promise.all(sourceRoots.map((directory) => (
  collect(directory, (name) => name.endsWith('.js') || name.endsWith('.mjs'))
)))).flat();
for (const relative of sourceFiles) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, relative)], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${relative}\n`);
    process.exit(1);
  }
}

const jsonFiles = (await Promise.all(jsonRoots.map((directory) => collect(directory, (name) => name.endsWith('.json'))))).flat();
jsonFiles.push('package.json');
for (const relative of [...new Set(jsonFiles)]) {
  JSON.parse(await readFile(path.join(root, relative), 'utf8'));
}

process.stdout.write(`Checked ${sourceFiles.length} source files and ${new Set(jsonFiles).size} JSON files.\n`);
