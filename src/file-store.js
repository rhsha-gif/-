import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink
} from 'node:fs/promises';
import path from 'node:path';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    if (error.code === 'ESRCH') return false;
    return false;
  }
}

const HARD_STALE_LOCK_MS = 60 * 60 * 1000;

async function inspectLockFile(lockPath, staleMs, hardStaleMs = HARD_STALE_LOCK_MS) {
  const info = await stat(lockPath);
  let raw = null;
  let owner = null;
  try {
    raw = await readFile(lockPath, 'utf8');
    owner = JSON.parse(raw);
  } catch {
    owner = null;
  }
  const ownerPid = Number.isInteger(owner?.pid) ? owner.pid : null;
  const ownerAlive = processIsAlive(ownerPid);
  const ageMs = Math.max(0, Date.now() - info.mtimeMs);
  return {
    info,
    raw,
    ownerPid,
    ownerAlive,
    ageMs,
    // The liveness probe can lie: after PID reuse or across reboots the pid
    // may belong to an unrelated process (EPERM reads as alive). Locks here
    // guard millisecond-scale writes, so a very old lock is reclaimable even
    // when its recorded pid still appears alive.
    stale: (ageMs > staleMs && !ownerAlive) || ageMs > hardStaleMs
  };
}

// Reclaim a stale lock without the unlink TOCTOU: unlinking by path could
// delete a fresh lock created by a concurrent reclaimer. Atomically rename the
// entry aside, verify it is still the stale lock we inspected, and only then
// discard it; otherwise restore it.
async function reclaimStaleLock(lockPath, inspected) {
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

export async function atomicWriteText(filePath, text, { mode = 0o600 } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temp, 'wx', mode);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export async function atomicWriteJson(filePath, value, options = {}) {
  await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function acquireFileLock(lockPath, {
  staleMs = 30_000,
  hardStaleMs = HARD_STALE_LOCK_MS,
  retryMs = 20,
  timeoutMs = 5_000
} = {}) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      await handle.sync();
      await handle.close();
      let released = false;
      return async () => {
        if (released) return;
        // Mark released only after the unlink outcome is known so a transient
        // failure (EBUSY/EPERM on some filesystems) can be retried instead of
        // leaking a lock that never goes stale while this process lives.
        try {
          await unlink(lockPath);
          released = true;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          released = true;
        }
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error.code !== 'EEXIST') throw error;
      try {
        const lock = await inspectLockFile(lockPath, staleMs, hardStaleMs);
        if (lock.stale) {
          await reclaimStaleLock(lockPath, lock);
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring file lock: ${lockPath}`);
      await sleep(retryMs);
    }
  }
}

export async function withFileLock(lockPath, callback, options = {}) {
  const release = await acquireFileLock(lockPath, options);
  try { return await callback(); }
  finally { await release(); }
}

// Plain append-only JSONL: one JSON record per line. A personal tool does not
// need checksummed, sequence-numbered journal envelopes; atomic writes plus a
// serializing lock are enough durability.
export async function readJournal(filePath) {
  let raw;
  try { raw = await readFile(filePath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { records: [], endsWithNewline: true, missing: true };
    throw error;
  }
  const records = [];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid journal ${filePath} at line ${index + 1}: ${error.message}`);
    }
  }
  return {
    records,
    endsWithNewline: raw.length === 0 || raw.endsWith('\n'),
    missing: false
  };
}

export async function appendJournalRecord(filePath, payload, { recordedAt = new Date().toISOString() } = {}) {
  return withFileLock(`${filePath}.lock`, async () => {
    const journal = await readJournal(filePath);
    const cloned = payload === undefined ? null : JSON.parse(JSON.stringify(payload));
    const record = cloned && typeof cloned === 'object' && !Array.isArray(cloned)
      ? { recordedAt, ...cloned }
      : { recordedAt, payload: cloned };
    await mkdir(path.dirname(filePath), { recursive: true });
    const handle = await open(filePath, 'a', 0o600);
    try {
      // A torn tail line has no trailing newline; start a fresh line so the
      // new record is not glued onto a partially written fragment.
      await handle.writeFile(`${journal.endsWithNewline ? '' : '\n'}${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The record is durable, but a newly created journal's directory entry is
    // not until the directory itself is synced.
    if (journal.missing) await syncDirectory(path.dirname(filePath));
    return record;
  });
}
