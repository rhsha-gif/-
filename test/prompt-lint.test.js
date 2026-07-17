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

test('required sections containing regex metacharacters are matched literally', () => {
  const profile = { id: 'profile', strategy: 'sections', rules: { requiredSections: ['OUTPUT (JSON)'] } };
  const compliant = lintCompiledPrompt({
    task: { id: 'T1', verifierCommands: [], capabilityIds: [] },
    prompt: 'OUTPUT (JSON)\nReturn only JSON matching the receipt schema.\n\nOUTPUT\ncontract',
    profile,
    capabilities: {},
    lane: { lane: 'single-worker' }
  });
  assert.equal(compliant.valid, true, compliant.errors.join(' '));
  const missing = lintCompiledPrompt({
    task: { id: 'T1', verifierCommands: [], capabilityIds: [] },
    prompt: 'OUTPUT [JSON]\nReturn only JSON.\n\nOUTPUT\ncontract',
    profile,
    capabilities: {},
    lane: { lane: 'single-worker' }
  });
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((error) => error.includes('OUTPUT (JSON)')));
});

test('nested-delegation lint allows compiled prohibitions but still catches real positive delegation', () => {
  const t = { id: 'T1', verifierCommands: [], capabilityIds: [] };
  const lint = (body) => lintCompiledPrompt({ task: t, prompt: `OBJECTIVE\nx\nOUTPUT\n${body}`, profile: null, capabilities: {}, lane: { lane: 'single-worker' } })
    .errors.some((error) => /nested delegation/.test(error));
  // Allowed prohibitions (must NOT be flagged):
  assert.equal(lint('Do not create a nested orchestration loop.'), false);
  assert.equal(lint('Do not delegate, dispatch, or spawn another agent.'), false);
  assert.equal(lint('Do not delegate this bounded task to another agent or model.'), false);
  // Real positive delegation (MUST be flagged):
  assert.equal(lint('Delegate this task to another model.'), true);
  assert.equal(lint('Please call another model to review.'), true);
  assert.equal(lint('Spawn a subagent to handle testing.'), true);
  // Prohibition and positive instruction sharing one line, separated by ';':
  assert.equal(lint('Do not stop; delegate to another model.'), true);
});

test('placeholder lint flags stub markers and templates but not prose mentioning TODO/FIXME', () => {
  const t = { id: 'T1', verifierCommands: [], capabilityIds: [] };
  const flags = (body) => lintCompiledPrompt({ task: t, prompt: `OBJECTIVE\n${body}\nOUTPUT\nJSON`, profile: null, capabilities: {}, lane: { lane: 'single-worker' } })
    .errors.some((error) => /placeholder/.test(error));
  // Legitimate prose mention must NOT be flagged:
  assert.equal(flags('Remove the leftover TODO comment in parser.js and add a FIXME-free path.'), false);
  // Unfilled stub markers and templates MUST be flagged:
  assert.equal(flags('TODO'), true);
  assert.equal(flags('FIXME:'), true);
  assert.equal(flags('Do {{thing}}'), true);
  assert.equal(flags('[PLACEHOLDER]'), true);
});
