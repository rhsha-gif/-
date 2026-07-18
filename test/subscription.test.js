import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAccessProfile,
  inspectSubscriptionEnvironment,
  sanitizeSubscriptionWorkerEnv,
  resolveUsagePool,
  inspectHostSurface,
  validateUsageRecord,
  planLimitResponse,
  validateSurfaces,
  USAGE_POOL_STATES
} from '../src/subscription.js';

// --- access profile ---

test('missing access config defaults to subscription-local with every escape hatch closed', () => {
  const access = validateAccessProfile(undefined);
  assert.equal(access.profile, 'subscription-local');
  assert.equal(access.localOnly, true);
  assert.equal(access.allowDirectApi, false);
  assert.equal(access.allowApiFallback, false);
  assert.equal(access.allowCloudDelegation, false);
  assert.equal(access.allowPaidCredits, false);
  assert.equal(access.overflowPolicy, 'reroute-or-wait');
});

test('subscription-local rejects any API/cloud/credit enablement', () => {
  for (const field of ['allowDirectApi', 'allowApiFallback', 'allowCloudDelegation', 'allowPaidCredits']) {
    assert.throws(
      () => validateAccessProfile({ profile: 'subscription-local', [field]: true }),
      new RegExp(field)
    );
  }
});

test('explicit-api access profile fails closed in v0.7.0', () => {
  assert.throws(() => validateAccessProfile({ profile: 'explicit-api' }), /not implemented|explicit-api/i);
});

test('unknown profile names and overflow policies are rejected', () => {
  assert.throws(() => validateAccessProfile({ profile: 'api-first' }), /profile/i);
  assert.throws(
    () => validateAccessProfile({ profile: 'subscription-local', overflowPolicy: 'api-fallback' }),
    /overflowPolicy/i
  );
});

// --- credential conflict inspection ---

test('Claude worker inspection blocks API and cloud-provider credentials', () => {
  for (const name of [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'
  ]) {
    const inspection = inspectSubscriptionEnvironment({ env: { PATH: '/bin', [name]: 'x' }, provider: 'anthropic' });
    assert.equal(inspection.status, 'blocked', `${name} must block subscription execution`);
    assert.ok(inspection.conflicts.some((conflict) => conflict.name === name));
  }
});

test('CLAUDE_CODE_OAUTH_TOKEN and apiKeyHelper require an explicit policy decision', () => {
  const oauthToken = inspectSubscriptionEnvironment({
    env: { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
    provider: 'anthropic'
  });
  assert.equal(oauthToken.status, 'policy-required');

  const helper = inspectSubscriptionEnvironment({
    env: { PATH: '/bin' },
    provider: 'anthropic',
    settings: { apiKeyHelper: '/usr/local/bin/get-key.sh' }
  });
  assert.equal(helper.status, 'policy-required');

  const approved = inspectSubscriptionEnvironment({
    env: { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
    provider: 'anthropic',
    policy: { allowAutomationCredential: true }
  });
  assert.equal(approved.status, 'pass');
});

test('Codex worker inspection blocks API keys and custom endpoints', () => {
  for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'AZURE_OPENAI_API_KEY']) {
    const inspection = inspectSubscriptionEnvironment({ env: { PATH: '/bin', [name]: 'x' }, provider: 'openai' });
    assert.equal(inspection.status, 'blocked', `${name} must block subscription execution`);
  }
});

test('clean environments pass inspection for both providers', () => {
  for (const provider of ['anthropic', 'openai']) {
    const inspection = inspectSubscriptionEnvironment({ env: { PATH: '/bin', HOME: '/home/u' }, provider });
    assert.equal(inspection.status, 'pass');
    assert.deepEqual(inspection.conflicts, []);
  }
});

// --- worker environment sanitization ---

