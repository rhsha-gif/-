import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadUsagePools, recordUsage, loadModelAvailability, recordModelAvailability } from '../src/usage-store.js';
import { inspectModels, probeModelLive } from '../src/models.js';

test('usage pools default to unknown and persist validated user records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-usage-'));
  const initial = await loadUsagePools({ root });
  assert.equal(initial.pools['openai-agentic'].state, 'unknown');
  assert.equal(initial.pools['anthropic-subscription'].state, 'unknown');

  await recordUsage({ root, pool: 'anthropic-subscription', state: 'yellow', source: 'user' });
  const updated = await loadUsagePools({ root });
  assert.equal(updated.pools['anthropic-subscription'].state, 'yellow');
  assert.equal(updated.pools['anthropic-subscription'].source, 'user');
  assert.ok(updated.pools['anthropic-subscription'].at);

  await assert.rejects(
    () => recordUsage({ root, pool: 'anthropic-subscription', state: '37%', source: 'user' }),
    /state/i
  );
});

test('model availability records require known states and sources', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-avail-'));
  await recordModelAvailability({ root, profileId: 'sonnet-fixture', state: 'available', source: 'live-probe' });
  const records = await loadModelAvailability({ root });
  assert.equal(records['sonnet-fixture'].state, 'available');
  await assert.rejects(
    () => recordModelAvailability({ root, profileId: 'sonnet-fixture', state: 'probably-fine', source: 'live-probe' }),
    /state/i
  );
  await assert.rejects(
    () => recordModelAvailability({ root, profileId: 'sonnet-fixture', state: 'available', source: 'vibes' }),
    /source/i
  );
});

function probeConfig(executable) {
  return {
    access: { profile: 'subscription-local', allowAutomationCredential: false },
    providers: [{ id: 'anthropic', adapter: 'claude', enabled: true, executable }],
    models: [{
      id: 'sonnet-fixture', provider: 'anthropic', model: 'sonnet', enabled: true,
      roles: ['executor'], taskKinds: ['testing'], quality: { default: 0.9 },
      tokenIndex: 1, latencyIndex: 1, maturity: 'stable',
      efforts: [{ name: 'medium', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1 }]
    }]
  };
}

test('models inspect performs no model call and reports unknown availability', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-inspect-'));
  const report = await inspectModels({ config: probeConfig('/definitely/not/a/cli'), root });
  assert.equal(report.models[0].availability.state, 'unknown');
  assert.match(report.note, /probe|evidence/i);
});

test('live probe requires explicit confirmation and records probe-backed availability', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-probe-'));
  const fake = path.join(root, 'fake-claude');
  await writeFile(fake, '#!/bin/sh\necho ok\n');
  await chmod(fake, 0o755);
  const config = probeConfig(fake);
  const cleanEnv = { PATH: process.env.PATH, HOME: process.env.HOME };

  await assert.rejects(
    () => probeModelLive({ config, root, profileId: 'sonnet-fixture', env: cleanEnv }),
    /confirmation|allowance/i
  );

  const { record } = await probeModelLive({ config, root, profileId: 'sonnet-fixture', env: cleanEnv, confirmed: true });
  assert.equal(record.state, 'available');
  assert.equal(record.source, 'live-probe');
  assert.equal((await loadModelAvailability({ root }))['sonnet-fixture'].state, 'available');
});

test('live probe is blocked when API credentials are present', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-probe-blocked-'));
  await assert.rejects(() => probeModelLive({
    config: probeConfig('/bin/true'), root, profileId: 'sonnet-fixture', confirmed: true,
    env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-x' }
  }), /ANTHROPIC_API_KEY/);
});

test('a probe hitting a provider limit records temporarily-limited, not unavailable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-probe-limit-'));
  const fake = path.join(root, 'fake-claude');
  await writeFile(fake, '#!/bin/sh\necho "usage limit reached" >&2\nexit 1\n');
  await chmod(fake, 0o755);
  const { record } = await probeModelLive({
    config: probeConfig(fake), root, profileId: 'sonnet-fixture', confirmed: true,
    env: { PATH: process.env.PATH, HOME: process.env.HOME }
  });
  assert.equal(record.state, 'temporarily-limited');
});
