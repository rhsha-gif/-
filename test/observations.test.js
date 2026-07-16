import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendObservation, readObservations, verdictToQuality } from '../src/observations.js';

test('reviewed outcomes are appended as JSONL performance evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-observations-'));
  const file = path.join(root, 'observations.jsonl');
  await appendObservation(file, {
    provider: 'openai', profileId: 'codex', model: 'gpt', effort: 'high',
    taskKind: 'implementation', role: 'executor', verdict: 'approved',
    recordedAt: '2026-07-16T00:00:00Z'
  });
  const entries = await readObservations(file);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].quality, 1);
  assert.equal(verdictToQuality('major'), 0.55);
});


test('observation reader accepts legacy JSONL while new writes use checksum envelopes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-observations-legacy-'));
  const file = path.join(root, 'observations.jsonl');
  const legacy = {
    provider: 'anthropic', profileId: 'claude', model: 'model', effort: 'medium',
    taskKind: 'review', role: 'reviewer', quality: 0.85, reviewed: true,
    recordedAt: '2026-07-16T00:00:00Z'
  };
  await writeFile(file, `${JSON.stringify(legacy)}
`);
  await appendObservation(file, {
    provider: 'openai', profileId: 'codex', model: 'gpt', effort: 'high',
    taskKind: 'implementation', role: 'executor', verdict: 'approved',
    recordedAt: '2026-07-16T01:00:00Z'
  });
  const raw = await readFile(file, 'utf8');
  assert.match(raw, /"checksum":/);
  const entries = await readObservations(file);
  assert.equal(entries.length, 2);
});
