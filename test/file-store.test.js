import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import {
  acquireFileLock,
  appendJournalRecord,
  atomicWriteJson,
  inspectFileStore,
  readJournal,
  repairJournal
} from '../src/file-store.js';

test('atomic JSON writes leave one complete file and no temporary residue', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-file-store-'));
  const file = path.join(root, 'nested/state.json');
  await atomicWriteJson(file, { value: 1 });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { value: 1 });
  assert.deepEqual((await readdir(path.dirname(file))).filter((name) => name.includes('.tmp-')), []);
});

test('journal appends are serialized, checksummed, and ordered under concurrency', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-journal-'));
  const file = path.join(root, 'events.jsonl');
  await Promise.all(Array.from({ length: 20 }, (_, index) => appendJournalRecord(file, { index })));
  const journal = await readJournal(file);
  assert.equal(journal.issues.length, 0);
  assert.equal(journal.records.length, 20);
  assert.deepEqual(journal.entries.map((entry) => entry.sequence), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.deepEqual(journal.records.map((entry) => entry.index).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
});

test('journal repair removes a partial tail while preserving valid records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-journal-repair-'));
  const file = path.join(root, 'events.jsonl');
  await appendJournalRecord(file, { event: 'valid' });
  await appendFile(file, '{"journalVersion":1,"sequence":2', 'utf8');

  const before = await readJournal(file, { tolerateCorruption: true });
  assert.equal(before.records.length, 1);
  assert.equal(before.issues.length, 1);

  const repaired = await repairJournal(file);
  assert.equal(repaired.removedLines, 1);
  const after = await readJournal(file);
  assert.equal(after.issues.length, 0);
  assert.deepEqual(after.records, [{ event: 'valid' }]);
});

test('repair refuses to delete valid records that follow mid-journal damage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-journal-midfile-'));
  const file = path.join(root, 'events.jsonl');
  for (let index = 0; index < 3; index += 1) await appendJournalRecord(file, { index });

  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  lines[1] = lines[1].slice(0, 20);
  await writeFile(file, `${lines.join('\n')}\n`);

  const repaired = await repairJournal(file);
  assert.equal(repaired.repaired, false);
  assert.equal(repaired.requiresManualIntervention, true);
  const after = await readJournal(file, { tolerateCorruption: true });
  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 3);
  assert.ok(after.issues.length > 0);
});

test('journal payloads with toJSON values round-trip without checksum corruption', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-journal-date-'));
  const file = path.join(root, 'events.jsonl');
  await appendJournalRecord(file, { startedAt: new Date('2026-01-01T00:00:00Z'), note: 'x' });
  const journal = await readJournal(file);
  assert.equal(journal.issues.length, 0);
  assert.equal(journal.records[0].startedAt, '2026-01-01T00:00:00.000Z');
});

test('hook journal appends survive a torn tail line and stay sequence-valid after repair', async () => {
  const { appendJournalRecord: hookAppend } = await import('../integrations/shared/journal.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-journal-torn-'));
  const file = path.join(root, 'events.jsonl');
  await appendJournalRecord(file, { event: 'valid' });
  await appendFile(file, '{"journalVersion":1,"sequence":2', 'utf8');

  const appended = await hookAppend(file, { event: 'after-torn-tail' });
  assert.equal(appended.sequence, 2);

  const tolerant = await readJournal(file, { tolerateCorruption: true });
  assert.deepEqual(tolerant.records, [{ event: 'valid' }, { event: 'after-torn-tail' }]);
  assert.equal(tolerant.issues.length, 1);

  await repairJournal(file);
  const after = await readJournal(file);
  assert.equal(after.issues.length, 0);
  assert.deepEqual(after.records, [{ event: 'valid' }, { event: 'after-torn-tail' }]);
});

test('stale locks are reclaimed and state inspection reports repairable damage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-lock-repair-'));
  const journal = path.join(root, 'events.jsonl');
  await mkdir(path.dirname(journal), { recursive: true });
  await writeFile(journal, '{broken\n');
  const lockPath = `${journal}.lock`;
  await writeFile(lockPath, JSON.stringify({ pid: 999999, createdAt: '2000-01-01T00:00:00Z' }));
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);

  const release = await acquireFileLock(lockPath, { staleMs: 10, timeoutMs: 500 });
  await release();

  await writeFile(lockPath, '{}');
  await utimes(lockPath, old, old);
  const report = await inspectFileStore(root, { repair: true, staleLockMs: 10 });
  assert.equal(report.status, 'pass');
  assert.equal(report.repairedJournals, 1);
  assert.equal(report.removedStaleLocks, 1);
  await assert.rejects(() => stat(lockPath), /ENOENT/);
});

test('an old lock owned by a live process is not reclaimed as stale', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-live-lock-'));
  const lockPath = path.join(root, 'active.lock');
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: '2000-01-01T00:00:00Z' }));
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);

  await assert.rejects(
    () => acquireFileLock(lockPath, { staleMs: 1, retryMs: 5, timeoutMs: 30 }),
    /Timed out acquiring file lock/i
  );
  const report = await inspectFileStore(root, { repair: true, staleLockMs: 1 });
  assert.equal(report.status, 'pass');
  assert.equal(report.removedStaleLocks, 0);
  assert.equal(report.lockReports[0].ownerAlive, true);
  await stat(lockPath);
});
