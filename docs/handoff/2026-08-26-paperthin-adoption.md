# paperthin 차용 검토 — 드림팀 3회차 (3-task 축소판)

**대상**: [paperthin](https://github.com/LilMGenius/paperthin) v0.17.4, MIT License, Copyright (c) 2026 LilMGenius. 28개 순수 Markdown 스킬, 런타임 코드 없음. 소스 고정 경로 `C:\Users\goyan\Downloads\paperthin-main`.
**실행**: `aorch dispatch`, 역할 3종 순차 (analyst → 교차-provider reviewer → ponytail). `examples/plan-oss-adoption.json`에서 T1 후보탐색·T4 라이선스를 analyst에 흡수해 5→3으로 축소 (포니테일 사전 검토 판정).
**일자**: 2026-08-26

## 결론

**paperthin에서 아무것도 가져오지 않는다.** analyst가 borrow 7건을 냈고, 교차-provider reviewer가 5건을 반박했으며, 생존한 2건(`catchup`, `aim`)은 ponytail이 글로벌 스킬 `resume-work`·`interview`로 "이미 있다"고 판정했다. 아무것도 복사하지 않으므로 **MIT 고지 의무는 발생하지 않는다.** 2차(이식) 계획은 작성하지 않는다.

인터뷰에서 열어 둔 세 층에 대한 답:

| 업그레이드 층 | 판정 | 근거 |
|---|---|---|
| 라우팅 엔진 이식 (`modelchk`) | 하지 않음 | `src/difficulty.js`·`src/router.js`가 이미 complexity/risk→route/effort를 실제로 고른다. modelchk는 provider·tier 선택을 거부하는 권고 전용이라 엔진에 넣으면 실제 route와 어긋날 수 있다 (T2 반박) |
| 역할·스킬 프롬프트 이식 (`sip`/`shower`/`prism`/`hate`) | 하지 않음 | Markdown 스킬은 `src/verify.js`가 소비하는 pass/fail 신호를 내지 못한다. `hate`의 "치명 반론 1개 + 최저가 반증"은 `aorch-reviewer.md`가 이미 요구하는 독립 반증의 좁은 변형이라 별도 스킬보다 한 줄 지시가 싸다 (T2) |
| 설치 병용 (`catchup`/`aim`/`nba`/`readchk`) | 하지 않음 | `nba`는 선언 순서 dispatch + `resume-work`가, `readchk`는 `interview`의 조사-후-질문 게이트 + task envelope가 대신한다 (T2). `catchup`·`aim`은 T3가 각각 `resume-work`·`interview`를 지목 (아래 표) |

## 실행 기록

| task | 역할 | 라우팅 | 신뢰도 | 검토 파일 | change guard |
|---|---|---|---|---|---|
| T1-analyse | analyst | `gpt-5.6-terra/xhigh` | 0.91 | 50 | 통과, 변경 0 |
| T2-challenge | reviewer (openai 고정) | `gpt-5.6-sol/high` | 0.94 | 38 | 통과, 변경 0 |
| T3-shrink | ponytail | `gpt-5.6-sol/high` | 0.96 | 30 | 통과, 변경 0 |

3건 모두 실제 워커 receipt. 실행 전후 `git status`는 동일(미커밋 ponytail 별칭 4파일만). 관측 원장 14행 그대로 — 검증 명령 없는 task는 설계상 관측을 남기지 않는다.

## T1 — 사실 수집 + 4축 분석 (analyst)

사실: depth 19 / breadth 2 / coil 6 / mesh 1. user-invoked(`disable-model-invocation`) 12종. 설치는 `npx skills add --global` + `~/.claude/skills/<name>` 심볼릭 링크; `scripts/session-check.cjs`는 SessionStart 훅으로 누락 스킬만 24시간 1회 안내, `catalog.cjs`가 카탈로그·탐색 경로를 담당. 글로벌 스킬 9개 전부 읽음.

4축 borrow/leave (T1 원안):

| 축 | borrow (전부 install-alongside 층) | leave |
|---|---|---|
| 사이징 | `modelchk` → `~/.claude/skills/modelchk` (사람용 사전 점검으로만) | 엔진 이식 — aorch는 quota·capability·품질추정으로 실제 profile을 고르므로 충돌 |
| 검증·적대 리뷰 | `hate`, `prism` | `sip`(6개 sibling 체인 + 작성자 세션 후수정 흐름을 전제), `shower`(artifact-only 독자를 보장할 prompt builder 없음), `macrothink`, `feynman`(반복 인간 대화형) |
| 사이클 학습 | `catchup`, `nba` | `re0-loop`/`re0-memo`/`re0-work` — 자율 반복·v0 재시작·negative corpus archive가 "실패 시 중지, 범위 밖 변형 금지"인 aorch 실행 모델과 충돌 |
| 스코프 위생 | `readchk`, `aim` | `autobahn` — carve/approval/ledger가 별도 governance 체계가 됨. 현행 risk gate에 맞는 좁은 prompt rule이 낫다 |

검증축 중립 판정(T1): sip/shower/prism이 더하는 것은 "post-write 위생 묶음", "요구사항 모르는 독자의 이해 점검", "렌즈 간 불일치와 그것을 푸는 질문 1개"이며, 이것들이 자동으로 빈틈을 증명하지는 않는다. 명령 없는 task를 receipt·diff로 오케스트레이터가 판단하는 것은 루트 스킬이 선언한 의도.

설계 충돌 8건 중 핵심: 글로벌 심볼릭 링크 설치는 `src/inventory.js`가 Claude 전용 경로로 보므로 Codex 워커에게는 닿지 않는다 — 설치 병용 층조차 provider 중립이 아니다.

라이선스 단락: MIT 전문 인용. verbatim·수정 복사 시 루트 `NOTICE`에 `paperthin — https://github.com/LilMGenius/paperthin — MIT — Copyright (c) 2026 LilMGenius` 항목 + 전문. 독립 재작성은 의무 없음. **이번 결론(복사 없음)에서는 불필요.**

## T2 — 반박 (reviewer, 교차 provider)

7건 중 5건 반박, 2건 생존. 저장소 대조로 확인한 것:

- **REFUTED** `modelchk`, `hate`, `prism`, `nba`, `readchk` — 각각 `src/difficulty.js`+`src/router.js`, `aorch-reviewer.md`, reviewer 점검 축 중복, 선언 순서 dispatch+`resume-work`, `interview`+task envelope가 대신한다.
- **SURVIVED** `catchup` — `resume-work`는 복원 후 실행까지 하므로 "실행 없는 재진입 브리핑"은 구별된다. 단 대화형 전용.
- **SURVIVED** `aim` — 얇은 입력에서 의도 추론 + 행동 1개 제안 + 확인만 요구하는 상호작용이 글로벌 스킬에 없다. 대화형 전용.
- 검증축: `src/verify.js`는 명령 프로세스 상태로만 pass/fail을 내고, `src/run-loop.js`는 명령 없으면 `verification: null`에 `passed: true`를 기록한다. Markdown 스킬을 설치해도 기계 게이트는 변하지 않는다.

## T3 — 축소 판정 (ponytail)

| 생존 항목 | 이미 있는 것 | 없으면 깨지는 것 |
|---|---|---|
| `catchup` | `C:\Users\goyan\.claude\skills\resume-work\SKILL.md` (TaskList→plans→git 복원), `src/branch-status.js` (Git 상태 수집) | 없음. "실행 안 하는 용어집형 브리핑" 요구는 미입증. 수요가 생기면 `resume-work`에 status-only 분기 하나 |
| `aim` | `C:\Users\goyan\.claude\skills\interview\SKILL.md` (조사→관찰→AskUserQuestion), 루트 스킬의 "task 경계 전 문맥 확인" | 없음. "절대 질문하지 않기"는 paperthin 취향이지 요구가 아님. 원하면 `interview`에 한 문장 |

## 이 실행이 드러낸 우리 쪽 문제

**receipt 판정이 dispatch에 반영되지 않는다 (T2 지적, 직접 확인).** `schemas/worker-receipt.schema.json:5`는 `status: complete|partial|blocked`를, criteria는 `pass|fail|not-run`을 허용하지만, `src/` 안에 `receipt.status`를 읽는 코드가 0건이고 `src/dispatch.js:97`은 워커가 예외를 던지지 않으면 무조건 `complete`로 표시한다. 즉 reviewer가 `blocked`로 돌아와도, criteria에 `fail`이 있어도 다음 task로 넘어간다. `test/run-loop.test.js`는 명령 없는 실행이 `passed: true`를 남기는 것을 기대하고, blocked receipt가 dispatch를 멈추는지 확인하는 테스트는 없다. 검증 명령 기반 게이트 설계와 모순되지는 않지만(그 게이트는 명령이 있을 때만 작동), **명령 없는 review task의 유일한 기계 신호(receipt status)가 버려지는 것**은 설계 의도라기보다 누락에 가깝다. 별도 판단 대상.

**수정 (08-27):** `src/run-loop.js`에 `receiptVerdict()`를 추가했다. change guard 옆에 두어 `aorch exec`·`dispatch` 양쪽에 걸리고, `failChangeGuard`와 같은 모양으로 던지므로 dispatch.js는 기존 catch가 그대로 흡수한다 (포니테일 검토가 첫 초안의 dispatch.js 배치를 이 자리로 옮겼다). change guard·verify 게이트를 통과한 뒤 receipt가 `partial`/`blocked`이거나 criteria에 `fail`이 있으면 그 task를 `failed`(`receiptStatus`, `error` 포함)로 기록하고 계획을 멈춘다. 워커 자신의 판정이라 escalation 대상이 아니며 사람에게 돌아간다. `not-run`은 통과. `test/run-loop.test.js`에 blocked·criterion fail·all-pass 3건 추가, 루트 스킬 7항 문구 갱신. `npm run check` 276 pass.

**run 디렉터리가 task마다 분리된다.** T2·T3는 선행 task의 receipt를 "같은 이름의 최근 run 디렉터리 검색"으로 찾았고 T3는 생성 시각 차이(0.49초)로 연결을 추정했다. 동작은 했지만 선행 receipt 경로가 후행 task 프롬프트에 명시적으로 들어가지 않는다. ECC 때도 같은 구조였다.

## 드림팀 평가 (3회차 — 5→3 축소의 영향)

**값을 낸 단계**: 이번에도 T2(교차-provider 반박). 7건 중 5건을 저장소 대조로 걷어냈고, 부수적으로 receipt.status 미소비를 찾아냈다 — 조사 목표 밖의 결함을 리뷰어가 잡은 두 번째 사례(ECC 때는 verification 빈 배열).

**축소가 잃은 것**: 없다고 판단한다. T1 analyst가 사실 수집과 라이선스 단락을 흡수해도 신뢰도 0.91에 50파일을 읽었고, 라이선스 단락은 결론(복사 없음)에 충분했다. ECC 자체 평가가 예측한 대로 T1-survey·T4-licence는 대상 고정 상황에서 불필요했다.

**축소가 바꾼 것**: T1의 borrow 7건은 전부 "install-alongside" 층이었다 — analyst가 엔진·프롬프트 이식을 스스로 leave로 보낸 것이다. 사전 관찰이 넣은 "modelchk는 형식만 남을 것", "coil은 글로벌 스킬과 겹침"은 둘 다 워커가 독립적으로 도달했다.

**미검증**: 여전히 다중 후보 researcher, write 작업이 섞인 파이프라인, escalation 발동(이번엔 검증 명령이 없어 발동 불가).

## 원본 증거 경로

- T1: `.aorch/task-runs/95b9c6fc-53e6-4d2a-ac35-42115e9d00c7/T1-analyse/`
- T2: `.aorch/task-runs/0dfbbe6e-6d06-4de3-8c13-10baab54f067/T2-challenge/`
- T3: `.aorch/task-runs/615b98a8-a1a2-43f3-8395-cb36f771debe/T3-shrink/`
- 계획 파일: 세션 스크래치패드 `paperthin-adoption.plan.json` (3-task, 전부 `write:false` + `forbiddenScope: ["**/*"]`)
