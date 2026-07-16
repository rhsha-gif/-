import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
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

async function lockIsAbandoned(lockPath, staleMs) {
  const info = await stat(lockPath);
  let owner = null;
  try { owner = JSON.parse(await readFile(lockPath, 'utf8')); }
  catch { owner = null; }
  return Date.now() - info.mtimeMs > staleMs && !processIsAlive(owner?.pid);
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
        if (await lockIsAbandoned(lockPath, staleMs)) { await unlink(lockPath); continue; }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring lifecycle journal lock: ${lockPath}`);
      await sleep(20);
    }
  }
}

async function countRecords(filePath) {
  try {
    return (await readFile(filePath, 'utf8')).split(/\r?\n/).filter((line) => line.trim()).length;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

export async function appendJournalRecord(filePath, payload) {
  const release = await acquire(`${filePath}.lock`);
  try {
    const entry = {
      journalVersion: 1,
      sequence: await countRecords(filePath) + 1,
      recordedAt: new Date().toISOString(),
      payload
    };
    entry.checksum = checksum(entry);
    await mkdir(path.dirname(filePath), { recursive: true });
    const handle = await open(filePath, 'a', 0o600);
    try { await handle.writeFile(`${JSON.stringify(entry)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    return entry;
  } finally {
    await release();
  }
}
