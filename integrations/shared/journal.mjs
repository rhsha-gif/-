import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
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

const HARD_STALE_LOCK_MS = 60 * 60 * 1000;

async function inspectLock(lockPath, staleMs) {
  const info = await stat(lockPath);
  let raw = null;
  let owner = null;
  try {
    raw = await readFile(lockPath, 'utf8');
    owner = JSON.parse(raw);
  } catch { owner = null; }
  const ageMs = Date.now() - info.mtimeMs;
  // PID reuse or EPERM can make a dead owner look alive forever; locks guard
  // millisecond-scale appends, so a very old lock is reclaimable regardless.
  return { info, raw, abandoned: (ageMs > staleMs && !processIsAlive(owner?.pid)) || ageMs > HARD_STALE_LOCK_MS };
}

// Rename-based reclaim: unlinking by path could delete a fresh lock created by
// a concurrent reclaimer. Move the entry aside, confirm it is the same stale
// lock we inspected, and restore it without clobbering any newer lock.
async function reclaimAbandonedLock(lockPath, inspected) {
  // The lock judged stale may have been replaced since inspection; renaming a
  // fresh lock aside breaks its owner's mutual exclusion. Re-check identity
  // immediately before the rename to shrink that window to near zero.
  try {
    const current = await stat(lockPath);
    if (inspected.info && (current.ino !== inspected.info.ino
      || current.mtimeMs !== inspected.info.mtimeMs
      || current.size !== inspected.info.size)) return;
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
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
  // A different (fresh) lock was vacated. Restore it with a no-clobber link:
  // a plain rename could overwrite a third lock acquired in the meantime and
  // leave two processes inside the critical section.
  try {
    await link(reclaimPath, lockPath);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      await rename(reclaimPath, lockPath).catch(() => {});
      return;
    }
  }
  await unlink(reclaimPath).catch(() => {});
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function checksum(entry) {
  const protectedFields = {
    journalVersion: entry.journalVersion,
    sequence: entry.sequence,
    recordedAt: entry.recordedAt,
    payload: entry.payload
  };
  if (entry.journalVersion >= 2) protectedFields.previousChecksum = entry.previousChecksum ?? null;
  return createHash('sha256').update(JSON.stringify(stableValue(protectedFields))).digest('hex');
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
    let previousChecksum = null;
    let tornTail = false;
    const lines = raw.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); }
      catch {
        const hasLaterRecord = lines.slice(index + 1).some((candidate) => candidate.trim());
        if (hasLaterRecord) throw new Error(`Lifecycle journal contains mid-journal invalid JSON at line ${index + 1}`);
        tornTail = true;
        continue;
      }
      const expectedSequence = count + 1;
      if (![1, 2].includes(entry?.journalVersion) || !Object.hasOwn(entry, 'payload')) {
        count += 1;
        previousChecksum = null;
        continue;
      }
      if (entry.sequence !== expectedSequence) throw new Error(`Lifecycle journal sequence mismatch at line ${index + 1}`);
      if (entry.journalVersion >= 2 && (entry.previousChecksum ?? null) !== (previousChecksum ?? null)) {
        throw new Error(`Lifecycle journal previous checksum mismatch at line ${index + 1}`);
      }
      if (entry.checksum !== checksum(entry)) throw new Error(`Lifecycle journal checksum mismatch at line ${index + 1}`);
      count += 1;
      previousChecksum = entry.checksum;
    }
    return { count, previousChecksum, endsWithNewline: !tornTail && (raw.length === 0 || raw.endsWith('\n')), missing: false };
  } catch (error) {
    if (error.code === 'ENOENT') return { count: 0, previousChecksum: null, endsWithNewline: true, missing: true };
    throw error;
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error.code)) throw error;
  } finally {
    await handle?.close();
  }
}

export async function appendJournalRecord(filePath, payload) {
  const release = await acquire(`${filePath}.lock`);
  try {
    const journal = await readJournalState(filePath);
    const entry = {
      journalVersion: 2,
      sequence: journal.count + 1,
      recordedAt: new Date().toISOString(),
      previousChecksum: journal.previousChecksum ?? null,
      // Hash what verification will parse back from disk: values with toJSON
      // (Date) would otherwise produce permanently checksum-invalid records.
      payload: payload === undefined ? null : JSON.parse(JSON.stringify(payload))
    };
    entry.checksum = checksum(entry);
    await mkdir(path.dirname(filePath), { recursive: true });
    const handle = await open(filePath, 'a', 0o600);
    try {
      await handle.writeFile(`${journal.endsWithNewline ? '' : '\n'}${JSON.stringify(entry)}\n`);
      await handle.sync();
    }
    finally { await handle.close(); }
    if (journal.missing) await syncDirectory(path.dirname(filePath));
    return entry;
  } finally {
    await release();
  }
}
