import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRoute } from '../src/router.js';

const baseRouting = {
  qualityTolerance: 0.005,
  tokenTolerance: 0.05,
  observationHalfLifeDays: 30,
  priorWeight: 3,
  uncertaintyPenalty: 0,
  criticalMinimumSamples: 3
};

function model(overrides) {
  return {
    id: overrides.id,
    provider: overrides.provider ?? 'anthropic',
    model: overrides.model ?? overrides.id,
    enabled: true,
    roles: ['executor'],
    taskKinds: ['implementation'],
    quality: { default: 0.8, implementation: 0.8 },
    tokenIndex: 1,
    latencyIndex: 1,
    maturity: 'stable',
    efforts: [{ name: 'medium', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1 }],
    ...overrides
  };
}

const task = {
  id: 'T1',
  kind: 'implementation',
  role: 'executor',
  risk: 'standard',
  tags: []
};

test('higher expected task outcome wins when no task-specific constraint excludes it', () => {
  const route = selectRoute({
    task,
    catalog: {
      routing: baseRouting,
      models: [
        model({ id: 'cheap', quality: { implementation: 0.89 }, tokenIndex: 0.2, latencyIndex: 0.2 }),
        model({ id: 'best', quality: { implementation: 0.91 }, tokenIndex: 8, latencyIndex: 8 })
      ]
    },
    observations: []
  });

  assert.equal(route.profileId, 'best');
});

test('default task routing uses tokens before latency only inside the quality-equivalent tier', () => {
  const route = selectRoute({
    task,
    catalog: {
      routing: { ...baseRouting, qualityTolerance: 0.02 },
      models: [
        model({ id: 'fast-expensive', quality: { implementation: 0.91 }, tokenIndex: 3, latencyIndex: 0.1 }),
        model({ id: 'slow-efficient', quality: { implementation: 0.90 }, tokenIndex: 1, latencyIndex: 5 })
      ]
    },
    observations: []
  });

  assert.equal(route.profileId, 'slow-efficient');
});

test('default task routing uses latency after quality and token equivalence', () => {
  const route = selectRoute({
    task,
    catalog: {
      routing: { ...baseRouting, qualityTolerance: 0.02, tokenTolerance: 0.1 },
      models: [
        model({ id: 'slow', quality: { implementation: 0.90 }, tokenIndex: 1, latencyIndex: 3 }),
        model({ id: 'fast', quality: { implementation: 0.90 }, tokenIndex: 1.02, latencyIndex: 0.5 })
      ]
    },
    observations: []
  });

  assert.equal(route.profileId, 'fast');
});

test('recent reviewed outcomes can reverse stale priors', () => {
  const now = new Date('2026-07-16T00:00:00Z');
  const observations = [
    ...Array.from({ length: 4 }, (_, index) => ({
      provider: 'anthropic', profileId: 'former-best', model: 'former-best', effort: 'medium',
      taskKind: 'implementation', role: 'executor', quality: 0.35,
      recordedAt: new Date(now.getTime() - index * 86400000).toISOString()
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      provider: 'openai', profileId: 'improving', model: 'improving', effort: 'medium',
      taskKind: 'implementation', role: 'executor', quality: 0.98,
      recordedAt: new Date(now.getTime() - index * 86400000).toISOString()
    }))
  ];

  const route = selectRoute({
    task,
    catalog: {
      routing: { ...baseRouting, priorWeight: 1 },
      models: [
        model({ id: 'former-best', quality: { implementation: 0.97 } }),
        model({ id: 'improving', provider: 'openai', quality: { implementation: 0.82 } })
      ]
    },
    observations,
    now
  });

  assert.equal(route.profileId, 'improving');
});

test('an unproven challenger cannot be the sole executor for a critical task', () => {
  const criticalTask = { ...task, risk: 'critical' };
  const route = selectRoute({
    task: criticalTask,
    catalog: {
      routing: baseRouting,
      models: [
        model({ id: 'challenger', maturity: 'challenger', quality: { implementation: 0.99 } }),
        model({ id: 'stable', maturity: 'stable', quality: { implementation: 0.90 } })
      ]
    },
    observations: []
  });

  assert.equal(route.profileId, 'stable');
});

