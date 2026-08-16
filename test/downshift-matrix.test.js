import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateConfig } from '../src/config.js';
import { classifyDifficulty } from '../src/difficulty.js';
import { validateTask } from '../src/task.js';
import { selectRoute } from '../src/router.js';

// Regression harness for the downshift lever: every advertised target
// (documentation, testing, boilerplate implementation, exploration, research)
// must actually land on the cheapest tier against the REAL packaged catalog,
// and high-complexity kinds must stay on the deep tier. The matrix itself is
// pinned with no observations — that is the cold-start behaviour a fresh install
// gets. The classify command now reads the observation ledger, so the last test
// here covers what happens once evidence exists.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadPackagedCatalog() {
  const raw = JSON.parse(await readFile(path.join(root, 'config/aorch.config.json'), 'utf8'));
  return validateConfig(raw);
}

function routeObjective(catalog, objective, allowedProviders = ['anthropic']) {
  const classification = classifyDifficulty({ objective });
  const task = validateTask({
    id: 'matrix-probe',
    objective,
    role: 'executor',
    risk: 'standard',
    kind: classification.kind,
    complexity: classification.complexity,
    minimumQuality: classification.minimumQuality,
    allowedProviders,
    routingPriorities: classification.routingPriorities
  });
  return { classification, route: selectRoute({ task, catalog, observations: [] }) };
}

const MATRIX = [
  { objective: 'Fix the typo in the README and reformat the comment block', kind: 'documentation', model: 'haiku' },
  { objective: 'Write a regression test for the limits module', kind: 'testing', model: 'haiku' },
  { objective: 'Extract the atomic write helper into a shared module', kind: 'implementation', model: 'haiku' },
  { objective: 'Explore the codebase and map out where routing decisions live', kind: 'exploration', model: 'haiku' },
  { objective: 'Research and compare options for JSON schema validation', kind: 'research', model: 'haiku' },
  { objective: 'Find the root cause of the race condition and debug it', kind: 'debugging', model: 'opus' },
  { objective: 'Design the architecture for the delegation subsystem', kind: 'architecture', model: 'opus' },
  { objective: 'Review the auth token handling for vulnerabilities', kind: 'security', model: 'opus' }
];

const KOREAN_MATRIX = [
  { objective: '리드미 오타를 고치고 주석 블록을 정리', kind: 'documentation', model: 'haiku' },
  { objective: 'limits 모듈 회귀 테스트 작성', kind: 'testing', model: 'haiku' },
  { objective: '원자적 쓰기 헬퍼를 공유 모듈로 구현', kind: 'implementation', model: 'haiku' },
  { objective: '라우팅 결정이 어디서 일어나는지 저장소를 탐색', kind: 'exploration', model: 'haiku' },
  { objective: 'JSON 스키마 검증 라이브러리 비교 조사', kind: 'research', model: 'haiku' },
  { objective: '경쟁 상태의 근본 원인을 찾아 디버깅', kind: 'debugging', model: 'opus' },
  { objective: '위임 서브시스템의 아키텍처 설계', kind: 'architecture', model: 'opus' },
  { objective: '인증 토큰 처리의 보안 취약점 검토', kind: 'security', model: 'opus' }
];

test('downshift matrix: advertised targets reach the cheap tier, high kinds keep the deep tier', async () => {
  const catalog = await loadPackagedCatalog();
  for (const expected of MATRIX) {
    const { classification, route } = routeObjective(catalog, expected.objective);
    assert.equal(classification.kind, expected.kind, `kind for: ${expected.objective}`);
    assert.equal(route.model, expected.model,
      `route for "${expected.objective}" (${classification.kind}/${classification.complexity}) `
      + `expected ${expected.model}, got ${route.model}`);
    assert.equal(route.provider, 'anthropic');
  }
});

test('downshift matrix (Korean): same kind and tier as the English equivalents', async () => {
  const catalog = await loadPackagedCatalog();
  for (const expected of KOREAN_MATRIX) {
    const { classification, route } = routeObjective(catalog, expected.objective);
    assert.equal(classification.kind, expected.kind, `kind for: ${expected.objective}`);
    assert.equal(route.model, expected.model,
      `route for "${expected.objective}" (${classification.kind}/${classification.complexity}) `
      + `expected ${expected.model}, got ${route.model}`);
    assert.equal(route.provider, 'anthropic');
  }
});

test('debug wording is not misclassified as research by the new low-tier rules', () => {
  const classification = classifyDifficulty({ objective: 'Investigate and debug the deadlock root cause' });
  assert.equal(classification.kind, 'debugging');
  assert.equal(classification.complexity, 'high');
});

