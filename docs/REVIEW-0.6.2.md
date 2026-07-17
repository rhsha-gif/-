# Adaptive Orchestrator v0.6.2 Critical Review

## 판정

v0.6.1의 bootstrap-only 구조와 fail-closed 경계는 타당했다. 그러나 실제 구현에
들어가기 전 마지막 적대적 검토에서, 새 기능이 아니라 기존 계약의 **정확성·안전성·
무결성 결함**이 다수 확인됐다. 특히 OpenAI/Codex 경로를 전부 막는 잠복 critical과,
orchestrator 종료 시 write 가능한 worker가 고아로 남는 문제가 있었다. v0.6.2는 새
subsystem을 추가하지 않고 이 결함들을 교정한다.

검토는 10개 독립 lens(core orchestration, state/persistence, security, concurrency,
CLI/config, prompt pipeline, verify/receipt/trace, cross-artifact, docs, test
quality)가 각각 결함을 제기하고, 각 결함을 적대적으로 재검증(refute-first)한 뒤
확인된 것만 수정했다.

## 발견하고 수정한 문제

| 심각도 | 문제 | 영향 | 수정 |
|---|---|---|---|
| Critical | 모든 OpenAI 컴파일 prompt가 자체 nested-delegation lint에 걸림 | compiler의 "do not create a nested orchestration loop" 문구가 lint를 유발해 `aorch exec`가 모든 Codex route에서 예외 | lint를 clause 단위로 재작성: 부정형 금지문(다중 동사 포함) 허용, 실제 양성 위임만 차단 |
| Critical | orchestrator 종료 시 detached worker 고아화 | SIGINT/종료 시 write 가능 worker가 계속 실행 | exit/SIGINT/SIGTERM/SIGHUP에서 자식 프로세스 그룹 회수 |
| High | worker 성공을 `exitCode===0`만으로 판정 | timeout·output 초과·abort 후 0으로 종료한 worker가 성공으로 세탁 | 정상 종료(`terminationReason` 없음)까지 요구 |
| High | attestation `evidenceDigest`를 redaction 전에 계산 | secret 형태 문자열을 담은 attestation이 저장본과 digest 불일치 → tamper 검증 실패 | redact → digest → persist 순서로 통일 |
| High | OpenAI Terra/Luna가 task `invariants`/`failureModes`를 폐기 | "절대 이중청구 금지" 같은 안전 제약이 worker prompt에서 조용히 사라짐 | 선언된 경우 모든 profile에 포함(Claude compiler와 동일) |
| High | 부분 read-only 부정문이 고위험 작업을 read-only로 강등 | "인증 우회 고쳐, 단 config는 건드리지 마"가 fail-open으로 오분류 | 절 단위로 부정 범위를 제한해 고위험 개발 작업 유지 |
| Medium | control-plane 예약이 before/after 스냅샷 사이에 상태파일 변경 | state dir가 git에 보이면 control-plane 작업이 자기 claim/protected 검사에 실패 | 예약을 스냅샷 이전으로 이동 |
| Medium | route observation·lesson 메모리가 보호 대상 아님 | hash chain은 well-formed 무단 append를 못 막아 routing 증거 오염 가능 | 기본 protected change surface로 포함 |
| Medium | `finishRun`에 terminal 가드 없음 | 종료된 run 재종료 시 status·review 상태 조용히 덮어씀 | 종료 상태 재종료 거부 |
| Medium | stale-lock 회수가 살아있는 lock을 밀어낼 수 있음 | mutual exclusion 붕괴·복구 불가한 journal 손상 | 회수 직전 identity 재확인 + no-clobber(link) 복원 |
| Medium | observation `complexity` 기본값이 라우터와 불일치 | complexity 없이 기록한 저/고/critical-risk 증거가 라우팅에서 무시 | risk 기반 기본값으로 라우터와 일치 |
| Medium | prompt-profile future-skew를 oldest 날짜에만 적용 | 하나의 미래 날짜 source가 오래된 source 뒤에 숨음 | future-skew는 newest, staleness는 oldest 기준 |
| Medium | `validatePromptProfile`이 malformed `rules.requiredSections` 허용 | 실행 시 lint의 `for...of`가 크래시 | 배열·비어있지 않은 문자열 검증 |
| Medium | `redactSecrets`가 복합 키·`--flag=value` 누락 | `access_token`/`client_secret`·`--token=...` 가 로그/receipt로 유출 | 복합 키 substring·등호 형식 포함 |
| Medium | `aorch exec` stdout이 비-redacted receipt/attestation 출력 | 저장본은 redact인데 터미널·CI 로그로 secret 유출 | stdout 출력도 redact |
| Medium | `redactValue`가 sensitive key 하위 배열·중첩 객체를 누출 | `{credentials:{data:...}}` 같은 secret이 redact 안 됨 | sensitive key는 shape 무관 전체 redact |
| Medium | promptProfileIds 없는 claude/codex 모델이 공식 컴파일 우회 | 문서화된 invariant를 어기고 generic prompt 사용 | officialSourcesOnly면 공식 provider 모델에 promptProfileIds 요구 |
| Low | `aorch record`가 명시적 `reviewed:false`를 true로 세탁 | 미검토 관측이 route evidence로 편입 | reviewed:false 거부 |
| Medium | `validateConfig`가 비-boolean `enabled` 허용 | `"enabled":"false"`가 truthy라 비활성화 실패 | boolean 강제 |
| Medium | `aorch verify --isolation`이 임의 문자열 수용 | 오타 시 조용히 same-workspace로 강등 | 미인식 값 거부 |
| Medium | doctor가 provider·model 0개 catalog를 pass 처리 | 라우팅 불가한 catalog를 정상으로 보고 | enabled provider·model 0개면 fail |
| Low | generic `promptMode:"argument"`가 prompt 폐기 | worker가 작업 없이 실행 | `{prompt}` placeholder 필수·없으면 fail-closed |
| Low | `**/x` scope가 top-level 파일 미매치 | 유효한 write claim 거부 | `**/` 를 선행 세그먼트 0개 이상으로 |
| Low | codex 영수증 파싱 실패 시에도 파일 삭제 | 유일한 claim 증거 파괴 | 파싱 실패 시 보존 |
| Low | progress가 실행 중 100% 반올림 | 0.99 상한 무력화 | 미완료 시 99% 상한 |
| Low | placeholder lint가 TODO/FIXME 언급을 오탐 | 정당한 작업이 hard-fail | 독립 stub 줄·템플릿만 차단 |
| Low | 만료된 lesson이 doctor/lint를 영구 fail | 정상 만료가 유지보수 없이는 실행 중단 | `doctor --repair`에서 만료 lesson prune |
| Low | 검증 명령 timeout 0/빈 값 허용 | 단일 명령이 무한 실행 가능 | verification timeout 양수 강제·runChecks에서 total deadline fallback |
| Low | doctor `--repair`가 pointer lock 없이 삭제 | `run start`와 경쟁해 방금 쓴 정상 pointer 삭제 | pointer lock 하에서 재검증 후 삭제 |
| Low | worker-receipt 스키마가 빈 문자열 허용 | validateReceipt와 불일치로 뒤늦은 실패 | `minLength:1` 로 정렬 |
| Low | 값 플래그 미지정·`--fraction=` 빈 값 | raw 크래시·진행률 0 리셋 | 명확한 오류 |
| Low | 종료 신호 timer callback의 kill 오류가 orchestrator 크래시 | `EPERM` 등이 uncaught로 전파 | 종료 경로에서 kill 오류 무해화 |
| Low | 설치된 SKILL.md·dry-run 출력의 legacy "direct lane" 잔재 | 설치 후 잘못된 workflow 학습 | 문구·필드 제거 |
| Low | codex scout agent가 미지원 effort 사용 | catalog가 지원하지 않는 terra 'low' | 지원 effort로 교정 + catalog 정합성 테스트 추가 |
| Low | README `maxPromptChars` 문서 드리프트 | 코드 키는 `maxChars` | 문서 정정 |
| Low | `aorch trace`가 없는 파일에 빈 요약·exit 0 | 실제(빈) trace처럼 읽힘 | 파일 부재 시 오류 |

