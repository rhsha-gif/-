# aorch v1 팔1 — 난이도 분류 → 다운시프트 라우팅 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 원시 서브태스크 서술을 라우터가 먹는 입력(kind/complexity/minimumQuality)으로 바꾸는 난이도 분류기를 만들고, 그것을 기존 `selectRoute`에 연결해 `aorch classify` 명령으로 노출한다. 그래서 리드가 서브태스크마다 "등급을 수동으로 안 고르고" 다운시프트 판정을 받는다.

**Architecture:** aorch의 티어 카탈로그(config/aorch.config.json)와 `selectRoute`(src/router.js)는 이미 "품질 바닥선 충족하는 최저 토큰 후보 선택"을 한다. 유일한 빈틈은 서술→라우터입력 분류. 새 순수 함수 `classifyDifficulty`(src/difficulty.js)를 TDD로 만들고, CLI `classify`가 그것으로 task를 조립해 `selectRoute`를 호출·출력한다. 분해기는 안 짓는다(Claude 리드의 네이티브 분해에 올라탐). claude-code-router의 태스크종류+토큰수 휴리스틱을 clean-room 이식한다.

**Tech Stack:** Node.js ESM (빌드스텝 없음), `node --test`, 기존 src/router.js·task.js·cli.js.

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-07-24-aorch-v1-decompose-delegate-design.md`.
- **JS ESM만, 빌드스텝·TS·새 의존성 추가 금지**(얕게 짓기). 토큰 추정도 외부 tiktoken 의존 없이 문자수 근사로(개인·솔로 볼륨엔 충분).
- 목적함수 = 시간+리미트 절약, **품질 바닥선(minimumQuality) 유지**. 분류기는 절대 minimumQuality를 0으로 떨구지 않는다.
- 라우팅 대상 = 보일러플레이트/리팩터/테스트/문서. **읽기/조사/요약은 다운시프트하되 품질 바닥선은 유지**(스팟체크 비용 회피).
- 경로에 한글·공백 — 셸에서 큰따옴표.
- 검증: `node --test` (기존 `test/cli-smoke.test.js:41` npm bin symlink 테스트는 Windows EPERM으로 사전 실패 — "그 외 신규 실패 없음"으로 판정).

---

## File Structure

- Create: `src/difficulty.js` — 순수 함수 `classifyDifficulty`. 서술→{kind, complexity, minimumQuality, tokenEstimate, signals}. 유일한 새 로직.
- Create: `test/difficulty.test.js` — 분류기 단위 테스트.
- Modify: `src/cli.js` — `classify` 서브커맨드 추가(분류→selectRoute 조립→JSON 출력). 기존 `route`/`exec` 옆에.
- Modify: `test/cli-smoke.test.js` — `classify` 스모크 1건.
- Create: `integrations/aorch-downshift/SKILL.md` — 리드에게 "워커 spawn 전 `aorch classify`로 등급 판정받아 서브에이전트 model로 쓰라"는 규율 주입. (권고 층; 강제 훅은 후속.)

---

### Task 1: 난이도 분류기 (핵심 새 로직)

**Files:**
- Create: `src/difficulty.js`
- Test: `test/difficulty.test.js`

**Interfaces:**
- Consumes: 없음(순수 함수, 입력 객체만).
- Produces: `classifyDifficulty({ objective, kind, tokenEstimate, longContextThreshold }) → { kind, complexity, minimumQuality, tokenEstimate, signals }`. Task 2의 `classify` 명령이 이 반환을 task 필드로 써서 `selectRoute`를 호출한다. `complexity ∈ {low,standard,high}`, `minimumQuality ∈ [0,1]`, `signals` = 판정 근거 문자열 배열.

- [ ] **Step 1: 실패 테스트 작성** — `test/difficulty.test.js`

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDifficulty } from '../src/difficulty.js';

test('boilerplate/format objective downshifts to low complexity', () => {
  const r = classifyDifficulty({ objective: 'Format this JSON file and fix indentation' });
  assert.equal(r.complexity, 'low');
  assert.equal(r.kind, 'documentation');
  assert.ok(r.minimumQuality >= 0.7, 'quality floor preserved');
});

test('architecture/security objective upshifts to high complexity', () => {
  const r = classifyDifficulty({ objective: 'Design the authentication architecture and threat model' });
  assert.equal(r.complexity, 'high');
  assert.ok(['architecture', 'security'].includes(r.kind));
  assert.ok(r.minimumQuality >= 0.85, 'high complexity raises the floor');
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/difficulty.test.js`
Expected: FAIL — `Cannot find module '../src/difficulty.js'`.

- [ ] **Step 3: 최소 구현** — `src/difficulty.js`

