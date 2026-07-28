import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clearLimits, detectRateLimit, readLimits, setLimit } from '../src/limits.js';

async function stateRoot(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aorch-limits-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('a set limit is visible until its expiry timestamp and then auto-releases', async (t) => {
  const dir = await stateRoot(t);
  const now = new Date('2026-07-28T10:00:00Z');
  await setLimit(dir, 'anthropic', { minutes: 60, source: 'manual', note: 'weekly cap hit', now });

  const active = await readLimits(dir, new Date('2026-07-28T10:30:00Z'));
  assert.ok(active.anthropic);
  assert.equal(active.anthropic.source, 'manual');
  assert.equal(active.anthropic.note, 'weekly cap hit');

  // No daemon: expiry is just a timestamp comparison at read time.
  const later = await readLimits(dir, new Date('2026-07-28T11:01:00Z'));
  assert.deepEqual(later, {});
});

test('clear removes one provider or everything', async (t) => {
  const dir = await stateRoot(t);
  const now = new Date();
  await setLimit(dir, 'anthropic', { minutes: 60, now });
  await setLimit(dir, 'openai', { minutes: 60, now });

  await clearLimits(dir, 'anthropic');
  const afterOne = await readLimits(dir, now);
  assert.deepEqual(Object.keys(afterOne), ['openai']);

  await clearLimits(dir);
  assert.deepEqual(await readLimits(dir, now), {});
});

test('invalid provider or duration is rejected', async (t) => {
  const dir = await stateRoot(t);
  await assert.rejects(setLimit(dir, '', { minutes: 10 }), TypeError);
  await assert.rejects(setLimit(dir, 'anthropic', { minutes: 0 }), RangeError);
});

test('a corrupt limits file reads as empty instead of bricking execution', async (t) => {
  const dir = await stateRoot(t);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'limits.json'), '{corrupt');
  assert.deepEqual(await readLimits(dir), {});
});

test('detectRateLimit matches known provider limit messages and nothing else', () => {
  const positives = [
    'You have reached your usage limit reached for this period',
    'Rate limit exceeded, retry later',
    'rate-limit: too many requests',
    'HTTP 429 Too Many Requests',
    'The model is overloaded, please retry',
    "You've hit your limit for today",
    'Your limit resets at 5:00 PM'
  ];
  for (const message of positives) {
    assert.equal(detectRateLimit({ stderr: message, stdout: '' }), true, message);
  }
  assert.equal(detectRateLimit({ stderr: '', stdout: 'All 134 tests passed' }), false);
  assert.equal(detectRateLimit({ stderr: 'SyntaxError: unexpected token', stdout: '' }), false);
  assert.equal(detectRateLimit(undefined), false);
});
