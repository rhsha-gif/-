# Korean Classifier Signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make aorch's downshift classifier (`src/difficulty.js`) recognize Korean task objectives so high-complexity Korean work (security/architecture/debugging) is no longer silently downshifted to `implementation/standard → haiku`.

**Architecture:** Add an optional `reKo` regex field to each of the 8 `KIND_RULES` entries in `src/difficulty.js` (Korean alternations, no `\b` — Hangul is not a JS word-boundary character), and change the single match line in `classifyDifficulty` to test `rule.re || rule.reKo`. English `re` patterns and all downstream logic (signals, complexity, floor, priorities) stay untouched. Verified by Korean unit cases and a Korean mirror of the downshift regression matrix.

**Tech Stack:** Node.js ≥20, ESM, `node --test`. Zero runtime dependencies.

## Global Constraints

- No new runtime dependencies; no new files. Only `src/difficulty.js`, `test/difficulty.test.js`, `test/downshift-matrix.test.js` change. — copied from spec "새 의존성 0. 새 파일 0"
- English `re` patterns must NOT change; existing English test rows/cases must stay green and unmodified.
- Korean patterns use the `i` flag and NO `\b` (Hangul is not a `\b` word character — this is a repo lesson from the 0.4.0 gate fix).
- First-match precedence in `KIND_RULES` is unchanged (security > architecture > debugging > exploration > research > documentation > testing > implementation).
- `node --test` must stay green (the only allowed skip is the pre-existing Windows symlink EPERM skip in `test/cli-smoke.test.js`).
- Scope is `src/difficulty.js` only; the risk gate (`integrations/shared/gate.mjs`) already handles Korean and is out of scope.

## File Structure

- Modify `src/difficulty.js` — add `reKo` to each `KIND_RULES` entry; update the `matched` line in `classifyDifficulty`.
- Modify `test/difficulty.test.js` — append Korean unit cases (high-stays-high, low-downshifts, precedence).
- Modify `test/downshift-matrix.test.js` — add a `KOREAN_MATRIX` and a test iterating it through the real packaged catalog/router (end-to-end classify→route), leaving the English `MATRIX` and its test untouched.

---

## Task 1: Korean signals in the classifier + unit tests

**Files:**
- Modify: `src/difficulty.js:7-19` (KIND_RULES) and `src/difficulty.js:40` (the `matched` line)
- Test: `test/difficulty.test.js` (append cases)

**Interfaces:**
- Consumes: existing `classifyDifficulty({ objective, kind, tokenEstimate, longContextThreshold })` — unchanged signature, unchanged return shape `{ kind, complexity, minimumQuality, tokenEstimate, signals, routingPriorities }`.
- Produces: each `KIND_RULES` entry now optionally carries `reKo` (a `RegExp`). No exported-symbol changes.

- [ ] **Step 1: Write the failing Korean unit tests**

Append to `test/difficulty.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/difficulty.test.js`
Expected: FAIL — the new Korean cases classify as `implementation/standard` (the default) instead of the expected kinds, because no `reKo` exists yet.

- [ ] **Step 3: Add `reKo` fields and update the match line**

In `src/difficulty.js`, replace the `KIND_RULES` array (lines 7-19) with (English `re` values copied verbatim, `reKo` added):

```js
const KIND_RULES = [
  { kind: 'security', complexity: 'high', re: /\b(security|threat model|auth|vulnerab\w*|exploit|crypto)\b/i, reKo: /보안|취약점|인증|권한|암호화/i },
  { kind: 'architecture', complexity: 'high', re: /\b(architect|system design|design the|scalab\w*)\b/i, reKo: /아키텍처|설계|확장성/i },
  { kind: 'debugging', complexity: 'high', re: /\b(race condition|deadlock|heisenbug|root cause|debug)\b/i, reKo: /디버깅|교착|경쟁 상태|근본 원인/i },
  // Below debugging on purpose: "investigate and debug X" must classify as
  // debugging, not research. These two unlock haiku's existing exploration
  // and research taskKinds, which no classifier rule emitted before.
  { kind: 'exploration', complexity: 'low', re: /\b(explore|survey|find where|locate|map out)\b/i, reKo: /탐색|둘러보/i },
  { kind: 'research', complexity: 'low', re: /\b(research|look up|compare (?:libraries|options))\b/i, reKo: /조사|라이브러리 비교/i },
  { kind: 'documentation', complexity: 'low', re: /\b(format|indent\w*|docstring|comment|readme|rename|typo|boilerplate)\b/i, reKo: /리드미|오타|주석|포맷|들여쓰기|이름 변경/i },
  { kind: 'testing', complexity: 'standard', re: /\b(test|spec|coverage|regression)\b/i, reKo: /테스트|스펙|커버리지|회귀/i },
  { kind: 'implementation', complexity: 'standard', re: /\b(implement|add|refactor|extract|wire|build)\b/i, reKo: /구현|추가|리팩터|만들|작성|구축/i }
];
```

