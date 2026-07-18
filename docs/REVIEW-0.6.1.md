# Adaptive Orchestrator v0.6.1 Critical Review

## 판정

v0.6.0의 방향은 타당했지만, 합의한 bootstrap-only 구조와 실제 runtime 사이에 중요한 불일치가 남아 있었다. v0.6.1은 새 subsystem을 추가하기보다 이 불일치를 fail-closed 경계로 교정한다.

## 발견하고 수정한 문제

| 심각도 | 문제 | 영향 | 수정 |
|---|---|---|---|
| Critical | `direct/host-direct`가 host의 제품파일 수정을 허용 | 해석·실행·통합이 한 context에 결합되고 worker/verifier 경계 약화 | direct runtime 제거, `single-worker` delegated 1-call lane 도입 |
| Critical | 명시적 lane이 classifier보다 약해질 수 있음 | high/critical task가 bundled/single-worker로 강등 가능 | monotonic lane resolver 공유 |
| Critical | 외부 action과 local file edit를 같은 신호로 판단 | “수정하지 말고 deploy/push”가 read-only로 오분류 가능 | external-action veto를 별도 분류 |
| High | Catalog에 없는 provider를 암묵적 trusted/stable로 가정 | library direct use에서 공급망 fail-open | provider metadata 없는 route 제외 |
| High | Official profile domain만 확인하고 provider 소유권·freshness 미검사 | 다른 provider 문서나 오래된 guidance 사용 가능 | provider-bound publisher/domain + 120-day freshness |
| High | 첫 호환 profile이 stale하면 뒤의 fresh profile도 사용하지 못함 | 파일 정렬 순서 때문에 불필요한 전체 실행 장애 | fresh compatible profile 순차 선택 |
| High | OpenAI prompt에 `task.context`를 raw text로 삽입 | repository/external text가 새 OUTPUT/REQUIREMENTS 지시처럼 보일 수 있음 | quoted JSON reference data boundary; Claude XML policy/data 분리 |
| High | Worker prompt의 positive nested delegation 탐지 부족 | single-worker가 worker 내부에서 추가 model 호출 가능 | 모든 delegated lane에서 positive nested delegation lint |
| Medium | Schema·examples·skills가 legacy direct 계약을 계속 노출 | 설치 후 host가 잘못된 workflow를 학습 | schema/example/integration migration |
| Medium | Shadow route가 evidence처럼 보일 수 있음 | 실행하지 않은 모델의 성능을 과대해석 | `counterfactual-only`, external model call count, trace 명시 |
| Medium | Stale prompt guidance를 실행 시점에야 발견 | 장기 설치 후 갑작스러운 작업 실패 | doctor profile health check |
| Medium | Host context test가 새 bootstrap-only 필드를 반영하지 않음 | 전체 test suite 한 건 실패 | host normalization contract test 갱신 |
| Medium | Syntax checker가 source file마다 새 Node runtime을 생성 | 반복 릴리스 검증에서 불필요한 process startup이 누적되고 검증 시간이 커짐 | 단일 `vm.SourceTextModule` parser process로 교체하고 반복 실행 회귀 테스트 추가 |

## 유지한 통제

- thin blocking gate
- risk-first provider/capability eligibility
- worktree write isolation
- independent verifier attestation
- ignored evidence files
- secret redaction
- bounded process-tree execution
- record-only shadow
- model revision/freshness observations
- proposal-only self-improvement
- one-time scoped control-plane approval
- lock/checksum/hash-chain durable state

## 잔여 위험

### Prompt injection

Reference-data 경계가 raw section injection을 막지만 모델이 데이터 안의 자연어 명령을 의미적으로 따를 가능성은 남는다. 네트워크·secret·write 권한은 prompt가 아니라 sandbox와 scope에서 계속 제한해야 한다.

### Shadow quality

Record-only shadow는 counterfactual route일 뿐이다. 실제 성능 변화는 별도 read-only canary나 independent review에서 검증해야 한다.

### Model identity

Claude/Codex CLI가 실제 resolved model snapshot을 직접 노출하지 않으면 requested alias와 실제 backend revision 사이에 불확실성이 남는다. Catalog revision은 운영자가 provider change를 확인한 뒤 갱신해야 한다.

### Official guidance freshness

120일 fail-closed 정책은 오래된 guidance 사용을 막지만 maintenance가 없으면 실행 중단을 일으킨다. Doctor 결과를 정기적으로 확인하고 profile 변경은 benchmark와 승인 절차를 거쳐야 한다.

### Local state integrity

Hash chain은 accidental corruption과 일부 local rewriting을 탐지하지만 외부 anchor나 서명이 없다. 로컬 파일 전체를 제어하는 공격자에 대한 완전한 tamper proof를 주장하지 않는다.

## 결론

v0.6.1에서 가장 중요한 변화는 low-risk 호출 수를 다시 늘리는 것이 아니다. Host를 항상 bootstrap-only로 고정하면서도 low-risk 작업을 **한 task + 한 worker 호출 + deterministic verifier**로 유지한 것이다. 이는 context 격리와 증거 독립성을 보존하면서 불필요한 router/reviewer 호출을 막는다.
