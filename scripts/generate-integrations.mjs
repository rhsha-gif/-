import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDefinitions, renderDefinitions } from '../src/definitions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const definitions = (await loadDefinitions({ cwd: root })).filter((entry) => entry.sourceScope === 'shared');
const files = await renderDefinitions({ definitions, resolveRoot: false });
let changes = 0;
for (const file of files) {
  const relative = file.path.replace(/^\.claude\//, 'integrations/claude/').replace(/^\.codex\//, 'integrations/codex/').replace(/^\.agents\//, 'integrations/codex/');
  const destination = path.join(root, relative);
  let existing;
  try { existing = await readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing?.equals(Buffer.from(file.content))) continue;
  changes += 1;
  if (process.argv.includes('--check')) continue;
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, file.content);
}
process.stdout.write(`Generated integrations: ${changes} ${process.argv.includes('--check') ? 'out of date' : 'updated'}\n`);
if (changes && process.argv.includes('--check')) process.exitCode = 1;
