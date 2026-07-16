# Adaptive Capability Orchestrator Design

## 1. 최상위 목표

사용자는 Claude Code 또는 Codex CLI에서 일반 프롬프트를 입력한다. 시스템은 요청보다 먼저 얇은 정책 게이트를 통과시키고, substantive work라면 root orchestrator가 요청을 독립 검증 가능한 작업으로 분해한다. 각 작업에는 다음 조합을 선택한다.

```text
provider
model
reasoning effort
skill / plugin / hook
permission / scope / isolation
verification / review
```

시스템의 주된 책임은 **작업 분해와 작업별 capability 조합 선택**이다. 더 많은 agent를 만드는 것 자체는 목표가 아니다.

## 2. 제작 우선순위와 런타임 정책의 분리

참고 프로젝트를 재구성해 이 소스를 제작할 때의 우선순위는 다음이다.

```text
구현 품질 >> 토큰 효율 > 제작 시간
```

이 기준은 소스 제작 과정의 기준이며 런타임의 모든 task에 강제되는 전역 함수가 아니다.

런타임 route는 다음을 고려한다.

- acceptance criteria
- task kind와 role
- complexity
- risk
- required capability와 trust
- provider compatibility와 adapter maturity
- 최근 독립 검토 성과
- model maturity
- 사용자 또는 프로젝트의 budget/latency constraint

`complexity`는 추론·구현 난이도이고 `risk`는 실패 비용과 검증 강도다. 두 축을 대체해서 사용하지 않는다.

## 3. 최소 제어 아키텍처

```text
User prompt
  ↓
Thin UserPromptSubmit gate
  ├─ read-only / development / high-risk 분류
  └─ 최소 정책 context 주입
  ↓
Host CLI + adaptive-orchestrate skill
  ↓
Risk policy → task decomposition → inventory → route
  ↓
Durable run + bounded task envelopes
  ↓
Claude CLI | Codex CLI | Generic CLI
  ↓
Worker receipt (claim)
  ↓
Independent verifier attestation (evidence)
  ↓
Optional blind/cross-provider review
  ↓
Integration + run finish
  ↓
Post-run reflection + user feedback + pending proposals
```

blocking hook은 inventory, lessons, route scoring, provider execution을 수행하지 않는다. 이 작업은 root skill에서 수행한다. high-risk 용어의 단순 설명·분석 요청은 mutation 요청으로 승격하지 않는다. 모든 write task는 이미 격리된 환경이 아니라면 root skill이 독립 worktree에서 실행하고, `aorch exec`도 linked-worktree 여부를 검사한다. low/standard in-place 예외는 명시적 사용자 승인과 `allowInPlaceWrite: true`가 있어야 하며 high/critical write에는 허용하지 않는다. standard 이상 verifier도 기본적으로 별도 Git worktree를 사용한다.

LLM이 담당하는 부분:

- 사용자 의도 해석
- 의미 단위 task decomposition
- 필요한 capability 선택
- evidence를 바탕으로 한 retrospective

Node.js가 담당하는 부분:

- prompt의 bounded first-pass classification
- exact-ID inventory
- route candidate 계산
- provider command 생성
- process 실행과 timeout
- receipt shape validation
- verifier command replay와 attestation
- atomic state와 journal repair
- retrospective와 proposal consent 저장

자연어 의미를 흉내 내는 대형 규칙 엔진은 만들지 않는다.

## 4. Risk-first route

route는 두 단계로 수행한다.

### 4.1 안전·적합성 필터

1. enabled provider/model
2. role와 task kind
3. allow/deny provider/profile
4. task complexity와 model-effort compatibility
5. risk별 provider trust tier
6. risk별 capability trust tier
7. adapter maturity
8. critical task의 challenger 금지
9. task hard constraints

기본 정책:

| Risk | Provider/adapter | Capability | Verification isolation |
|---|---|---|---|
| low | trusted/reviewed/untrusted, experimental 가능 | 명시적 opt-in이면 untrusted read-only 가능 | same workspace |
| standard | trusted/reviewed, experimental 허용 범위 내 | trusted/reviewed | Git worktree |
| high | trusted/reviewed, stable 우선 | trusted/reviewed | Git worktree |
| critical | trusted + stable only | trusted only | Git worktree |

### 4.2 후보 품질 선택

