# Adaptive Orchestrator Design

## 1. 최상위 목표

이 도구는 개인용 두 구독 CLI(Claude Code + Codex CLI)를 위한 **다운시프트 판단 층**이다. 목적함수는 **사용자 개입 최소화**와 구독 한도 절약이며, 품질 바닥선(`minimumQuality`)이 그 하한을 지킨다. 2026-08-16에 "시간과 구독 한도 절약"에서 개정됐다 — 벽시계 시간보다 사람이 다시 손대는 횟수를 줄이는 쪽을 택한다.

사용자는 호스트 CLI에 일반 프롬프트를 입력한다. 얇은 정책 게이트가 요청을 분류하고, substantive work라면 호스트 모델(리드)이 요청을 독립 검증 가능한 작업으로 분해해 **aorch가 정한 계획 스키마**(`schemas/task-plan.schema.json`)로 낸다. `aorch decompose`가 그 계획을 검증하고 `aorch dispatch`가 각 작업을 역할 에이전트에 배정해 실행한다. aorch는 계획의 각 작업에 대해 다음 조합을 판단하고 실행한다.

```text
provider
model
reasoning effort
skill / plugin / hook
permission / scope / isolation
verification / escalation
```

시스템의 주된 책임은 **작업별 등급 판정과 그 판정의 강제**다. 더 많은 agent를 만드는 것 자체는 목표가 아니다.

## 2. 제작 우선순위와 런타임 정책의 분리

이 소스를 제작할 때의 우선순위는 다음이다.

```text
구현 품질 >> 토큰 효율 > 제작 시간
```

이 기준은 소스 제작 과정의 기준이며 런타임의 모든 task에 강제되는 전역 함수가 아니다.

런타임 route는 다음을 고려한다.

- acceptance criteria
- task kind와 role
- complexity
- risk
- required capability
- provider compatibility와 adapter maturity
- 최근 독립 검토 성과와 verify-gate 관측
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
Host CLI + adaptive-orchestrate skill (리드가 분해 → aorch 스키마로 강제)
  ↓
서브태스크마다: aorch classify → 등급 판정
  ├─ 리드가 서브에이전트를 직접 띄우면 PreToolUse subagent-gate가 등급 강제
  └─ 워커 위임이면 task envelope 작성
  ↓
aorch exec (run loop)
  ├─ route (limits의 forbiddenProviders 반영)
  ├─ Claude CLI | Codex CLI | Generic CLI 워커 1회 실행
  ├─ actual/claimed diff + scope + read-only + HEAD change guard
  ├─ verificationCommands 실제 실행 (verify 게이트)
  ├─ 실패 → 같은 provider의 escalation 사다리 상향 (attempt ≤ 3)
  ├─ rate-limit → limits 기록 후 남은 provider로 재선택
  └─ verify 결과를 관측으로 자동 기록
  ↓