test('sanitized worker env keeps documented locals and drops credentials and unrelated secrets', () => {
  const env = {
    PATH: '/usr/bin', HOME: '/home/u', TMPDIR: '/tmp', LANG: 'ko_KR.UTF-8', TERM: 'xterm',
    LC_ALL: 'ko_KR.UTF-8', USERPROFILE: 'C:/Users/u', TEMP: 'C:/Temp',
    CLAUDE_CONFIG_DIR: '/home/u/.claude',
    ANTHROPIC_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_BASE_URL: 'https://proxy',
    CLAUDE_CODE_USE_BEDROCK: '1', OPENAI_API_KEY: 'secret',
    AWS_SECRET_ACCESS_KEY: 'secret', GITHUB_TOKEN: 'secret', DATABASE_URL: 'postgres://x',
    RANDOM_APP_SETTING: 'value'
  };
  const sanitized = sanitizeSubscriptionWorkerEnv({ env, provider: 'anthropic' });
  for (const kept of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'USERPROFILE', 'TEMP', 'CLAUDE_CONFIG_DIR']) {
    assert.equal(sanitized[kept], env[kept], `${kept} must survive sanitization`);
  }
  for (const dropped of [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK',
    'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'DATABASE_URL', 'RANDOM_APP_SETTING'
  ]) {
    assert.ok(!(dropped in sanitized), `${dropped} must be removed`);
  }
});

test('deny-listed variables cannot be re-admitted through extra allow entries', () => {
  const sanitized = sanitizeSubscriptionWorkerEnv({
    env: { PATH: '/bin', ANTHROPIC_API_KEY: 'secret' },
    provider: 'anthropic',
    extraAllow: ['ANTHROPIC_API_KEY']
  });
  assert.ok(!('ANTHROPIC_API_KEY' in sanitized));
});

// --- usage pools ---

test('claude transports share one anthropic-subscription pool; codex-cli maps to openai-agentic', () => {
  assert.equal(resolveUsagePool('anthropic', 'claude-print'), 'anthropic-subscription');
  assert.equal(resolveUsagePool('anthropic', 'claude-native-subagent'), 'anthropic-subscription');
  assert.equal(resolveUsagePool('anthropic', 'interactive'), 'anthropic-subscription');
  assert.equal(resolveUsagePool('openai', 'codex-cli'), 'openai-agentic');
  assert.throws(() => resolveUsagePool('openai', 'codex-cloud'), /codex-cloud|transport/i);
  assert.throws(() => resolveUsagePool('someone', 'api'), /provider|transport/i);
});

test('usage records require a known state, source, and timestamp', () => {
  const record = validateUsageRecord({
    pool: 'anthropic-subscription', state: 'yellow', source: 'user', at: '2026-07-18T02:00:00Z'
  });
  assert.equal(record.state, 'yellow');
  assert.deepEqual(USAGE_POOL_STATES, ['unknown', 'green', 'yellow', 'red', 'exhausted']);

  assert.throws(() => validateUsageRecord({ pool: 'anthropic-subscription', state: '42%', source: 'user', at: '2026-07-18T02:00:00Z' }), /state/i);
  assert.throws(() => validateUsageRecord({ pool: 'anthropic-subscription', state: 'green', source: 'guess', at: '2026-07-18T02:00:00Z' }), /source/i);
  assert.throws(() => validateUsageRecord({ pool: 'anthropic-subscription', state: 'green', source: 'user' }), /at|timestamp/i);
  assert.throws(() => validateUsageRecord({ pool: 'mystery-pool', state: 'green', source: 'user', at: '2026-07-18T02:00:00Z' }), /pool/i);
});

test('provider snapshots older than 60 minutes are not accepted as fresh state', () => {
  assert.throws(() => validateUsageRecord({
    pool: 'openai-agentic', state: 'green', source: 'provider-snapshot',
    at: '2026-07-18T02:00:00Z', ageMinutes: 61
  }), /snapshot|age/i);
  const fresh = validateUsageRecord({
    pool: 'openai-agentic', state: 'green', source: 'provider-snapshot',
    at: '2026-07-18T02:00:00Z', ageMinutes: 30
  });
  assert.equal(fresh.state, 'green');
});

