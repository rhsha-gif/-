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

test('allowedProfileIds pins a task to the named profile even when another would win on quality', () => {
  const catalog = {
    routing: baseRouting,
    models: [
      model({ id: 'cheap', quality: { implementation: 0.89 }, tokenIndex: 0.2, latencyIndex: 0.2 }),
      model({ id: 'best', quality: { implementation: 0.91 }, tokenIndex: 8, latencyIndex: 8 })
    ]
  };
  assert.equal(selectRoute({ task: { ...task, allowedProfileIds: ['cheap'] }, catalog, observations: [] }).profileId, 'cheap');
  // An empty list is the same as unset: the router keeps choosing by evidence.
  assert.equal(selectRoute({ task: { ...task, allowedProfileIds: [] }, catalog, observations: [] }).profileId, 'best');
  assert.throws(() => selectRoute({ task: { ...task, allowedProfileIds: ['absent'] }, catalog, observations: [] }), /No eligible route/);
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

test('hard constraints excluding every candidate produce a constraint-specific error', () => {
  assert.throws(() => selectRoute({
    task: { ...task, minimumQuality: 0.99 },
    catalog: { routing: baseRouting, models: [model({ id: 'ordinary' })] },
    observations: []
  }), /explicit constraints/i);
});

test('catalog-level default priorities not starting with quality require a task quality floor', () => {
  assert.throws(() => selectRoute({
    task,
    catalog: {
      routing: { ...baseRouting, defaultPriorities: ['tokens', 'quality', 'latency'] },
      models: [model({ id: 'ordinary' })]
    },
    observations: []
  }), /minimumQuality/);
});

test('a critical task whose catalog matches nothing reports generic ineligibility, not maturity', () => {
  assert.throws(() => selectRoute({
    task: { ...task, risk: 'critical', kind: 'nonexistent-kind' },
    catalog: { routing: baseRouting, models: [model({ id: 'only' })] },
    observations: []
  }), /No eligible route/i);
});

test('an effort with taskKinds is only a candidate for matching task kinds', () => {
  const catalog = {
    routing: baseRouting,
    models: [
      model({
        id: 'deep',
        taskKinds: ['implementation', 'documentation'],
        quality: { default: 0.8, implementation: 0.8, documentation: 0.8 },
        efforts: [
          { name: 'medium', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1 },
          { name: 'ultra', qualityDelta: 0.1, tokenMultiplier: 4, latencyMultiplier: 1.6, taskKinds: ['implementation'] }
        ]
      })
    ]
  };
  const wide = selectRoute({ task, catalog, observations: [] });
  assert.equal(wide.effort, 'ultra');

  const narrow = selectRoute({ task: { ...task, kind: 'documentation' }, catalog, observations: [] });
  assert.equal(narrow.effort, 'medium');
});

const allocationCatalog = () => ({
  routing: baseRouting,
  models: [
    model({ id: 'cheap', tokenIndex: 0.3, quality: { default: 0.8 } }),
    model({ id: 'grunt', tokenIndex: 0.6, quality: { default: 0.85 }, efforts: [
      { name: 'medium', qualityDelta: 0, tokenMultiplier: 1, latencyMultiplier: 1 },
      { name: 'high', qualityDelta: 0, tokenMultiplier: 1.2, latencyMultiplier: 1.2 }
    ] }),
    model({ id: 'deep', tokenIndex: 2, quality: { default: 0.93 }, maturity: 'challenger' })
  ]
});
const rule = (prefer, match = { kinds: ['implementation'] }) => ({ version: 1, rules: [{ id: 'r1', match, prefer }] });

test('an allocation rule picks the first preferred candidate that survives, and explains every loser', () => {
  const catalog = { ...allocationCatalog(), allocation: rule(['ghost:high', 'grunt:high', 'cheap']) };
  const route = selectRoute({ task, catalog, observations: [] });
  assert.equal(route.profileId, 'grunt');
  assert.equal(route.effort, 'high');
  assert.deepEqual(route.decision.allocation, { ruleId: 'r1', preferred: 'grunt:high' });
  const byKey = Object.fromEntries(route.decision.candidates.map((c) => [`${c.profileId}:${c.effort}`, c]));
  assert.equal(byKey['grunt:high'].status, 'selected');
  assert.equal(byKey['deep:medium'].excludedBy, 'allocation:r1');
  // Without the rule, quality-first routing keeps the higher prior.
  assert.equal(selectRoute({ task, catalog: allocationCatalog(), observations: [] }).profileId, 'deep');
});

test('an allocation rule cannot resurrect a candidate a safety filter excluded', () => {
  const cases = [
    { constrained: { ...task, minimumQuality: 0.9 }, preferred: 'cheap', reason: 'explicit-constraint' },
    { constrained: { ...task, allowedProfileIds: ['cheap'] }, preferred: 'deep', reason: 'allowed-profiles' },
    { constrained: { ...task, risk: 'critical', complexity: 'high' }, preferred: 'deep', reason: 'critical-challenger' }
  ];
  for (const { constrained, preferred, reason } of cases) {
    const route = selectRoute({ task: constrained, catalog: { ...allocationCatalog(), allocation: rule([preferred]) }, observations: [] });
    assert.notEqual(route.profileId, preferred, reason);
    assert.equal(route.decision.allocation, null, reason);
    assert.ok(route.decision.candidates.some((c) => c.profileId === preferred && c.excludedBy === reason), reason);
  }
});

test('a rule that matches nothing leaves the decision unchanged', () => {
  const plain = selectRoute({ task, catalog: allocationCatalog(), observations: [] });
  const ruled = selectRoute({ task, catalog: { ...allocationCatalog(), allocation: rule(['cheap'], { kinds: ['testing'] }) }, observations: [] });
  assert.equal(ruled.profileId, plain.profileId);
  assert.equal(ruled.decision.allocation, null);
});

test('an empty candidate set names each required capability\'s binding state per provider', () => {
  const catalog = {
    routing: baseRouting,
    providers: [
      { id: 'anthropic', adapter: 'claude', enabled: true },
      { id: 'openai', adapter: 'codex', enabled: true }
    ],
    capabilities: [
      {
        id: 'colab-operator', type: 'skill', enabled: true, providers: ['anthropic', 'openai'],
        bindings: { anthropic: { syncStatus: 'stale' }, openai: { syncStatus: 'not-installed' } }
      }
    ],
    models: [
      model({ id: 'claude-general', provider: 'anthropic' }),
      model({ id: 'codex-general', provider: 'openai' })
    ]
  };

  assert.throws(
    () => selectRoute({ task: { ...task, capabilityIds: ['colab-operator'] }, catalog, observations: [] }),
    /No eligible route[\s\S]*Capability state: colab-operator: anthropic=stale, openai=not-installed; run aorch update --user/
  );
  assert.throws(
    () => selectRoute({ task: { ...task, capabilityIds: ['missing-skill'] }, catalog, observations: [] }),
    /missing-skill: unknown \(not in the inventory\)/
  );
});
