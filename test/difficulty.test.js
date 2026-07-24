import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDifficulty } from '../src/difficulty.js';

test('boilerplate/format objective downshifts to low complexity', () => {
  const r = classifyDifficulty({ objective: 'Format this JSON file and fix indentation' });
  assert.equal(r.complexity, 'low');
  assert.equal(r.kind, 'documentation');
  assert.equal(r.minimumQuality, 0.72);
});

test('architecture/security objective upshifts to high complexity', () => {
  const r = classifyDifficulty({ objective: 'Design the authentication architecture and threat model' });
  assert.equal(r.complexity, 'high');
  assert.ok(['architecture', 'security'].includes(r.kind));
  assert.equal(r.minimumQuality, 0.88);
});

test('explicit kind is respected over inference', () => {
  const r = classifyDifficulty({ objective: 'anything', kind: 'testing' });
  assert.equal(r.kind, 'testing');
});

test('long context forces at least standard complexity', () => {
  const r = classifyDifficulty({ objective: 'trivial', tokenEstimate: 80000, longContextThreshold: 60000 });
  assert.notEqual(r.complexity, 'low');
  assert.ok(r.signals.includes('long-context'));
});

test('token estimate is derived from objective length when absent', () => {
  const r = classifyDifficulty({ objective: 'x'.repeat(400) });
  assert.equal(r.tokenEstimate, 100); // 400 chars / 4
});

test('empty or missing objective throws', () => {
  assert.throws(() => classifyDifficulty({ objective: '' }), TypeError);
  assert.throws(() => classifyDifficulty({}), TypeError);
});

test('stem keywords match inflected forms', () => {
  assert.equal(classifyDifficulty({ objective: 'patch this vulnerability' }).complexity, 'high');
  assert.equal(classifyDifficulty({ objective: 'make the service scalable' }).complexity, 'high');
  assert.equal(classifyDifficulty({ objective: 'fix the indentation' }).complexity, 'low');
});