## 유지한 통제

v0.6.1의 통제는 모두 유지된다: thin blocking gate, risk-first eligibility,
worktree write isolation, independent verifier attestation, ignored evidence
files, secret redaction, bounded process-tree execution, record-only shadow,
model revision/freshness observations, proposal-only self-improvement, one-time
scoped control-plane approval, lock/checksum/hash-chain durable state.

## 잔여 위험

### Control-plane proposal 예약

예약은 실행 프로세스의 try/finally에서 해제된다. orchestrator가 실행 중 하드
크래시하면 예약이 남을 수 있다. 동일 task ID 재실행으로 회수 가능하지만 별도 task나
`decide`는 막힌다. 예약 만료·명시적 release CLI는 후속 작업으로 남긴다(리뷰 단계에서
새 CLI 표면을 추가하는 위험보다 문서화가 낫다고 판단).

### 검증 workspace 재구성

`git-worktree` 검증은 attested 스냅샷이 아니라 실행 시점의 live HEAD+diff로
worktree를 만든다. exec 흐름에서는 worker 종료 직후이므로 창이 좁지만, 스냅샷과 실행
사이 변경에 대한 완전한 격리는 아니다.

### Prompt injection

reference-data 경계는 raw section injection을 막지만 데이터 내 자연어 명령을 모델이
의미적으로 따를 가능성은 남는다. 네트워크·secret·write 권한은 sandbox와 scope에서
계속 제한해야 한다.

### Local state integrity

Hash chain은 우발적 손상과 일부 로컬 재작성을 탐지하지만 외부 anchor·서명이 없다.
로컬 파일 전체를 제어하는 공격자에 대한 tamper proof를 주장하지 않는다.

## 검증

전 항목은 회귀 테스트로 커버되며, 핵심 수정은 원본 코드에서 실패하고 수정본에서
통과함을 확인했다(예: 고아 worker 회수, timeout 세탁, attestation digest,
OpenAI lint). 전체 스위트: `npm run check`.

## 결론

v0.6.2의 핵심은 기능 추가가 아니라, 합의된 계약을 실제 코드가 지키도록 만드는 것이다.
가장 중요한 교정은 (1) 모든 Codex 경로를 막던 lint를 고쳐 delegated 실행을 실제로
가능하게 하고, (2) 종료 시 고아 worker를 회수하며, (3) attestation과 secret 경계의
무결성을 복원한 것이다.
