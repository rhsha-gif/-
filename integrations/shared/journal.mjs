import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    return false;
  }
}

async function inspectLock(lockPath, staleMs) {
  const info = await stat(lockPath);
  let raw = null;
  let owner = null;
  try {
    raw = await readFile(lockPath, 'utf8');
    owner = JSON.parse(raw);
  } catch { owner = null; }
  return { raw, abandoned: Date.now() - info.mtimeMs > staleMs && !processIsAlive(owner?.pid) };
}

// Rename-based reclaim: unlinking by path could delete a fresh lock created by
// a concurrent reclaimer. Move the entry aside, confirm it is the same stale
// lock we inspected, and restore it if it is not.
async function reclaimAbandonedLock(lockPath, inspected) {
  const reclaimPath = `${lockPath}.reclaim-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, reclaimPath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  let raw = null;
  try { raw = await readFile(reclaimPath, 'utf8'); } catch { raw = null; }
  if (raw === inspected.raw) {
    await unlink(reclaimPath).catch(() => {});
    return;
  }
  await rename(reclaimPath, lockPath).catch(() => unlink(reclaimPath).catch(() => {}));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function checksum(entry) {
  return createHash('sha256').update(JSON.stringify(stableValue({
    journalVersion: entry.journalVersion,
    sequence: entry.sequence,
    recordedAt: entry.recordedAt,
    payload: entry.payload
  }))).digest('hex');
}

async function acquire(lockPath, { staleMs = 30_000, timeoutMs = 2_000 } = {}) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      await handle.sync();
      await handle.close();
      return () => unlink(lockPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error.code !== 'EEXIST') throw error;
      try {
        const lock = await inspectLock(lockPath, staleMs);
        if (lock.abandoned) { await reclaimAbandonedLock(lockPath, lock); continue; }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring lifecycle journal lock: ${lockPath}`);
      await sleep(20);
    }
  }
}

async function readJournalState(filePath) {
  // Count only parseable records, matching aorch readJournal's sequence
  // expectation: a torn tail line is an issue there, not an entry, so counting
  // it here would make every later append fail sequence validation after
  // repair. Torn tails also lack a trailing newline; report that so the next
  // append starts a fresh line instead of gluing onto the corrupt fragment.
  try {
    const raw = await readFile(filePath, 'utf8');
    let count = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { JSON.parse(line); count += 1; } catch { /* torn tail; repaired by doctor */ }
    }
    return { count, endsWithNewline: raw.length === 0 || raw.endsWith('\n') };
  } catch (error) {
    if (error.code === 'ENOENT') return { count: 0, endsWithNewline: true };
    throw error;
  }
}

export async function appendJournalRecord(filePath, payload) {
  const release = await acquire(`${filePath}.lock`);
  try {
    const journal = await readJournalState(filePath);
    const entry = {
      journalVersion: 1,
      sequence: journal.count + 1,
      recordedAt: new Date().toISOString(),
      payload
    };
    entry.checksum = checksum(entry);
    await mkdir(path.dirname(filePath), { recursive: true });
    const handle = await open(filePath, 'a', 0o600);
    try {
      await handle.writeFile(`${journal.endsWithNewline ? '' : '\n'}${JSON.stringify(entry)}\n`);
      await handle.sync();
    }
    finally { await handle.close(); }
    return entry;
  } finally {
    await release();
  }
}
