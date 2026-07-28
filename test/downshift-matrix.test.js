import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateConfig } from '../src/config.js';
import { classifyDifficulty } from '../src/difficulty.js';
import { validateTask } from '../src/task.js';
import { selectRoute } from '../src/router.js';

// Regression harness for the downshift lever: every advertised target
// (documentation, testing, boilerplate implementation, exploration, research)
// must actually land on the cheapest tier against the REAL packaged catalog,
// and high-complexity kinds must stay on the deep tier. Uses no observations,
// mirroring the classify command's exact route construction.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadPackagedCatalog() {
  const raw = JSON.parse(await readFile(path.join(root, 'config/aorch.config.json'), 'utf8'));
  return validateConfig(raw);
}

function routeObjective(catalog, objective) {
  const classification = classifyDifficulty({ objective });
  const task = validateTask({
    id: 'matrix-probe',
    objective,
    role: 'executor',
    risk: 'standard',
    kind: classification.kind,
    complexity: classification.complexity,
    minimumQuality: classification.minimumQuality,
    allowedProviders: ['anthropic'],
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

test('debug wording is not misclassified as research by the new low-tier rules', () => {
  const classification = classifyDifficulty({ objective: 'Investigate and debug the deadlock root cause' });
  assert.equal(classification.kind, 'debugging');
  assert.equal(classification.complexity, 'high');
});
