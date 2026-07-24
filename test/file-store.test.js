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
  readJournal
} from '../src/file-store.js';

test('atomic JSON writes leave one complete file and no temporary residue', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-file-store-'));
  const file = path.join(root, 'nested/state.json');
  await atomicWriteJson(file, { value: 1 });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { value: 1 });
  assert.deepEqual((await readdir(path.dirname(file))).filter((name) => name.includes('.tmp-')), []);
});

test('journal appends are serialized under concurrency and every record survives', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-journal-'));
  const file = path.join(root, 'events.jsonl');
  await Promise.all(Array.from({ length: 20 }, (_, index) => appendJournalRecord(file, { index })));
  const journal = await readJournal(file);
  assert.equal(journal.records.length, 20);
  assert.deepEqual(
    journal.records.map((entry) => entry.index).sort((a, b) => a - b),
    Array.from({ length: 20 }, (_, i) => i)
  );
});

test('journal payloads with toJSON values round-trip as plain JSON', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-journal-date-'));
  const file = path.join(root, 'events.jsonl');
  await appendJournalRecord(file, { startedAt: new Date('2026-01-01T00:00:00Z'), note: 'x' });
  const journal = await readJournal(file);
  assert.equal(journal.records[0].startedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(journal.records[0].note, 'x');
});

test('readJournal reports a corrupt line instead of silently dropping data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-journal-corrupt-'));
  const file = path.join(root, 'events.jsonl');
  await appendJournalRecord(file, { event: 'valid' });
  await appendFile(file, '{"event":"torn"', 'utf8');
  await assert.rejects(() => readJournal(file), /Invalid journal/i);
});

test('stale locks are reclaimed so a crashed writer cannot deadlock the store', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-lock-repair-'));
  const lockPath = path.join(root, 'events.jsonl.lock');
  await mkdir(root, { recursive: true });
  await writeFile(lockPath, JSON.stringify({ pid: 999999, createdAt: '2000-01-01T00:00:00Z' }));
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);

  const release = await acquireFileLock(lockPath, { staleMs: 10, timeoutMs: 500 });
  await release();
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
  await stat(lockPath);
});

test('a very old lock is reclaimable even when its recorded pid appears alive', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-lock-hard-stale-'));
  const lockPath = path.join(root, 'state.json.lock');
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: '2000-01-01T00:00:00Z' }));
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(lockPath, twoHoursAgo, twoHoursAgo);

  const release = await acquireFileLock(lockPath, { timeoutMs: 2000 });
  await release();
});