test('invented numeric remaining percentages are rejected', () => {
  assert.throws(() => validateUsageRecord({
    pool: 'anthropic-subscription', state: 'green', source: 'user',
    at: '2026-07-18T02:00:00Z', percentRemaining: 37
  }), /percent/i);
});

// --- limit handling ---

test('exhausted pool reroutes only to an eligible subscription provider or blocks', () => {
  const reroute = planLimitResponse({
    exhaustedPool: 'openai-agentic',
    candidates: [
      { provider: 'openai', transport: 'codex-cli', pool: 'openai-agentic', meetsQualityFloor: true },
      { provider: 'anthropic', transport: 'claude-print', pool: 'anthropic-subscription', meetsQualityFloor: true }
    ],
    pools: { 'openai-agentic': 'exhausted', 'anthropic-subscription': 'green' }
  });
  assert.equal(reroute.action, 'reroute');
  assert.equal(reroute.candidate.provider, 'anthropic');

  const blocked = planLimitResponse({
    exhaustedPool: 'openai-agentic',
    candidates: [
      { provider: 'anthropic', transport: 'claude-print', pool: 'anthropic-subscription', meetsQualityFloor: false }
    ],
    pools: { 'openai-agentic': 'exhausted', 'anthropic-subscription': 'green' }
  });
  assert.equal(blocked.action, 'block-or-wait');
});

test('limit response never proposes API, credit, gateway, or cloud transports', () => {
  const result = planLimitResponse({
    exhaustedPool: 'anthropic-subscription',
    candidates: [
      { provider: 'anthropic', transport: 'api', pool: 'api-payg', meetsQualityFloor: true },
      { provider: 'openai', transport: 'codex-cloud', pool: 'openai-agentic', meetsQualityFloor: true }
    ],
    pools: { 'anthropic-subscription': 'exhausted', 'openai-agentic': 'green' }
  });
  assert.equal(result.action, 'block-or-wait');
  assert.ok(result.rejected.every((entry) => ['api', 'codex-cloud'].includes(entry.transport)));
});

// --- host surfaces ---

test('surface config validation fills conservative defaults and rejects api transports', () => {
  const surfaces = validateSurfaces(undefined);
  assert.equal(surfaces.openai.workerTransport, 'codex-cli');
  assert.equal(surfaces.anthropic.crossHostWorkerTransport, 'claude-print');
  assert.equal(resolveUsagePool('openai', surfaces.openai.workerTransport), 'openai-agentic');
  assert.throws(() => validateSurfaces({ openai: { workerTransport: 'api' } }), /transport/i);
});

test('codex-app surface cannot claim strict enforcement without authenticated fixture evidence', () => {
  const unknown = inspectHostSurface({ surface: 'codex-app', evidence: [] });
  assert.equal(unknown.status, 'unknown');

  const advisory = inspectHostSurface({
    surface: 'codex-app',
    evidence: [{ kind: 'official-doc', detail: 'hooks framework documented' }]
  });
  assert.equal(advisory.status, 'advisory');

  const stillNotStrict = inspectHostSurface({
    surface: 'codex-app',
    evidence: [
      { kind: 'official-doc', detail: 'hooks framework documented' },
      { kind: 'claimed-strict', detail: 'someone said so' }
    ]
  });
  assert.notEqual(stillNotStrict.status, 'strict');

  const strict = inspectHostSurface({
    surface: 'codex-app',
    evidence: [
      { kind: 'official-doc', detail: 'hooks framework documented' },
      { kind: 'authenticated-fixture', detail: 'write tool intercepted in signed-in app', verifiedAt: '2026-07-18T00:00:00Z' }
    ]
  });
  assert.equal(strict.status, 'strict');
});

test('claude-code-cli surface requires installed hook evidence for strict', () => {
  const bare = inspectHostSurface({ surface: 'claude-code-cli', evidence: [] });
  assert.equal(bare.status, 'advisory');
  const installed = inspectHostSurface({
    surface: 'claude-code-cli',
    evidence: [{ kind: 'installed-hook-policy', detail: 'PreToolUse policy installed' }]
  });
  assert.equal(installed.status, 'strict');
});
