import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readProviderQuota, readAllProviderQuotas } from '../src/quota.js';

// A provider whose usageProbe runs a real node process that prints caut-shaped
// JSON. Exercises the real runCommand spawn + parse path.
function probeProvider(script) {
  return {
    id: 'openai',
    usageProbe: {
      command: process.execPath,
      args: ['-e', script],
      remainingField: 'usage.primary.remainingPercent'
    }
  };
}

test('readProviderQuota parses remainingPercent from the probe JSON', async () => {
  const provider = probeProvider('process.stdout.write(JSON.stringify({usage:{primary:{remainingPercent:73}}}))');
  const quota = await readProviderQuota(provider);
  assert.deepEqual(quota, { provider: 'openai', remainingPercent: 73 });
});

test('readProviderQuota returns null when the provider has no usageProbe', async () => {
  assert.equal(await readProviderQuota({ id: 'anthropic' }), null);
});

test('readProviderQuota fails open (null) when the probe exits non-zero', async () => {
  const provider = probeProvider('process.stderr.write("boom"); process.exit(1)');
  assert.equal(await readProviderQuota(provider), null);
});

test('readProviderQuota fails open (null) when the field is missing or not a number', async () => {
  const missing = probeProvider('process.stdout.write(JSON.stringify({usage:{primary:{}}}))');
  assert.equal(await readProviderQuota(missing), null);
  const notNumber = probeProvider('process.stdout.write(JSON.stringify({usage:{primary:{remainingPercent:"lots"}}}))');
  assert.equal(await readProviderQuota(notNumber), null);
});

test('readProviderQuota treats falsy sentinels as unknown (null), not 0%', async () => {
  // An explicit null / empty / boolean means "no signal" — Number() would
  // coerce these to a misleading 0, so they must fail open to null.
  for (const field of ['null', '""', 'false', '[]']) {
    const provider = probeProvider(`process.stdout.write(JSON.stringify({usage:{primary:{remainingPercent:${field}}}}))`);
    assert.equal(await readProviderQuota(provider), null, `field ${field} should be null, not 0`);
  }
  // A numeric string is still accepted (a probe may stringify the percent).
  const stringy = probeProvider('process.stdout.write(JSON.stringify({usage:{primary:{remainingPercent:"73"}}}))');
  assert.deepEqual(await readProviderQuota(stringy), { provider: 'openai', remainingPercent: 73 });
});

test('readProviderQuota fails open (null) when stdout is not JSON', async () => {
  const provider = probeProvider('process.stdout.write("not json at all")');
  assert.equal(await readProviderQuota(provider), null);
});

// --- readAllProviderQuotas (TTL cache layer) ---

function countingRunner(percentByCall) {
  const calls = [];
  return {
    calls,
    run: async (spec) => {
      calls.push(spec);
      return { exitCode: 0, stdout: JSON.stringify({ remaining: percentByCall(calls.length) }) };
    }
  };
}

function probedProvider(id) {
  return { id, usageProbe: { command: 'probe', args: [], remainingField: 'remaining' } };
}

async function tempStateRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'aorch-quota-'));
}

test('readAllProviderQuotas probes on a cold cache and reuses the cache within the TTL', async () => {
  const stateRoot = await tempStateRoot();
  const runner = countingRunner(() => 73);
  const options = { stateRoot, ttlMs: 60_000, runCommandImpl: runner.run, now: () => 1_000_000 };

  const first = await readAllProviderQuotas([probedProvider('openai')], options);
  assert.deepEqual(first, { openai: 73 });
  assert.equal(runner.calls.length, 1);

  const second = await readAllProviderQuotas([probedProvider('openai')], { ...options, now: () => 1_030_000 });
  assert.deepEqual(second, { openai: 73 });
  assert.equal(runner.calls.length, 1, 'a fresh cache entry must not re-probe');

  const persisted = JSON.parse(await readFile(path.join(stateRoot, 'quota-cache.json'), 'utf8'));
  assert.equal(persisted.openai.remainingPercent, 73);
});

test('readAllProviderQuotas re-probes once the TTL expires, and ttlMs 0 always probes', async () => {
  const stateRoot = await tempStateRoot();
  const runner = countingRunner((call) => (call === 1 ? 73 : 15));
  const options = { stateRoot, ttlMs: 60_000, runCommandImpl: runner.run, now: () => 1_000_000 };

  await readAllProviderQuotas([probedProvider('openai')], options);
  const expired = await readAllProviderQuotas([probedProvider('openai')], { ...options, now: () => 1_070_000 });
  assert.deepEqual(expired, { openai: 15 });
  assert.equal(runner.calls.length, 2);

  await readAllProviderQuotas([probedProvider('openai')], { ...options, ttlMs: 0, now: () => 1_070_001 });
  assert.equal(runner.calls.length, 3, 'ttlMs 0 must bypass the cache');
});

test('readAllProviderQuotas with refresh: false never probes and reports stale entries as null', async () => {
  const stateRoot = await tempStateRoot();
  const runner = countingRunner(() => 73);
  const quota = await readAllProviderQuotas([probedProvider('openai')], {
    stateRoot, ttlMs: 60_000, refresh: false, runCommandImpl: runner.run, now: () => 1_000_000
  });
  assert.deepEqual(quota, { openai: null });
  assert.equal(runner.calls.length, 0);
});

test('readAllProviderQuotas caches a probe failure as null for the TTL window', async () => {
  const stateRoot = await tempStateRoot();
  const calls = [];
  const failingRunner = async (spec) => { calls.push(spec); return { exitCode: 1, stdout: '' }; };
  const options = { stateRoot, ttlMs: 60_000, runCommandImpl: failingRunner, now: () => 1_000_000 };

  const first = await readAllProviderQuotas([probedProvider('openai')], options);
  assert.deepEqual(first, { openai: null });
  const second = await readAllProviderQuotas([probedProvider('openai')], { ...options, now: () => 1_030_000 });
  assert.deepEqual(second, { openai: null });
  assert.equal(calls.length, 1, 'a cached failure must not re-charge the probe cost within the TTL');
});

test('readAllProviderQuotas skips providers without a probe and survives a corrupt cache file', async () => {
  const stateRoot = await tempStateRoot();
  await writeFile(path.join(stateRoot, 'quota-cache.json'), 'not json', 'utf8');
  const runner = countingRunner(() => 41);
  const quota = await readAllProviderQuotas(
    [probedProvider('openai'), { id: 'anthropic' }],
    { stateRoot, ttlMs: 60_000, runCommandImpl: runner.run, now: () => 1_000_000 }
  );
  assert.deepEqual(quota, { openai: 41 });
  assert.equal('anthropic' in quota, false, 'a provider without a probe stays unknown by absence');
});

test('readProviderQuota uses the injected runner and honors the remainingField dot path', async () => {
  const provider = {
    id: 'openai',
    usageProbe: { command: 'caut', args: ['usage', '--json'], remainingField: 'a.b.c' }
  };
  const fakeRunner = async () => ({ exitCode: 0, stdout: JSON.stringify({ a: { b: { c: 41 } } }) });
  const quota = await readProviderQuota(provider, { runCommandImpl: fakeRunner });
  assert.deepEqual(quota, { provider: 'openai', remainingPercent: 41 });
});
