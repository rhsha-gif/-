import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink
} from 'node:fs/promises';
import path from 'node:path';

const JOURNAL_VERSION = 1;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
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

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function journalChecksum(entry) {
  return createHash('sha256').update(stableJson({
    journalVersion: entry.journalVersion,
    sequence: entry.sequence,
    recordedAt: entry.recordedAt,
    payload: entry.payload
  })).digest('hex');
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

function parseJournalLine(line, lineNumber, expectedSequence) {
  let parsed;
  try { parsed = JSON.parse(line); }
  catch (error) {
    return { issue: { line: lineNumber, type: 'invalid-json', message: error.message } };
  }

  if (parsed?.journalVersion !== JOURNAL_VERSION || !Object.hasOwn(parsed, 'payload')) {
    return {
      entry: {
        journalVersion: 0,
        sequence: expectedSequence,
        recordedAt: parsed?.recordedAt ?? null,
        payload: parsed,
        checksum: null,
        legacy: true,
        rawLine: line
      }
    };
  }

  if (!Number.isInteger(parsed.sequence) || parsed.sequence !== expectedSequence) {
    return { issue: { line: lineNumber, type: 'sequence', message: `Expected sequence ${expectedSequence}, received ${parsed.sequence}` } };
  }
  const expectedChecksum = journalChecksum(parsed);
  if (typeof parsed.checksum !== 'string' || parsed.checksum !== expectedChecksum) {
    return { issue: { line: lineNumber, type: 'checksum', message: 'Journal checksum mismatch' } };
  }
  return { entry: { ...parsed, legacy: false, rawLine: line } };
}

export async function readJournal(filePath, { tolerateCorruption = false } = {}) {
  let raw;
  try { raw = await readFile(filePath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') {
      return { entries: [], records: [], issues: [], endsWithNewline: true, missing: true };
    }
    throw error;
  }

  const entries = [];
  const issues = [];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const result = parseJournalLine(line, index + 1, entries.length + 1);
    if (result.issue) issues.push(result.issue);
    else entries.push(result.entry);
  }
  if (issues.length > 0 && !tolerateCorruption) {
    const first = issues[0];
    throw new Error(`Invalid journal ${filePath} at line ${first.line}: ${first.message}`);
  }
  return {
    entries,
    records: entries.map((entry) => entry.payload),
    issues,
    endsWithNewline: raw.length === 0 || raw.endsWith('\n'),
    missing: false
  };
}

export async function appendJournalRecord(filePath, payload, { recordedAt = new Date().toISOString() } = {}) {
  return withFileLock(`${filePath}.lock`, async () => {
    const journal = await readJournal(filePath);
    const entry = {
      journalVersion: JOURNAL_VERSION,
      sequence: journal.entries.length + 1,
      recordedAt,
      // Checksum verification hashes the payload as parsed back from disk, so
      // hash the JSON round-trip of the payload: a value with toJSON (Date)
      // would otherwise produce a permanently checksum-invalid record.
      payload: payload === undefined ? null : JSON.parse(JSON.stringify(payload))
    };
    entry.checksum = journalChecksum(entry);
    await mkdir(path.dirname(filePath), { recursive: true });
    const handle = await open(filePath, 'a', 0o600);
    try {
      // A torn tail line has no trailing newline; start a fresh line so the
      // new record is not glued onto the corrupt fragment.
      await handle.writeFile(`${journal.endsWithNewline ? '' : '\n'}${JSON.stringify(entry)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The record is durable, but a newly created journal's directory entry is
    // not until the directory itself is synced.
    if (journal.missing) await syncDirectory(path.dirname(filePath));
    return entry;
  });
}

export async function repairJournal(filePath) {
  return withFileLock(`${filePath}.lock`, async () => {
    const journal = await readJournal(filePath, { tolerateCorruption: true });
    if (journal.issues.length === 0) return { filePath, repaired: false, removedLines: 0, records: journal.records.length };
    // A sequence issue means a valid, checksummed record follows damage
    // earlier in the file. Rewriting would silently delete those records, so
    // only torn-tail damage (invalid-json/checksum with no cascade) is
    // repairable automatically.
    if (journal.issues.some((issue) => issue.type === 'sequence')) {
      return {
        filePath,
        repaired: false,
        removedLines: 0,
        records: journal.records.length,
        issues: journal.issues,
        requiresManualIntervention: true,
        reason: 'mid-journal damage precedes valid records; automatic repair would delete them'
      };
    }
    const content = journal.entries.length > 0
      ? `${journal.entries.map((entry) => entry.rawLine).join('\n')}\n`
      : '';
    await atomicWriteText(filePath, content);
    return {
      filePath,
      repaired: true,
      removedLines: journal.issues.length,
      records: journal.records.length,
      issues: journal.issues
    };
  });
}

async function walk(root) {
  const found = [];
  if (!(await exists(root))) return found;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await walk(candidate));
    else found.push(candidate);
  }
  return found;
}

export async function inspectFileStore(root, { repair = false, staleLockMs = 30_000 } = {}) {
  const files = await walk(root);
  const journals = files.filter((file) => file.endsWith('.jsonl'));
  const locks = files.filter((file) => file.endsWith('.lock'));

  let removedStaleLocks = 0;
  const lockReports = [];
  for (const file of locks) {
    let lock;
    try { lock = await inspectLockFile(file, staleLockMs); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (lock.stale && repair) {
      await reclaimStaleLock(file, lock);
      removedStaleLocks += 1;
    }
    lockReports.push({
      file,
      stale: lock.stale,
      ownerPid: lock.ownerPid,
      ownerAlive: lock.ownerAlive,
      ageMs: lock.ageMs,
      removed: lock.stale && repair
    });
  }

  const journalReports = [];
  let repairedJournals = 0;
  for (const file of journals) {
    const before = await readJournal(file, { tolerateCorruption: true });
    if (before.issues.length > 0 && repair) {
      const result = await repairJournal(file);
      repairedJournals += result.repaired ? 1 : 0;
      journalReports.push({ file, issues: before.issues, repaired: result.repaired });
    } else {
      journalReports.push({ file, issues: before.issues, repaired: false });
    }
  }

  const unresolvedJournalIssues = journalReports.filter((report) => report.issues.length > 0 && !report.repaired).length;
  const unresolvedStaleLocks = lockReports.filter((report) => report.stale && !report.removed).length;
  return {
    status: unresolvedJournalIssues === 0 && unresolvedStaleLocks === 0 ? 'pass' : 'fail',
    root: path.resolve(root),
    journalsChecked: journals.length,
    repairedJournals,
    removedStaleLocks,
    journalReports,
    lockReports
  };
}
