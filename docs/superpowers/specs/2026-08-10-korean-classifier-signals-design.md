# 한국어 분류 신호 설계 (2026-08-10, 인터뷰 확정)

기준선: `codexss`. 규율 = 얕게(신규 의존성 0, 영어 규칙·다른 파일 변경 없음).

## Context

aorch의 다운시프트 분류기 `src/difficulty.js`의 `KIND_RULES`는 영어 키워드만 매칭한다. 그래서 한국어로 쓴 목표는 어떤 kind 규칙에도 걸리지 않고 전부 기본값 `implementation/standard → haiku`로 떨어진다. 즉 "보안 취약점 검토"·"아키텍처 설계"·"교착 상태 디버깅" 같은 **고난도 작업이 품질 바닥선 판단 없이 저등급으로 다운시프트**된다. 사용자는 한국어로 프롬프트하므로 이 공백이 실사용에서 상시 발생한다.

참고: 얇은 risk 게이트(`integrations/shared/gate.mjs`)는 이미 한국어 스템(보안·인증·구현·삭제 등)을 처리한다(0.4.0). 이 기능은 **difficulty.js 분류기 한정**이며, 게이트와 동일한 간결-스템 스타일을 미러링한다.

known lesson: JavaScript 정규식 `\b`는 한글 옆에서 무효(한글은 word 문자 클래스가 아님). 그래서 한국어 패턴은 `\b` 없이 대안(alternation)으로 쓴다 — 이 저장소가 0.4.0에서 게이트를 고치며 확인한 사실이다.

## 결정 원장 (인터뷰)

| 축 | 결정 |
|---|---|
| 범위 | difficulty.js만. risk 게이트는 이미 한국어 처리 — 손대지 않음. 영어 규칙 변경 없음. |
| 오탐 성향 | shipped된 risk 게이트와 동일한 간결-스템 미러링. 영어 규칙과 같은 수준의 과잉등급만 허용. |
| 코드 구조 | 규칙별 한국어 패턴 **분리**(`reKo` 필드). 인라인 append 아님(가독성·`\b` 미사용 명시). |
| 검증 | downshift-matrix 미러(한국어 등가 행) + difficulty.test.js 단위 케이스. |

## 설계

### 구조: 규칙당 `reKo` 필드

`KIND_RULES`의 8개 항목마다 선택적 `reKo`(한국어, `\b` 없음)를 추가한다. 영어 `re`(`\b` 유지)는 불변. `classifyDifficulty`의 매칭을

```js
const matched = KIND_RULES.find((rule) => rule.re.test(objective) || rule.reKo?.test(objective));
```

로 바꾼다. first-match 우선순위, `signals.push('kind:...')`, complexity, `FLOOR_BY_COMPLEXITY`, `PRIORITIES_BY_COMPLEXITY` 로직은 전부 그대로. `reKo`가 없는 규칙은 `?.`로 안전하게 건너뛴다.

### 한국어 용어 (게이트 스타일, 균형)

| kind (complexity) | reKo 대안(`i` 플래그, `\b` 없음) |
|---|---|
| security (high) | 보안 / 취약점 / 인증 / 권한 / 암호화 |
| architecture (high) | 아키텍처 / 시스템 설계 / 확장성 |
| debugging (high) | 디버깅 / 교착 / 경쟁 상태 / 근본 원인 |
| exploration (low) | 탐색 / 둘러보 |
| research (low) | 조사 / 라이브러리 비교 |
| documentation (low) | 리드미 / 오타 / 주석 / 포맷 / 들여쓰기 / 이름 변경 |
| testing (standard) | 테스트 / 스펙 / 커버리지 / 회귀 |
| implementation (standard) | 구현 / 추가 / 리팩터 / 만들 / 작성 / 구축 |

우선순위(위→아래, first-match)가 보장하는 경계:
- "보안 취약점 검토" → security/high(opus 유지)
- "아키텍처 설계" → architecture/high
- "교착 상태를 디버깅" → debugging/high
- "테스트 작성" → testing(구현 아님 — testing이 implementation보다 위)
- "설정 파서를 구현" → implementation/standard(haiku)
- "리드미 오타 수정" → documentation/low(haiku)

### 오탐 성향과 안전망

한국어 스템의 매칭 폭은 영어 규칙과 동일 수준으로 둔다(예: `설계`는 "design the"만큼 넓다). 저난도 작업이 간혹 high로 과잉등급될 수 있으나, 이는 "안전하지만 비싼" 오류다. 반대(고난도가 저등급으로)는 `minimumQuality` 바닥선과 verify-게이트 자기교정(quality 1.0/0.2 관측)이 잡는다. `long-context` 승격 로직도 그대로 적용된다.

## 범위 밖

- risk 게이트(gate.mjs) — 이미 한국어 처리. 변경/검토 없음.
- 영어 `re` 패턴 — 불변.
- 새 의존성 0. 새 파일 0(difficulty.js + 두 테스트 파일만 수정).

## 검증

1. `test/downshift-matrix.test.js`: 기존 8개 영어 케이스에 대응하는 한국어 행을 매트릭스에 추가한다(보안 검토→opus, 아키텍처 설계→opus, 디버깅→opus, 오타 수정→haiku, 파서 구현→haiku, 탐색→haiku, 라이브러리 비교 조사→haiku, 테스트 작성→haiku). 기존 영어 행은 불변.
2. `test/difficulty.test.js`: 한국어 단위 케이스 — 고난도 유지(보안/아키텍처/디버깅→complexity high), 저등급 다운시프트, 우선순위("테스트 작성"→testing, "설정 파서 구현"→implementation).
3. `node --test test/difficulty.test.js test/downshift-matrix.test.js` 그린, 이어서 `npm run check` 전체 그린(현재 182 pass/1 skip 유지 + 신규 케이스).

## 리스크 원장

- `설계`·`조사` 등 넓은 스템의 과잉등급: 최종 리뷰에서 bare `설계`가 "폼/쿼리 설계"까지 architecture/high로 올린다는 실측이 나와, architecture reKo를 `아키텍처 / 시스템 설계 / 확장성`으로 좁혔다(인증/권한→security는 auth 신중처리로 유지). 이후 넓은 스템이 또 문제되면 동일하게 다어구로 좁힌다 — config 아니라 규칙 한 줄.
- 도그푸딩 패치(`scratchpad/korean-signals.patch`)는 인라인 append였으나, 확정된 분리 구조로 재작성한다(참고용).