test('required capabilities constrain provider selection before quality comparison', () => {
  const route = selectRoute({
    task: { ...task, capabilityIds: ['claude-only-plugin'] },
    catalog: {
      routing: baseRouting,
      capabilities: [
        { id: 'claude-only-plugin', type: 'plugin', providers: ['anthropic'], enabled: true }
      ],
      models: [
        model({ id: 'openai-higher', provider: 'openai', quality: { implementation: 0.99 } }),
        model({ id: 'claude-compatible', provider: 'anthropic', quality: { implementation: 0.90 } })
      ]
    },
    observations: []
  });
  assert.equal(route.provider, 'anthropic');
});

test('critical routing fails closed when every candidate is an unproven challenger', () => {
  assert.throws(() => selectRoute({
    task: { ...task, risk: 'critical' },
    catalog: {
      routing: baseRouting,
      models: [model({ id: 'only-challenger', maturity: 'challenger', quality: { implementation: 0.99 } })]
    },
    observations: []
  }), /proven route/i);
});

test('route output explains task-fit selection without declaring a universal product objective', () => {
  const route = selectRoute({ task, catalog: { routing: baseRouting, models: [model({ id: 'only' })] }, observations: [] });
  assert.equal(route.decision.policy, 'task-specific-priority-order');
  assert.deepEqual(route.decision.priorities, ['quality', 'tokens', 'latency']);
  assert.equal(route.decision.candidatesConsidered, 1);
  assert.equal('priority' in route.decision, false);
});

test('a task can prioritize latency after declaring an explicit acceptable quality floor', () => {
  const route = selectRoute({
    task: {
      ...task,
      routingPriorities: ['latency', 'quality', 'tokens'],
      minimumQuality: 0.8
    },
    catalog: {
      routing: baseRouting,
      models: [
        model({ id: 'polished-slow', quality: { implementation: 0.94 }, tokenIndex: 1, latencyIndex: 4 }),
        model({ id: 'good-fast', quality: { implementation: 0.84 }, tokenIndex: 1.2, latencyIndex: 0.4 })
      ]
    },
    observations: []
  });
  assert.equal(route.profileId, 'good-fast');
  assert.deepEqual(route.decision.priorities, ['latency', 'quality', 'tokens']);
});

test('task-specific token and latency ceilings exclude otherwise stronger candidates', () => {
  const route = selectRoute({
    task: { ...task, maxTokenIndex: 2, maxLatencyIndex: 2 },
    catalog: {
      routing: baseRouting,
      models: [
        model({ id: 'too-expensive', quality: { implementation: 0.98 }, tokenIndex: 3, latencyIndex: 1 }),
        model({ id: 'within-budget', quality: { implementation: 0.9 }, tokenIndex: 1.5, latencyIndex: 1.5 })
      ]
    },
    observations: []
  });
  assert.equal(route.profileId, 'within-budget');
});

test('router fails closed on unsupported or duplicate priority metrics even without task pre-validation', () => {
  const catalog = { routing: baseRouting, models: [model({ id: 'only' })] };
  assert.throws(() => selectRoute({
    task: { ...task, routingPriorities: ['latency', 'magic'], minimumQuality: 0.7 },
    catalog,
    observations: []
  }), /routing priorities/i);
  assert.throws(() => selectRoute({
    task: { ...task, routingPriorities: ['quality', 'quality'] },
    catalog,
    observations: []
  }), /routing priorities/i);
});

test('task complexity prevents a deep-only model from taking ordinary work on prior alone', () => {
  const route = selectRoute({
    task: { ...task, complexity: 'standard' },
    catalog: {
      routing: baseRouting,
      models: [
        model({
          id: 'general',
          quality: { implementation: 0.90 },
          efforts: [{ name: 'medium', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1, complexities: ['standard'] }]
        }),
        model({
          id: 'deep-only',
          quality: { implementation: 0.99 },
          efforts: [{ name: 'xhigh', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1, complexities: ['high', 'critical'] }]
        })
      ]
    },
    observations: []
  });
  assert.equal(route.profileId, 'general');
});

test('a high-complexity task can route to a deep effort profile', () => {
  const route = selectRoute({
    task: { ...task, complexity: 'high' },
    catalog: {
      routing: baseRouting,
      models: [
        model({
          id: 'general',
          quality: { implementation: 0.90 },
          efforts: [{ name: 'medium', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1, complexities: ['standard'] }]
        }),
        model({
          id: 'deep',
          quality: { implementation: 0.96 },
          efforts: [{ name: 'xhigh', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1, complexities: ['high', 'critical'] }]
        })
      ]
    },
    observations: []
  });
  assert.equal(route.profileId, 'deep');
  assert.equal(route.decision.complexity, 'high');
});

