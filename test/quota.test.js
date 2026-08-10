import test from 'node:test';
import assert from 'node:assert/strict';
import { readProviderQuota } from '../src/quota.js';

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

test('readProviderQuota uses the injected runner and honors the remainingField dot path', async () => {
  const provider = {
    id: 'openai',
    usageProbe: { command: 'caut', args: ['usage', '--json'], remainingField: 'a.b.c' }
  };
  const fakeRunner = async () => ({ exitCode: 0, stdout: JSON.stringify({ a: { b: { c: 41 } } }) });
  const quota = await readProviderQuota(provider, { runCommandImpl: fakeRunner });
  assert.deepEqual(quota, { provider: 'openai', remainingPercent: 41 });
});