Then update the match line (currently `src/difficulty.js:40`):

```js
  const matched = KIND_RULES.find((rule) => rule.re.test(objective) || rule.reKo?.test(objective));
```

Leave everything else (FLOOR_BY_COMPLEXITY, the signals/long-context logic, the return object) unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/difficulty.test.js`
Expected: PASS — all new Korean cases plus every pre-existing English case are green.

- [ ] **Step 5: Commit**

```bash
git add src/difficulty.js test/difficulty.test.js
git commit -m "feat: recognize Korean objectives in the downshift classifier"
```

---

## Task 2: Korean regression matrix (end-to-end classify → route)

**Files:**
- Test: `test/downshift-matrix.test.js` (add `KOREAN_MATRIX` + a test; leave `MATRIX` and its test unchanged)

**Interfaces:**
- Consumes: the existing test helpers in this file — `loadPackagedCatalog()` and `routeObjective(catalog, objective)` returning `{ classification, route }` — and `classifyDifficulty` (already imported). Uses the same assertion shape as the English matrix test.
- Produces: nothing exported; a regression test that pins the Korean classify→route boundaries against the real packaged catalog.

- [ ] **Step 1: Add the Korean matrix and its failing-if-regressed test**

In `test/downshift-matrix.test.js`, directly after the existing `MATRIX` array declaration, add:

```js
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
```

Then add this test directly after the existing `downshift matrix: ...` test:

```js
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
```

- [ ] **Step 2: Run the test to verify it passes on the Task 1 implementation**

Run: `node --test test/downshift-matrix.test.js`
Expected: PASS — with Task 1's `reKo` fields in place, each Korean objective classifies to the same kind and routes to the same model as its English counterpart. (If Task 1 were reverted, every Korean row would collapse to `implementation/haiku` and the opus rows would fail — this is the regression guard.)

- [ ] **Step 3: Run the full suite**

Run: `npm run check`
Expected: all tests pass; only the pre-existing Windows symlink EPERM skip is skipped.

- [ ] **Step 4: Commit**

```bash
git add test/downshift-matrix.test.js
git commit -m "test: pin Korean classify-to-route boundaries in the downshift matrix"
```

---

## Self-Review

**1. Spec coverage:**
- `reKo` field per rule + `re || reKo` match → Task 1 Step 3. ✅
- Korean term table (security/architecture/debugging/exploration/research/documentation/testing/implementation) → Task 1 Step 3, terms copied verbatim from the spec table. ✅
- `\b`-free Korean, `i` flag → the `reKo` literals use `/…/i` with no `\b`. ✅
- Precedence preserved (first-match order unchanged; testing above implementation) → Task 1 Step 1 precedence test + Step 3 keeps array order. ✅
- English `re` untouched → Task 1 Step 3 copies English values verbatim; no English test row changes. ✅
- downshift-matrix Korean mirror → Task 2. ✅
- difficulty.test.js unit cases (high-stays-high, low-downshifts, precedence) → Task 1 Step 1. ✅
- Out of scope (gate.mjs, deps, new files) → nothing in either task touches them. ✅

**2. Placeholder scan:** No TBD/TODO. Every step carries real code and a concrete run/expected line. ✅

**3. Type consistency:** `reKo` is a `RegExp` used only via `rule.reKo?.test(objective)`; `classifyDifficulty` signature and return shape unchanged; Task 2 reuses `loadPackagedCatalog`/`routeObjective`/the MATRIX assertion shape exactly as the existing English test. ✅

## Notes for the executor

- Do NOT reorder `KIND_RULES`; precedence is load-bearing (a Korean objective with both `테스트` and `작성` must resolve to `testing`).
- Keep each `reKo` on the same line as its rule for a minimal, reviewable diff.
- If a Korean row in Task 2 unexpectedly routes to the wrong tier, the fix is a `reKo` term in Task 1 (a stem too broad/narrow), not a change to the router or catalog.