test('critical execution requires a trusted stable provider adapter', () => {
  const critical = { ...task, risk: 'critical', complexity: 'high' };
  const route = selectRoute({
    task: critical,
    catalog: {
      routing: baseRouting,
      controlPlane: {
        providerTrustByRisk: {
          low: ['trusted', 'reviewed', 'untrusted'], standard: ['trusted', 'reviewed'],
          high: ['trusted', 'reviewed'], critical: ['trusted']
        },
        experimentalAdapterMaxRisk: 'standard'
      },
      providers: [
        { id: 'anthropic', trustTier: 'reviewed', adapterMaturity: 'stable' },
        { id: 'openai', trustTier: 'trusted', adapterMaturity: 'stable' }
      ],
      models: [
        model({ id: 'higher-reviewed', provider: 'anthropic', quality: { implementation: 0.99 }, efforts: [{ name: 'high', complexities: ['high'], tokenMultiplier: 1, latencyMultiplier: 1 }] }),
        model({ id: 'trusted', provider: 'openai', quality: { implementation: 0.90 }, efforts: [{ name: 'high', complexities: ['high'], tokenMultiplier: 1, latencyMultiplier: 1 }] })
      ]
    },
    observations: []
  });
  assert.equal(route.provider, 'openai');
  assert.equal(route.providerTrustTier, 'trusted');
});

test('critical executor does not use a challenger even after observations', () => {
  const observations = Array.from({ length: 8 }, (_, index) => ({
    provider: 'openai', profileId: 'challenger', model: 'challenger', effort: 'high',
    taskKind: 'implementation', role: 'executor', quality: 1,
    recordedAt: new Date(Date.now() - index * 1000).toISOString()
  }));
  const route = selectRoute({
    task: { ...task, risk: 'critical', complexity: 'high' },
    catalog: {
      routing: { ...baseRouting, criticalMinimumSamples: 3 },
      providers: [{ id: 'openai', trustTier: 'trusted', adapterMaturity: 'stable' }],
      models: [
        model({ id: 'challenger', provider: 'openai', maturity: 'challenger', quality: { implementation: 0.99 }, efforts: [{ name: 'high', complexities: ['high'], tokenMultiplier: 1, latencyMultiplier: 1 }] }),
        model({ id: 'stable', provider: 'openai', maturity: 'stable', quality: { implementation: 0.8 }, efforts: [{ name: 'high', complexities: ['high'], tokenMultiplier: 1, latencyMultiplier: 1 }] })
      ]
    },
    observations
  });
  assert.equal(route.profileId, 'stable');
});

test('untrusted providers require explicit low-risk read-only opt-in', () => {
  const lowRiskReadOnly = { ...task, risk: 'low', write: false };
  const catalog = {
    routing: baseRouting,
    controlPlane: {
      providerTrustByRisk: {
        low: ['trusted', 'reviewed', 'untrusted'], standard: ['trusted', 'reviewed'],
        high: ['trusted', 'reviewed'], critical: ['trusted']
      },
      experimentalAdapterMaxRisk: 'standard'
    },
    providers: [
      { id: 'trusted-provider', trustTier: 'trusted', adapterMaturity: 'stable' },
      { id: 'untrusted-provider', trustTier: 'untrusted', adapterMaturity: 'stable' }
    ],
    models: [
      model({ id: 'trusted-model', provider: 'trusted-provider', quality: { implementation: 0.8 } }),
      model({ id: 'untrusted-model', provider: 'untrusted-provider', quality: { implementation: 0.99 } })
    ]
  };

  const defaultRoute = selectRoute({ task: lowRiskReadOnly, catalog, observations: [] });
  assert.equal(defaultRoute.provider, 'trusted-provider');

  const optedInRoute = selectRoute({
    task: { ...lowRiskReadOnly, allowUntrustedProviders: true },
    catalog,
    observations: []
  });
  assert.equal(optedInRoute.provider, 'untrusted-provider');

  assert.throws(() => selectRoute({
    task: { ...lowRiskReadOnly, write: true, allowUntrustedProviders: true },
    catalog: { ...catalog, models: [catalog.models[1]] },
    observations: []
  }), /No eligible route/i);
});

test('models of a disabled provider are never routed', () => {
  assert.throws(() => selectRoute({
    task,
    catalog: {
      routing: baseRouting,
      providers: [{ id: 'anthropic', enabled: false, trustTier: 'trusted', adapterMaturity: 'stable' }],
      models: [model({ id: 'orphaned' })]
    },
    observations: []
  }), /no eligible route/i);
});