Receipt + verification evidence → 리드가 diff 검토 → 통합
```

blocking hook은 inventory, route scoring, provider execution을 수행하지 않는다. 이 작업은 root skill과 aorch CLI가 수행한다. 모든 write task는 이미 격리된 환경이 아니라면 독립 worktree에서 실행하며, `aorch exec`가 linked-worktree 여부를 검사한다. low/standard in-place 예외는 명시적 사용자 승인과 `allowInPlaceWrite: true`가 있어야 하며 high/critical write에는 허용하지 않는다.

LLM이 담당하는 부분:

- 사용자 의도 해석
- 의미 단위 task decomposition (형식과 실행은 aorch가, 의미 분해는 리드가)
- 필요한 capability 선택

Node.js가 담당하는 부분:

- prompt의 bounded first-pass classification (`gate.mjs`)
- objective의 난이도·종류 분류 (`difficulty.js`)
- route candidate 계산과 서브에이전트 등급 강제
- provider command 생성, process 실행과 timeout
- Git change guard, verification 명령 실행 게이트와 escalation
- provider limits 상태와 크로스 fallback
- atomic state 기록

자연어 의미를 흉내 내는 대형 규칙 엔진은 만들지 않는다.

## 4. 난이도 분류와 다운시프트

`aorch classify`는 objective 한 줄을 정규식 우선순위 규칙으로 `kind`(documentation/testing/implementation/exploration/research/debugging/architecture/security/…)와 `complexity`(low/standard/high)로 분류한다.

- 바닥선은 complexity가 결정한다: `low 0.72 / standard 0.80 / high 0.88`.
- low/standard는 `routingPriorities: [tokens, quality, latency]`로 다운시프트를 켠다. high는 quality-first를 유지한다 — security/architecture가 다운시프트되지 않는 것은 **의도된 동작**이다.
- 기본 provider는 anthropic이다(Claude Code 서브에이전트의 모델은 Codex 모델일 수 없다). 크로스-provider 호출자는 `--providers`로 개방한다.
- 경계는 `test/downshift-matrix.test.js`가 실제 packaged config로 회귀 고정한다.

### 서브에이전트 등급 강제 (PreToolUse)

`subagent-gate.mjs`는 리드가 Task/Agent 도구로 서브에이전트를 띄울 때 objective(description + prompt 첫 줄)를 classify하고, 모델 미지정·과등급 스폰을 정확한 모델 안내와 함께 차단한다(deny). 안내대로 재시도한 스폰은 등급 비교를 통과하므로 상태 없이 1회 수렴한다.

이 게이트는 **비용 최적화이지 안전장치가 아니다**. 그래서 모든 실패 경로는 fail-open이다: 잘못된 입력, classify 실패, 미인식 모델은 통과시킨다. `AORCH_NO_ENFORCE=1`이 탈출구다.

## 5. Risk-first route

route는 두 단계로 수행한다.

### 5.1 안전·적합성 필터

1. enabled provider/model
2. role와 task kind
3. allow/deny provider/profile (활성 limits는 forbiddenProviders로 주입됨)
4. task complexity와 model-effort compatibility
5. adapter maturity (experimental adapter는 risk 상한 내에서만)
6. critical task의 challenger 금지
7. task hard constraints (`minimumQuality` 등)

기본 정책:

| Risk | Adapter | Write isolation |
|---|---|---|
| low | experimental 가능 | same workspace (또는 `allowInPlaceWrite`) |
| standard | experimental 허용 범위 내 | linked worktree 권장, in-place는 opt-in |
| high | stable 우선 | linked worktree 필수 |
| critical | stable only | linked worktree 필수 |

### 5.2 후보 품질 선택

안전 필터를 통과한 model profile과 effort 조합만 비교한다.

최근 evidence 가중치:

\[
w_i=2^{-a_i/h}
\]

보수적 예상 성과는 bootstrap prior, 최근 관측, uncertainty penalty를 결합한다. task의 `minimumQuality`, `maxTokenIndex`, `maxLatencyIndex`를 먼저 적용하고 `routingPriorities` 순서로 동등 후보군을 축소한다. 최종 tie는 stable identity로 결정론적으로 해소한다.

route는 절대적인 모델 순위가 아니라 **현재 task와 risk policy 안에서의 선택**을 설명한다.

### 5.3 forcedRoute

escalation은 `forceRoute`로 프로필·effort를 직접 지정해 일반 라우팅의 complexity/kind 적합성 필터를 **의도적으로 우회**한다. 사다리는 사람이 작성한 복구 경로이고, 그 프로필은 일반 라우팅에서 일부러 잠가둔 것일 수 있기 때문이다(아래 Fable 잠금).

## 6. 동적 model/provider catalog

model/provider는 config data다.

```text
provider adapter
adapter maturity
model profile
supported roles and task kinds
effort variants and supported complexities
bootstrap prior
token/latency indices
model maturity
```

새 모델 세대는 새 profile ID를 사용해 과거 observation과 분리한다. stdin/stdout 계약을 만족하는 신규 CLI는 generic adapter로 추가할 수 있다. experimental adapter는 critical 작업에서 제외한다.

### Fable critical-잠금 트릭

`claude-fable-apex` 프로필은 유일한 effort가 `complexities: ["critical"]`로 잠겨 있다. classify는 critical complexity를 내지 않으므로 **일반 라우팅은 이 프로필을 절대 선택하지 못한다**. escalation의 `forcedRoute`만 이 잠금을 우회해 접근한다. 이것은 비직관적이지만 의도된 설계다: 최고가 모델이 높은 품질 prior로 일반 quality-first 라우팅을 하이재킹하는 것을 막으면서, 실패 복구 경로에는 열어둔다.

## 7. Change guard, verify 게이트와 escalation

worker는 bounded task만 수행하며 재위임하지 않는다. worker receipt는 status, files changed, commands, criterion evidence, confidence를 담은 **claim**이다.

`aorch exec`의 run loop는:

1. 워커 전후의 Git snapshot을 비교한다. write 작업은 actual files와 `receipt.filesChanged`가 정확히 일치하고 `allowedScope` 안이며 `forbiddenScope` 밖이어야 한다. read-only 작업은 변경이 없어야 하고 모든 작업에서 `HEAD`가 같아야 한다. 기존 dirty 파일은 status뿐 아니라 working-tree/index fingerprint도 비교하며, orchestrator가 자체 evidence를 쓰는 configured state root는 비교에서 제외한다.
2. change guard 위반은 `verificationCommands`, escalation, rate-limit fallback보다 먼저 중단하고 증거와 함께 사람에게 반환한다. 이미 변형된 worktree는 더 강한 모델 재시도로 복구할 수 없기 때문이다.
3. change guard 통과 뒤 작업이 선언한 `verificationCommands`를 플랫폼 셸로 실제 실행한다(`AORCH_VERIFIER=1`, timeout은 `verification.commandTimeoutMs`). 하나라도 실패하면 완료를 거절한다. 첫 실패에서 멈춰(fail-fast) 증거가 뒤 명령 출력에 묻히지 않게 한다.
4. verify 실패는 같은 provider의 `escalation.ladders`에서 다음 단계를 `forcedRoute`로 잡아 재실행한다 — Claude: opus/high → fable/high, Codex: sol/high → sol/xhigh. 재실행 task는 `id.escN` 클론이며 실패 증거(마지막 실패 명령과 stderr tail ≤ 2KB)를 objective에 첨부한다. 이미 시도한 route는 건너뛴다.
5. 총 attempt는 `escalation.maxAttempts`(기본 3)를 넘지 않는다. 사다리나 예산이 소진되면 **증거와 함께 사람에게 반환**한다 — 조용한 재시도 루프는 없다.
6. 각 attempt의 change guard와 verify 결과는 `runDir/verification.json`에 기록된다.

`verificationCommands`가 없는 작업도 change guard를 거쳐 1회 실행되고 evidence를 남긴다. Git 저장소 밖의 read-only 작업은 기존 호환성을 위해 실행하되 guard가 `not-git-repository`로 기록된다. change guard는 경로·scope·HEAD 대조이고, diff의 의미적 정확성은 여전히 리드가 검토한다.

## 8. Provider limits와 크로스 fallback

`.aorch/limits.json`은 `{provider: {limitedUntil, source, note}}` 상태 파일이다. 만료는 읽기 시점의 타임스탬프 비교로 처리하므로 데몬이 필요 없다.

- `aorch limits set <provider> --minutes N`이 1차 경로(수동 토글)다.
- run loop는 워커 실패 출력에서 rate-limit 패턴을 감지하면(best-effort) 자동으로 limit을 기록하고, 해당 provider를 forbidden 처리한 뒤 남은 provider에서 route를 재선택한다(크로스 fallback). rate-limit이 아닌 실패는 그대로 전파한다.
- route/exec는 활성 limits를 task의 `forbiddenProviders`로 주입한다. 후보가 전부 사라지면 라우터의 정상 "no eligible route" 에러가 표면화된다 — 조용한 우회는 없다.

**정직한 한계**: 실제 provider 한도 메시지 포맷은 아직 fixture로 고정되지 않았다. 이벤트 발생 시 캡처해 패턴을 조이는 것이 후속 작업이다. limits 파일은 비용 상태이지 안전 통제가 아니므로, 손상된 파일은 빈 상태로 읽는다.

## 9. 모델 성능 관측

관측치는 `.aorch/observations.jsonl`에 append하며 **provider·model·effort·taskKind 4차원**으로 매칭한다. 8차원은 솔로 볼륨에서 같은 셀이 거의 안 차서 학습이 영원히 prior에 머무르므로 4차원으로 축소했다. 최근 관측이 오래된 evidence를 30일 반감기로 감쇠한다.

관측 소스는 둘이다:

1. **독립 검토** — `aorch record`. worker self-score는 evidence가 아니다.
2. **verify-gate 자동 기록** — 유일한 비인간 관측 소스 예외. verify 게이트의 pass/fail은 객관적 신호이므로 quality 1.0/0.2, `metadata.source: 'verify-gate'`로 자동 append된다. 이것이 다운시프트 확장의 자연 복원 안전망이다: 다운시프트된 모델이 반복 실패하면 conservative 추정치가 바닥선 아래로 내려가 라우팅이 스스로 상위 모델로 복귀한다.

하네스 자체(source, prompt, hook, skill, plugin, routing/policy, dependency, provider adapter)는 운영 작업 중 자동 수정하지 않는다.

## 10. 기술부채 정책

현재 run이 만든 debt는 완료를 주장하기 전에 해결한다(사용자가 명시적으로 수용한 경우 제외). 기존의 unrelated debt는 현재 scope를 확장하지 않고 사용자에게 보고한다.

## 11. Hook 구성

### Claude Code

- `UserPromptSubmit`: 3초 제한의 thin classification/policy gate
- `PreToolUse` (matcher `Task|Agent`): 서브에이전트 스폰 등급 강제 (fail-open, `AORCH_NO_ENFORCE=1` 탈출구)

### Codex CLI

- `UserPromptSubmit`: 3초 제한의 thin classification/policy gate

Stop hook은 없다. Stop 게이트의 전제였던 durable run state는 프루닝에서 삭제된 평면이고, 완료 게이트는 이제 exec의 run loop 안에 산다. worker는 `AORCH_WORKER=1`, verification 명령은 `AORCH_VERIFIER=1`로 root hook을 우회한다.

## 12. 비목표와 부채 방지

- daemon 없음 (limits 만료도 읽기 시점 비교)
- 외부 DB 없음
- dashboard 없음
- nested delegation 없음
- dynamic plugin auto-install 없음
- automatic source/policy mutation 없음
- root instruction file 자동 편집 없음
- worker self-score를 completion evidence로 사용하지 않음
- 사용자 승인 없는 외부 행동 없음

새 구성요소는 기존 task, route, receipt, run-loop 인터페이스로 표현할 수 없다는 실제 증거가 있을 때만 추가한다.
