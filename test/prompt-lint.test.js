import test from 'node:test';
import assert from 'node:assert/strict';
import { lintCompiledPrompt } from '../src/prompt-lint.js';

const base = {
  task: {
    id: 'T1', objective: 'Implement parser', role: 'executor', risk: 'standard', write: true,
    allowedScope: ['src/**'], forbiddenScope: ['deployment/**'], acceptanceCriteria: ['Parser works'],
    verificationCommands: ['npm test'], verifierCommands: ['npm run hidden'], capabilityIds: ['tdd']
  },
  profile: { id: 'profile', strategy: 'sections', rules: { requiredSections: ['ROLE', 'OBJECTIVE', 'ALLOWED SCOPE', 'SUCCESS CRITERIA', 'VERIFICATION', 'OUTPUT'] } },
  capabilities: { skills: [{ id: 'tdd' }], plugins: [], hooks: [] },
  lane: { lane: 'bundled' }
};

test('prompt linter accepts a complete bounded delegated prompt', () => {
  const result = lintCompiledPrompt({ ...base, prompt: 'ROLE\nworker\n\nOBJECTIVE\nImplement parser\n\nALLOWED SCOPE\nsrc/**\n\nSUCCESS CRITERIA\nParser works\n\nVERIFICATION\nnpm test\n\nOUTPUT\nStrict receipt JSON' });
  assert.deepEqual(result.errors, []);
});

test('prompt linter rejects hidden verifier leakage, placeholders, and unknown capabilities', () => {
  const result = lintCompiledPrompt({
    ...base,
    prompt: 'ROLE\nworker\nOBJECTIVE\nTODO\nALLOWED SCOPE\nsrc/**\nSUCCESS CRITERIA\nParser works\nVERIFICATION\nnpm run hidden\nOUTPUT\nJSON',
    capabilities: { skills: [], plugins: [], hooks: [] }
  });
  assert.ok(result.errors.some((entry) => /hidden verifier/i.test(entry)));
  assert.ok(result.errors.some((entry) => /placeholder/i.test(entry)));
  assert.ok(result.errors.some((entry) => /unknown capability/i.test(entry)));
});

test('single-worker prompt rejects positive nested delegation but accepts an explicit no-delegation rule', () => {
  const delegated = lintCompiledPrompt({
    ...base,
    task: { ...base.task, risk: 'low' },
    profile: null,
    lane: { lane: 'single-worker' },
    prompt: 'OBJECTIVE\nFix the parser.\nALLOWED SCOPE\nsrc/**\nSUCCESS CRITERIA\nTests pass.\nVERIFICATION\nnpm test\nOUTPUT\nJSON. Delegate this task to another model.'
  });
  assert.ok(delegated.errors.some((entry) => /single-worker.*nested delegation/i.test(entry)));

  const bounded = lintCompiledPrompt({
    ...base,
    task: { ...base.task, risk: 'low' },
    profile: null,
    lane: { lane: 'single-worker' },
    prompt: 'OBJECTIVE\nFix the parser.\nALLOWED SCOPE\nsrc/**\nSUCCESS CRITERIA\nTests pass.\nVERIFICATION\nnpm test\nOUTPUT\nJSON. Do not delegate this bounded task to another agent or model.'
  });
  assert.deepEqual(bounded.errors, []);
});

test('prompt linter enforces a deterministic maximum prompt size', () => {
  const result = lintCompiledPrompt({ ...base, prompt: 'x'.repeat(200), maxChars: 100 });
  assert.ok(result.errors.some((entry) => /maximum prompt size/i.test(entry)));
});
