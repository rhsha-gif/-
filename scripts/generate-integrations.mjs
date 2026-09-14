import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDefinitions, renderDefinitions } from '../src/definitions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const definitions = (await loadDefinitions({ cwd: root })).filter((entry) => entry.sourceScope === 'shared');
const files = await renderDefinitions({ definitions, target: 'all', resolveRoot: false });
let changes = 0;
for (const file of files) {
  const relative = file.provider === 'anthropic' ? file.path.replace(/^\.claude\//, 'integrations/claude/')
    : file.provider === 'openai' ? file.path.replace(/^\.codex\//, 'integrations/codex/').replace(/^\.agents\//, 'integrations/codex/')
      : file.provider === 'antigravity' ? file.path.replace(/^\.agents\//, 'integrations/antigravity/')
        : file.path.replace(/^\.grok\//, 'integrations/grok/');
  const destination = path.join(root, relative);
  let existing;
  try { existing = await readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const content = Buffer.from(file.content.toString().replace(/\r\n/g, '\n'));
  if (existing && existing.toString().replace(/\r\n/g, '\n') === content.toString()) continue;
  changes += 1;
  if (process.argv.includes('--check')) continue;
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
}
// Antigravity's flat skill entry keeps companion assets in a hidden sibling
// tree. Remove directories produced by the earlier layout, but only for known
// generated skill IDs and only beneath the generated integration root.
for (const definition of definitions.filter((entry) => entry.type === 'skill')) {
  const obsolete = path.join(root, 'integrations', 'antigravity', 'skills', definition.id);
  let present = false;
  try { present = (await readdir(obsolete)).length >= 0; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!present) continue;
  changes += 1;
  if (!process.argv.includes('--check')) await rm(obsolete, { recursive: true, force: true });
}
process.stdout.write(`Generated integrations: ${changes} ${process.argv.includes('--check') ? 'out of date' : 'updated'}\n`);
if (changes && process.argv.includes('--check')) process.exitCode = 1;
