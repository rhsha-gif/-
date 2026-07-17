import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertPromptProfileFresh,
  DEFAULT_PROMPT_PROFILES_DIR,
  loadPromptProfiles,
  resolvePromptProfile,
  validatePromptProfile
} from '../src/prompt-profiles.js';

test('packaged prompt profiles are active, model-aware, and cite official provider documentation only', async () => {
  const profiles = await loadPromptProfiles(DEFAULT_PROMPT_PROFILES_DIR);
  assert.ok(profiles.length >= 6);
  for (const profile of profiles) {
    assert.equal(profile.status, 'active');
    assert.ok(profile.modelFamilies.length >= 1);
    assert.ok(profile.officialSources.length >= 1);
    for (const source of profile.officialSources) {
      const host = new URL(source.url).hostname;
      assert.ok(['platform.claude.com', 'code.claude.com', 'developers.openai.com', 'platform.openai.com', 'cookbook.openai.com'].includes(host), host);
      assert.match(source.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
});

test('profile resolution follows the selected model profile and rejects provider mismatches', async () => {
  const profiles = await loadPromptProfiles(DEFAULT_PROMPT_PROFILES_DIR);
  const terra = resolvePromptProfile({
    route: { provider: 'openai', model: 'gpt-5.6-terra', profileId: 'codex-terra-general' },
    modelProfile: { promptProfileIds: ['openai-codex-terra-v1'] },
    profiles
  });
  assert.equal(terra.id, 'openai-codex-terra-v1');
  assert.equal(terra.strategy, 'sections');

  assert.throws(() => resolvePromptProfile({
    route: { provider: 'anthropic', model: 'sonnet', profileId: 'claude-sonnet-general' },
    modelProfile: { promptProfileIds: ['openai-codex-terra-v1'] },
    profiles
  }), /provider mismatch|no compatible prompt profile/i);
});

test('non-official or stale-shaped prompt profiles fail closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aorch-prompt-profiles-'));
  await mkdir(path.join(root, 'bad'), { recursive: true });
  await writeFile(path.join(root, 'bad', 'profile.json'), JSON.stringify({
    version: 1,
    id: 'bad-profile',
    provider: 'openai',
    modelFamilies: ['gpt-5.6-terra'],
    roles: ['executor'],
    taskKinds: ['implementation'],
    strategy: 'sections',
    status: 'active',
    verifiedAt: '2026-07-17',
    officialSources: [{ publisher: 'Someone', document: 'Blog', url: 'https://example.com/prompting', verifiedAt: '2026-07-17' }],
    rules: { requiredSections: ['objective'] }
  }));
  await assert.rejects(() => loadPromptProfiles(root), /official source|official .*provider domain/i);

  assert.throws(() => validatePromptProfile({ id: 'incomplete' }), /version|provider|modelFamilies/i);
});

test('official sources are bound to the profile provider rather than a shared domain pool', async () => {
  const profiles = await loadPromptProfiles(DEFAULT_PROMPT_PROFILES_DIR);
  const openai = structuredClone(profiles.find((entry) => entry.provider === 'openai'));
  openai.officialSources[0] = {
    publisher: 'Anthropic', document: 'Claude Code subagents',
    url: 'https://code.claude.com/docs/en/subagents', verifiedAt: '2026-07-17'
  };
  assert.throws(() => validatePromptProfile(openai), /provider.*official|official.*provider|openai/i);

  const anthropic = structuredClone(profiles.find((entry) => entry.provider === 'anthropic'));
  anthropic.officialSources[0] = {
    publisher: 'OpenAI', document: 'Models',
    url: 'https://developers.openai.com/api/docs/models', verifiedAt: '2026-07-17'
  };
  assert.throws(() => validatePromptProfile(anthropic), /provider.*official|official.*provider|anthropic/i);
});

test('prompt profiles fail closed when official guidance is stale or future dated', async () => {
  const profiles = await loadPromptProfiles(DEFAULT_PROMPT_PROFILES_DIR);
  const profile = profiles.find((entry) => entry.id === 'openai-codex-terra-v1');
  const fresh = assertPromptProfileFresh(profile, {
    now: new Date('2026-07-17T12:00:00Z'), maxAgeDays: 120, maxFutureSkewDays: 1
  });
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.ageDays, 0);

  assert.throws(() => assertPromptProfileFresh(profile, {
    now: new Date('2027-01-20T00:00:00Z'), maxAgeDays: 120, maxFutureSkewDays: 1
  }), /stale|age/i);

  assert.throws(() => assertPromptProfileFresh(profile, {
    now: new Date('2026-07-15T00:00:00Z'), maxAgeDays: 120, maxFutureSkewDays: 1
  }), /future/i);
});

test('profile resolution skips stale compatible fallbacks when a fresh official profile exists', async () => {
  const profiles = await loadPromptProfiles(DEFAULT_PROMPT_PROFILES_DIR);
  const fresh = structuredClone(profiles.find((entry) => entry.id === 'openai-codex-terra-v1'));
  fresh.id = 'openai-codex-terra-fresh';
  fresh.verifiedAt = '2026-07-17';
  fresh.officialSources = fresh.officialSources.map((source) => ({ ...source, verifiedAt: '2026-07-17' }));
  const stale = structuredClone(fresh);
  stale.id = 'openai-codex-terra-stale';
  stale.verifiedAt = '2025-01-01';
  stale.officialSources = stale.officialSources.map((source) => ({ ...source, verifiedAt: '2025-01-01' }));

  const resolved = resolvePromptProfile({
    route: { provider: 'openai', model: 'gpt-5.6-terra' },
    modelProfile: {}, profiles: [stale, fresh],
    now: new Date('2026-07-17T12:00:00Z'),
    policy: { maxProfileAgeDays: 120, maxFutureSkewDays: 1 }
  });
  assert.equal(resolved.id, 'openai-codex-terra-fresh');
});

test('prompt profile health reports stale guidance before worker execution', async () => {
  const { inspectPromptProfileHealth } = await import('../src/prompt-profiles.js');
  const profiles = await loadPromptProfiles(DEFAULT_PROMPT_PROFILES_DIR);
  const healthy = inspectPromptProfileHealth(profiles, {
    now: new Date('2026-07-17T12:00:00Z'), policy: { maxProfileAgeDays: 120, maxFutureSkewDays: 1 }
  });
  assert.equal(healthy.status, 'pass');
  assert.ok(healthy.profiles.every((entry) => entry.status === 'pass'));

  const stale = structuredClone(profiles[0]);
  stale.verifiedAt = '2025-01-01';
  stale.officialSources = stale.officialSources.map((source) => ({ ...source, verifiedAt: '2025-01-01' }));
  const unhealthy = inspectPromptProfileHealth([stale], {
    now: new Date('2026-07-17T12:00:00Z'), policy: { maxProfileAgeDays: 120, maxFutureSkewDays: 1 }
  });
  assert.equal(unhealthy.status, 'fail');
  assert.match(unhealthy.profiles[0].reason, /stale/i);
});