안전 필터를 통과한 model profile과 effort 조합만 비교한다.

최근 evidence 가중치:

\[
w_i=2^{-a_i/h}
\]

보수적 예상 성과는 bootstrap prior, 최근 independent review, uncertainty penalty를 결합한다. task의 `minimumQuality`, `maxTokenIndex`, `maxLatencyIndex`를 먼저 적용하고 `routingPriorities` 순서로 동등 후보군을 축소한다. 최종 tie는 stable identity로 결정론적으로 해소한다.

route는 절대적인 모델 순위가 아니라 **현재 task와 risk policy 안에서의 선택**을 설명한다. 성과 evidence는 provider, profile, model, effort, task kind, role뿐 아니라 risk와 complexity까지 일치할 때만 적용해 저위험 성공이 고위험 작업을 부당하게 승격시키지 않게 한다.

## 5. 동적 model/provider catalog

model/provider는 config data다.

```text
provider adapter
provider trust tier
adapter maturity
model profile
supported roles and task kinds
effort variants and supported complexities
bootstrap prior
token/latency indices
model maturity
```

새 모델 세대는 새 profile ID를 사용해 과거 observation과 분리한다. 같은 alias의 동작이 바뀌더라도 최근 observation이 오래된 evidence를 감쇠한다.

stdin/stdout 계약을 만족하는 신규 CLI는 generic adapter로 추가할 수 있다. provider 고유 sandbox나 output schema가 필요한 경우에만 전용 adapter를 작성한다. experimental adapter는 critical 작업에서 제외한다.

`aorch doctor`는 executable, catalog, state integrity를 검사한다. 계정별 entitlement는 bounded canary 또는 provider-native listing으로 별도 확인한다.

## 6. Capability supply-chain boundary

runtime inventory가 실제 설치된 skill, plugin, hook을 발견한다. LLM은 inventory에 없는 ID를 만들 수 없다. 서로 다른 capability type이 동일 ID를 사용하면 type shadowing을 허용하지 않고 ambiguous ID로 fail closed한다.

각 capability는 다음 trust tier 중 하나를 가진다.

```text
trusted
reviewed
untrusted
```

project-local discovery는 기본 reviewed, user-global discovery는 기본 untrusted다. discovery는 config가 명시한 trust를 자동으로 높이지 않는다. inventory description은 bounded metadata로만 노출하고 untrusted description은 숨긴다.

- skill: 작업 절차와 전문 workflow
- plugin: 외부 도구 또는 데이터 연결
- hook: lifecycle guardrail과 context injection

많이 주입하는 것이 목표가 아니다. task에 필요한 최소 집합만 선택한다. untrusted provider는 `allowUntrustedProviders`, untrusted capability는 `allowUntrustedCapabilities`를 명시한 low-risk read-only task에서만 사용하며 secrets나 network authority를 주지 않는 것이 운영 원칙이다.

## 7. Evidence plane

worker는 bounded task만 수행하며 재위임하지 않는다.

worker receipt에는 다음 claim이 들어간다.

```text
status
summary
files inspected
files changed
commands + exit codes
criterion evidence
unresolved risks
confidence
```

receipt validation은 shape, acceptance criterion, worker-side verification, scope claim을 확인하지만 완료를 증명하지 않는다.

별도 verifier가 다음을 수행한다.

1. worker receipt hash 생성
2. 공개 `verificationCommands` 재실행
3. worker에게 공개하지 않은 `verifierCommands` 실행
4. 실제 Git diff와 claimed files 비교; 완료된 write claim은 Git evidence가 없으면 fail closed
5. bounded worker의 Git `HEAD` 변경 금지
6. worker 실행 전 linked-worktree 여부 검사; high/critical write의 in-place 실행 금지
7. risk 또는 task 설정에 따라 sterile Git worktree 사용
8. 명령·artifact hash를 포함한 immutable attestation 저장
9. 실패도 attestation으로 보존

완료 판단은 receipt가 아니라 verifier attestation과 필요한 independent review를 기준으로 한다. reviewer는 executor rationale이나 self-confidence보다 requirements, invariants, actual diff, verifier artifacts를 먼저 받아 shared blind spot을 줄인다.

## 8. Durable state

run state:

```text
running
→ completed | partial | blocked | failed | cancelled
→ reviewStatus: pending
→ post-run reflection
→ reviewStatus: complete
```

