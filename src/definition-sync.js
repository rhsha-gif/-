import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const contentHash = (content) => createHash('sha256').update(content).digest('hex');
export async function readOptional(file) {
  try { return await readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function scopedPath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || /^[A-Za-z]:|^[/\\]/.test(relative)) {
    throw new Error(`Expected a relative managed path: ${relative}`);
  }
  const absolute = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`)) throw new Error(`Path escapes its scope: ${relative}`);
  if (rel.split(path.sep).some((part) => /^\.env(?:\.|$)|^(?:auth|credentials)\.json$|\.(?:pem|key)$/i.test(part))) {
    throw new Error(`Secret paths cannot be managed: ${relative}`);
  }
  return absolute;
}

// Check every existing ancestor, including the file itself. A lexical check
// alone allows a generated file to escape through a directory junction.
export async function assertScopedFile(root, file) {
  const base = await realpath(root);
  let cursor = file;
  while (cursor !== path.dirname(cursor)) {
    try {
      await lstat(cursor);
      const actual = await realpath(cursor);
      const rel = path.relative(base, actual);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`Symlink escapes scope: ${file}`);
      return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    cursor = path.dirname(cursor);
  }
  throw new Error(`Cannot resolve managed path: ${file}`);
}

async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, content); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}

// The ledger is ownership evidence, not a timestamp. Preflight the entire
// update before writing any payload. Unknown or edited files are conflicts.
export async function syncGeneratedFiles({ root, files, ledgerPath = '.aorch/generated-files.json', check = false }) {
  root = path.resolve(root);
  const ledgerFile = scopedPath(root, ledgerPath);
  const inspect = async () => {
    await assertScopedFile(root, ledgerFile);
    const raw = await readOptional(ledgerFile);
    const previous = raw ? JSON.parse(raw) : { version: 1, files: {} };
    if (previous.version !== 1 || !previous.files || Array.isArray(previous.files)) throw new Error(`Invalid generated-file ledger: ${ledgerFile}`);
    const wanted = new Map();
    for (const file of files) {
      const relative = path.relative(root, scopedPath(root, file.path)).replaceAll('\\', '/');
      if (relative === ledgerPath || wanted.has(relative)) throw new Error(`Duplicate or reserved generated path: ${relative}`);
      wanted.set(relative, { ...file, path: relative, content: Buffer.from(file.content) });
    }
    const conflicts = [], changes = [], next = {};
    for (const relative of [...new Set([...Object.keys(previous.files), ...wanted.keys()])].sort()) {
      const destination = scopedPath(root, relative);
      await assertScopedFile(root, destination);
      const current = await readOptional(destination);
      const actual = current === null ? null : contentHash(current);
      const old = previous.files[relative];
      const file = wanted.get(relative);
      const desired = file ? contentHash(file.content) : null;
      if (old && (typeof old.hash !== 'string' || !/^[a-f0-9]{64}$/.test(old.hash))) throw new Error(`Invalid ownership hash: ${relative}`);
      const conflict = actual !== null && (old ? actual !== old.hash : actual !== desired && !file?.merge);
      if (conflict) { conflicts.push({ path: relative, reason: old ? 'edited-generated-file' : 'unmanaged-file', expected: old?.hash ?? null, actual }); continue; }
      if (file && !file.merge) next[relative] = { hash: desired, ...(file.definitionId ? { definitionId: file.definitionId, provider: file.provider, mode: file.mode } : {}) };
      if (actual !== desired) changes.push({ path: relative, destination, before: current, after: file?.content ?? null });
    }
    const ledger = { version: 1, files: next };
    const ledgerContent = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`);
    const ledgerChanged = raw === null || !raw.equals(ledgerContent);
    return { conflicts, changes, ledger, ledgerContent, ledgerChanged };
  };
  let lock;
  if (!check) {
    await mkdir(path.dirname(ledgerFile), { recursive: true });
    await assertScopedFile(root, ledgerFile);
    try { lock = await open(`${ledgerFile}.lock`, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') throw new Error(`Definition update already running; inspect ${ledgerFile}.lock before retrying`); throw error; }
  }
  try {
    const planned = await inspect();
    const result = { status: planned.conflicts.length ? 'conflict' : planned.changes.length || planned.ledgerChanged ? 'stale' : 'current',
      changed: planned.changes.map((entry) => entry.path), conflicts: planned.conflicts, ledger: planned.ledger };
    if (check || result.status === 'conflict' || result.status === 'current') return result;
    const backup = `.aorch/backups/${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
    // Back up all changed files before applying any change; the manifest also
    // records files newly created so rollback does not need guesswork.
    const backupRoot = scopedPath(root, backup);
    await assertScopedFile(root, backupRoot);
    for (const entry of planned.changes) {
      if (entry.before !== null) await atomicWrite(scopedPath(backupRoot, entry.path), entry.before);
    }
    const oldLedger = await readOptional(ledgerFile);
    if (oldLedger) await atomicWrite(path.join(backupRoot, 'previous-ledger.json'), oldLedger);
    await atomicWrite(path.join(backupRoot, 'manifest.json'), JSON.stringify({ root, ledgerPath, files: planned.changes.map((entry) => ({ path: entry.path, existed: entry.before !== null, afterHash: entry.after === null ? null : contentHash(entry.after) })) }, null, 2));
    for (const entry of planned.changes) {
      const now = await readOptional(entry.destination);
      if ((now === null ? null : contentHash(now)) !== (entry.before === null ? null : contentHash(entry.before))) throw new Error(`File changed during update: ${entry.path}; backup: ${backupRoot}`);
      await assertScopedFile(root, entry.destination);
      if (entry.after === null) await rm(entry.destination, { force: true });
      else await atomicWrite(entry.destination, entry.after);
    }
    await atomicWrite(ledgerFile, planned.ledgerContent);
    return { ...result, status: 'updated', backup: backupRoot };
  } finally {
    if (lock) { await lock.close(); await rm(`${ledgerFile}.lock`, { force: true }); }
  }
}