```javascript
// Maps a raw subtask description to the routing inputs selectRoute consumes.
// Heuristic (task-kind keywords + token-count), not a trained model — solo
// volume can't train a router. Borrowed clean-room from claude-code-router's
// scenario routing. NEVER drops the quality floor to zero (objective = time +
// limit savings WITH a minimum quality bar).

const KIND_RULES = [
  { kind: 'security', complexity: 'high', re: /\b(security|threat model|auth|vulnerab|exploit|crypto)\b/i },
  { kind: 'architecture', complexity: 'high', re: /\b(architect|system design|design the|scalab)\b/i },
  { kind: 'debugging', complexity: 'high', re: /\b(race condition|deadlock|heisenbug|root cause|debug)\b/i },
  { kind: 'documentation', complexity: 'low', re: /\b(format|indent|docstring|comment|readme|rename|typo|boilerplate)\b/i },
  { kind: 'testing', complexity: 'standard', re: /\b(test|spec|coverage|regression)\b/i },
  { kind: 'implementation', complexity: 'standard', re: /\b(implement|add|refactor|extract|wire|build)\b/i }
];

const FLOOR_BY_COMPLEXITY = Object.freeze({ low: 0.72, standard: 0.8, high: 0.88 });
const COMPLEXITY_RANK = Object.freeze({ low: 0, standard: 1, high: 2 });

export function classifyDifficulty({ objective, kind, tokenEstimate, longContextThreshold = 60000 } = {}) {
  if (typeof objective !== 'string' || objective.trim() === '') {
    throw new TypeError('classifyDifficulty requires a non-empty objective');
  }
  const tokens = tokenEstimate ?? Math.round(objective.length / 4);
  const signals = [];

  const matched = KIND_RULES.find((rule) => rule.re.test(objective));
  const inferredKind = kind ?? matched?.kind ?? 'implementation';
  let complexity = matched?.complexity ?? 'standard';
  if (matched) signals.push(`kind:${matched.kind}`);
  if (kind) signals.push(`kind-explicit:${kind}`);

  if (tokens >= longContextThreshold) {
    signals.push('long-context');
    if (COMPLEXITY_RANK[complexity] < COMPLEXITY_RANK.standard) complexity = 'standard';
  }

  return {
    kind: inferredKind,
    complexity,
    minimumQuality: FLOOR_BY_COMPLEXITY[complexity],
    tokenEstimate: tokens,
    signals
  };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test test/difficulty.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: 전체 스위트 회귀 확인**

Run: `node --test`
Expected: 신규 실패 0 (기존 `cli-smoke.test.js:41` EPERM만 실패).

- [ ] **Step 6: 커밋** *(사용자 승인 후 — 개인 규약상 명시 요청 시에만)*

```bash
git add src/difficulty.js test/difficulty.test.js
git commit -m "feat: add difficulty classifier for subtask downshift routing"
```

---

### Task 2: `aorch classify` CLI 명령 (분류 → 라우팅 결정 노출)

**Files:**
- Modify: `src/cli.js` — `classify` 서브커맨드 추가.
- Test: `test/cli-smoke.test.js` — 스모크 1건 추가.

**Interfaces:**
- Consumes: Task 1의 `classifyDifficulty(...)`; 기존 `selectRoute({ task, catalog, observations })`(src/router.js), 기존 config 로더(src/config.js), 기존 task 검증(src/task.js `validateTask`).
- Produces: `aorch classify --objective "<text>" [--role executor] [--risk standard]` → stdout에 `{ classification, route: { provider, model, effort } }` JSON. 리드/belt가 이걸 파싱해 서브에이전트 model로 쓴다.

- [ ] **Step 1: 스모크 테스트 작성** — `test/cli-smoke.test.js`에 추가

```javascript
test('classify emits a route for a boilerplate objective', async (t) => {
  const { stdout } = await runCli(['classify', '--objective', 'Format the config JSON', '--role', 'executor']);
  const out = JSON.parse(stdout);
  assert.equal(out.classification.complexity, 'low');
  assert.equal(out.route.provider, 'anthropic'); // haiku-scout wins the low-token floor
  assert.match(out.route.model, /haiku/);
});
```
(`runCli` 헬퍼가 없으면 파일 상단의 기존 CLI 실행 헬퍼 패턴을 그대로 따른다 — 같은 파일의 다른 테스트가 CLI를 어떻게 spawn하는지 참고.)

- [ ] **Step 2: 실패 확인**

Run: `node --test test/cli-smoke.test.js`
Expected: FAIL — `classify`가 unknown command.

- [ ] **Step 3: 명령 구현** — `src/cli.js`의 명령 디스패치에 추가

```javascript
// classify: raw objective -> difficulty -> route (no worker spawn).
if (command === 'classify') {
  const objective = flag('--objective');
  if (!objective) throw new Error('classify requires --objective');
  const classification = classifyDifficulty({ objective });
  const config = await loadConfig(flag('--config'));               // 기존 로더 재사용
  const task = validateTask({
    id: 'classify-probe',
    objective,
    role: flag('--role') ?? 'executor',
    risk: flag('--risk') ?? 'standard',
    kind: classification.kind,
    complexity: classification.complexity,
    minimumQuality: classification.minimumQuality
  });
  const route = selectRoute({ task, catalog: config, observations: [] });
  process.stdout.write(JSON.stringify({
    classification,
    route: { provider: route.provider, model: route.model, effort: route.effort }
  }) + '\n');
  return;
}
```
(정확한 `flag(...)`/`loadConfig(...)`/import 이름은 cli.js 상단의 기존 관례를 따른다. `classifyDifficulty`·`selectRoute`·`validateTask` import 추가.)

- [ ] **Step 4: 통과 확인**

Run: `node --test test/cli-smoke.test.js`
Expected: PASS.

- [ ] **Step 5: 전체 회귀 + 실사용 확인**

Run: `node --test` → 신규 실패 0.
Run: `node src/cli.js classify --objective "Design the billing architecture"` → `complexity:"high"`, model에 `opus` 또는 `sol` 계열 관찰.

- [ ] **Step 6: 커밋** *(사용자 승인 후)*

```bash
git add src/cli.js test/cli-smoke.test.js
git commit -m "feat: aorch classify command maps objective to a downshift route"
```

---

### Task 3: 다운시프트 스킬 (리드에게 규율 주입)

**Files:**
- Create: `integrations/aorch-downshift/SKILL.md`

**Interfaces:**
- Consumes: Task 2의 `aorch classify` 명령.
- Produces: Claude 리드가 서브태스크를 spawn하기 전 참조하는 스킬 문서. 강제가 아니라 권고(정직한 약점 — 스펙 §3.1).

- [ ] **Step 1: 스킬 문서 작성** — `integrations/aorch-downshift/SKILL.md`

```markdown
---
name: aorch-downshift
description: 작업을 서브태스크로 나눠 워커(서브에이전트)에게 위임하기 직전에 사용. 각 서브태스크의 등급(모델)을 수동으로 고르지 말고 aorch에 판정을 위임한다.
---