file-first 구조를 유지하되 다음 내구성을 갖는다.

- JSON: temp write → fsync → atomic rename
- JSONL: per-file lock, sequence, checksum envelope
- live PID를 보존하는 stale lock detection/recovery
- invalid JSONL tail repair
- active-run pointer validation
- `aorch doctor --repair`

active pointer가 존재하더라도 target run이 없거나 root 밖을 가리키거나 invalid JSON이면 unhealthy로 판정한다. repair mode는 invalid pointer를 제거한다.

DB와 daemon은 현재 필요하지 않다. file-first 인터페이스로 해결할 수 없는 동시성 요구가 확인되기 전에는 추가하지 않는다.

## 9. Progress

weighted estimate:

\[
P=\frac{\sum_i w_i f_i}{\sum_i w_i}\times100
\]

percentage는 보조 지표다. 함께 제공하는 상태가 더 중요하다.

```text
phase
confidence
blockers
evidenceCount
lastEvidenceAt
activeTaskIds
```

blocked/failed 상태를 percentage로 가리지 않고, ETA는 충분한 근거가 없으면 생성하지 않는다. 동일 run이 계속되면 최소 30분마다 상태를 보고한다.

## 10. Post-run learning loop

terminal run은 다음을 회고한다.

- 성공적으로 작동한 방식
- 실제 오류와 prevention rule
- 비효율적인 task boundary, context, route, capability, retry
- 현재 run이 만든 technical debt
- 기존 범위 밖 technical debt
- 사용자 feedback

retrospective는 `.aorch/learning/retrospectives/<run-id>.json`에 저장한다.

오류 lesson은 다음 조건을 만족해야 한다.

```text
type: negative | positive
status: advisory
scopeTags: non-empty
evidence: non-empty
confidence: 0..1
sourceRunIds: non-empty
expiresAt: valid future timestamp
promotedToPolicy: false
```

lesson은 90일 기본 TTL을 갖고 만료되거나 governance lint에 실패하면 retrieval에서 제외한다. root hook은 lessons를 읽지 않는다. root skill이 blocking path 밖에서 `aorch lessons --lint`와 query를 수행하고, 관련 advisory만 제한적으로 사용한다.

### 자동 가능한 영역

- 독립 검토 기반 model-performance observation
- retrospective revision
- 사용자 feedback 연결
- evidence가 있는 advisory lesson 갱신
- unreviewed session checksum logging

### 사용자 승인 필요 영역

- source code
- prompt
- hook
- skill
- plugin
- routing/policy
- dependency
- provider adapter
- unrelated project debt

proposal은 항상 다음 상태로 시작한다.

```text
status: pending
requiresUserApproval: true
applied: false
```

승인 후에도 in-band source mutation은 하지 않는다. 별도 bounded run에서 구현·테스트·review·verification을 거친다.

## 11. 기술부채 정책

현재 run이 만든 debt는 retrospective를 닫기 전에 resolved 상태와 resolution evidence가 필요하다. 기존의 unrelated debt는 현재 scope를 확장하지 않고 proposal로 남긴다.

이 정책은 cleanup을 무시하지 않으면서 “발견한 모든 문제를 한 작업에서 고친다”는 scope explosion을 막는다.

## 12. Hook 구성

### Claude Code

- `UserPromptSubmit`: 3초 제한의 thin classification/policy gate
- `Stop`: terminal run reflection gate
- `SessionEnd`: 누락 reflection checksum journal

### Codex CLI

- `UserPromptSubmit`: 3초 제한의 thin classification/policy gate
- `Stop`: terminal run reflection gate

Stop hook은 `stop_hook_active`를 확인해 반복 loop를 만들지 않는다. worker는 `AORCH_WORKER=1`, verifier는 `AORCH_VERIFIER=1`로 root hook을 우회한다.

## 13. 비목표와 부채 방지

- daemon 없음
- 외부 DB 없음
- dashboard 없음
- nested delegation 없음
- dynamic plugin auto-install 없음
- automatic source/policy mutation 없음
- root instruction file 자동 편집 없음
- worker self-score를 completion evidence로 사용하지 않음
- 사용자 승인 없는 외부 행동 없음

새 구성요소는 기존 task, route, receipt, attestation, run, retrospective 인터페이스로 표현할 수 없다는 실제 증거가 있을 때만 추가한다.