// Cross-provider split: when a worker-delegation task leaves both providers in
// play (allowedProviders unset by the host → probed here as anthropic+openai),
// cheap/standard work stays on claude-haiku and deep architecture/security work
// goes to the cost-effective deep model (codex-sol). Pins that the two
// subscriptions are actually used and that the catalog economics don't drift.
const CROSS_MATRIX = [
  { objective: 'Extract the atomic write helper into a shared module', provider: 'anthropic', model: 'haiku' },
  { objective: 'Fix the typo in the README', provider: 'anthropic', model: 'haiku' },
  { objective: 'Design the architecture for the delegation subsystem', provider: 'openai', model: 'gpt-5.6-sol' },
  { objective: 'Review the auth token handling for vulnerabilities', provider: 'openai', model: 'gpt-5.6-sol' }
];

test('cross-provider routing: cheap stays on claude-haiku, deep goes to codex-sol', async () => {
  const catalog = await loadPackagedCatalog();
  for (const expected of CROSS_MATRIX) {
    const { route } = routeObjective(catalog, expected.objective, ['anthropic', 'openai']);
    assert.equal(route.provider, expected.provider, `provider for: ${expected.objective}`);
    assert.equal(route.model, expected.model, `model for: ${expected.objective}`);
  }
});

// Deep-tier domain split (Part B): the deep tier is not monopolized by one
// model. Reasoning-heavy debugging goes to claude-opus; systematic
// architecture/security stays on the cheaper-yet-equal codex-sol. These are
// deliberate priors — the verify-gate observations refine actual quality over
// time. Only debugging was moved (the one classifier-reachable reasoning kind);
// risk-analysis is not emitted by the classifier, so it is not tuned here.
const DOMAIN_MATRIX = [
  { objective: 'Find the root cause of the race condition and debug it', provider: 'anthropic', model: 'opus' },
  { objective: 'Design the architecture for the delegation subsystem', provider: 'openai', model: 'gpt-5.6-sol' },
  { objective: 'Review the auth token handling for vulnerabilities', provider: 'openai', model: 'gpt-5.6-sol' }
];

test('deep-tier domain split: debugging → claude-opus, architecture/security → codex-sol', async () => {
  const catalog = await loadPackagedCatalog();
  for (const expected of DOMAIN_MATRIX) {
    const { classification, route } = routeObjective(catalog, expected.objective, ['anthropic', 'openai']);
    assert.equal(classification.complexity, 'high', `high for: ${expected.objective}`);
    assert.equal(route.provider, expected.provider, `provider for: ${expected.objective}`);
    assert.equal(route.model, expected.model, `model for: ${expected.objective}`);
  }
});

// Objective #4 of the pipeline rework: downshift on "what passes first time",
// not on "cheapest above a quality floor". The mechanism is the observation
// ledger — classify passed observations: [] before, so a tier that kept failing
// verification would keep being chosen forever.
test('recorded verification failures pull a downshifted kind back up the ladder', async () => {
  const catalog = await loadPackagedCatalog();
  const objective = 'Extract the atomic write helper into a shared module';

  const cold = routeObjective(catalog, objective);
  assert.equal(cold.route.model, 'haiku', 'cold start still downshifts');

  // Same four dimensions the performance store matches on: provider, model,
  // effort, taskKind. Anything finer is metadata and must not gate matching.
  const failures = Array.from({ length: 12 }, () => ({
    recordedAt: new Date().toISOString(),
    provider: cold.route.provider,
    model: cold.route.model,
    effort: cold.route.effort,
    taskKind: cold.classification.kind,
    quality: 0.2,
    reviewed: true
  }));

  const classification = classifyDifficulty({ objective });
  const task = validateTask({
    id: 'matrix-probe', objective, role: 'executor', risk: 'standard',
    kind: classification.kind, complexity: classification.complexity,
    minimumQuality: classification.minimumQuality,
    allowedProviders: ['anthropic'],
    routingPriorities: classification.routingPriorities
  });
  const warmed = selectRoute({ task, catalog, observations: failures });

  assert.notEqual(warmed.model, 'haiku',
    'a tier with a recorded failure history must stop being the downshift target');
});

test('an unreadable observation ledger does not block the subagent gate', async () => {
  const { readObservations } = await import('../src/observations.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aorch-obs-'));
  const bad = path.join(dir, 'observations.jsonl');
  await writeFile(bad, '{"provider":"anthropic"}\n');   // missing required fields

  // classify catches this and routes on the priors instead; the point is that
  // readObservations reports the problem rather than silently returning [].
  await assert.rejects(readObservations(bad), /Invalid observation record 1/);
});