# aorch 다운시프트 위임

리드가 작업을 서브태스크로 분해해 워커를 띄우려 할 때, **각 서브태스크마다 워커를 spawn하기 전에** 다음을 한다:

1. 서브태스크의 목표 한 줄을 정한다.
2. `node <repo>/src/cli.js classify --objective "<서브태스크 목표>"` 를 실행한다.
3. 반환된 `route.model`(haiku/sonnet/opus 등)과 `route.effort`를 **그 서브에이전트의 model 오버라이드**로 사용한다.
4. 등급을 임의로 올리지 않는다. 분류기가 이미 품질 바닥선(minimumQuality)을 지킨다.

**대상:** 보일러플레이트/리팩터/테스트/문서. **제외:** 사용자가 직접 대화 중인 메인 추론(다운시프트하지 않음).
```

- [ ] **Step 2: 스킬이 명령을 정확히 부르는지 수동 확인**

Run: `node src/cli.js classify --objective "Write a docstring for parseConfig"`
Expected: `complexity:"low"`, haiku 계열 route — 스킬 지시대로 서브에이전트에 넣을 값이 나옴.

- [ ] **Step 3: 커밋** *(사용자 승인 후)*

```bash
git add integrations/aorch-downshift/SKILL.md
git commit -m "feat: add aorch-downshift skill instructing the lead to route subtasks"
```

---

## Self-Review

**1. Spec coverage:** 스펙 §3.1 "리드가 어떻게 개입" → Task 3 스킬 + Task 2 명령(belt의 CLI 형태). §3.2 팔1 티어 라우팅 → Task 1 분류기 + 기존 selectRoute(이미 존재). §2 목적함수 품질바닥선 → Task 1 FLOOR_BY_COMPLEXITY + minimumQuality 유지. §4 기존 코어 강화 → Task 2가 selectRoute/validateTask/config 로더 재사용, 신규 파일은 difficulty.js 하나. 팔2(Codex 위임·fallback)·verify 캐스케이드는 **이 계획 범위 밖**(핸드오프 시간축 측정 후 별도 계획).

**2. Placeholder scan:** Task 1은 완전한 코드. Task 2·3은 cli.js/스킬의 기존 관례를 따르라는 참조가 있으나(정확한 flag/loader 이름), 이는 실물 파일 관례에 붙이라는 의도된 지시이지 플레이스홀더 아님 — 구현자가 cli.js 상단만 보면 확정됨. TODO/TBD 없음.

**3. Type consistency:** `classifyDifficulty` 반환 필드(kind/complexity/minimumQuality/tokenEstimate/signals)가 Task 1 정의와 Task 2 소비에서 일치. `selectRoute`/`validateTask` 시그니처는 실제 src/router.js·src/task.js에서 확인됨.

## 범위 밖 (다음 계획)

- 팔2: Codex 위임 디스패치(worktree+envelope) + 크로스 fallback(claudexor usage폴링/claude-code-mux priority). → 핸드오프 **시간 축** 측정 후.
- verify 캐스케이드(FrugalGPT 골격 + 테스트 실행 scorer + escalate). → 위임이 실제 워커를 띄우기 시작할 때.
- pre-subagent 훅으로 분류 강제화(권고→강제). → 실현성 조사 후.
