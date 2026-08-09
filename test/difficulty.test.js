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

test('low/standard complexity emits tokens-first routing priorities to downshift', () => {
  const r = classifyDifficulty({ objective: 'Format this JSON file and fix indentation' });
  assert.equal(r.routingPriorities[0], 'tokens');
});

test('high complexity emits quality-first routing priorities', () => {
  const r = classifyDifficulty({ objective: 'Design the authentication architecture and threat model' });
  assert.equal(r.routingPriorities[0], 'quality');
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

test('exploration and research objectives classify low so haiku task kinds are reachable', () => {
  const explore = classifyDifficulty({ objective: 'Explore the repo and map out the routing modules' });
  assert.equal(explore.kind, 'exploration');
  assert.equal(explore.complexity, 'low');
  const research = classifyDifficulty({ objective: 'Research and compare options for schema validation' });
  assert.equal(research.kind, 'research');
  assert.equal(research.complexity, 'low');
});

test('debugging wins over research when both keywords appear', () => {
  const r = classifyDifficulty({ objective: 'Research the logs to find the root cause of the crash' });
  assert.equal(r.kind, 'debugging');
  assert.equal(r.complexity, 'high');
});

test('stem keywords match inflected forms', () => {
  assert.equal(classifyDifficulty({ objective: 'patch this vulnerability' }).complexity, 'high');
  assert.equal(classifyDifficulty({ objective: 'make the service scalable' }).complexity, 'high');
  assert.equal(classifyDifficulty({ objective: 'fix the indentation' }).complexity, 'low');
});

test('Korean high-complexity objectives keep the deep tier', () => {
  assert.equal(classifyDifficulty({ objective: '보안 취약점을 검토' }).kind, 'security');
  assert.equal(classifyDifficulty({ objective: '보안 취약점을 검토' }).complexity, 'high');
  assert.equal(classifyDifficulty({ objective: '아키텍처 설계' }).complexity, 'high');
  assert.equal(classifyDifficulty({ objective: '교착 상태를 디버깅' }).kind, 'debugging');
  assert.equal(classifyDifficulty({ objective: '교착 상태를 디버깅' }).complexity, 'high');
});

test('Korean low/standard objectives downshift', () => {
  assert.equal(classifyDifficulty({ objective: '리드미 오타 수정' }).kind, 'documentation');
  assert.equal(classifyDifficulty({ objective: '리드미 오타 수정' }).complexity, 'low');
  assert.equal(classifyDifficulty({ objective: '저장소 구조를 탐색' }).kind, 'exploration');
  assert.equal(classifyDifficulty({ objective: '라이브러리 비교 조사' }).kind, 'research');
  assert.equal(classifyDifficulty({ objective: '설정 파서를 구현' }).kind, 'implementation');
  assert.equal(classifyDifficulty({ objective: '설정 파서를 구현' }).complexity, 'standard');
});

test('Korean precedence: testing wins over implementation', () => {
  // '테스트 작성' contains both a testing stem (테스트) and an implementation
  // stem (작성); testing is higher in KIND_RULES so it must win.
  assert.equal(classifyDifficulty({ objective: '파서 테스트 작성' }).kind, 'testing');
  assert.equal(classifyDifficulty({ objective: '파서 테스트 작성' }).complexity, 'standard');
});
