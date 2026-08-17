# ECC 차용 검토 — 드림팀 첫 실전

**대상**: [ECC](https://github.com/affaan-m/ECC), MIT License, Copyright (c) 2026 Affaan Mustafa
**실행**: `aorch dispatch`, 역할 5종 순차. 계획 템플릿은 `examples/plan-oss-adoption.json`.
**일자**: 2026-08-17

## 결론

**ECC에서 코드도 표현도 가져오지 않는다.** 살아남은 항목이 8건 있었지만 전부 "이미 여기 있다"로 판정됐고, 두 건은 반박됐다. 아무것도 복사하지 않으므로 **MIT 고지 의무는 발생하지 않는다**(T4 판정).

결정 19의 세 항목에 대한 답:

| 검토 항목 | 판정 | 근거 |
|---|---|---|
| 변환 규칙 검증용 샘플 | **규칙이 맞다, 이식은 안 한다** | ECC 프리셋은 `tools:`와 `model: sonnet`을 선언한다. 그대로 쓰면 구조화 receipt가 죽고 라우터가 무력화된다 |
| `agent-evaluator` 개념 | **채택하지 않음 (반박됨)** | 5축 채점기를 직접 실행한 결과 **검증 키워드만 나열한 출력에도 5.0 만점**을 줬다. ECC 테스트에 이 evaluator 참조 없음. 한국어 Windows(cp949)에서 `UnicodeEncodeError`로 종료 |
| 멀티호스트 배포 구조 | **채택하지 않음** | 14타깃 manifest/adapter/build/state 체계는 어댑터 2개 요구에 과하다. 게다가 ECC CLI 자체가 `ajv` 미설치로 일곱 대상 전부 시작 전에 실패했다 |

## 실행 기록

| task | 역할 | 라우팅 | 신뢰도 | 검토 파일 |
|---|---|---|---|---|
| T1-survey | researcher | `gpt-5.6-terra/max` | 0.97 | 5 |
| T2-analyse | analyst | `gpt-5.6-terra/xhigh` | 0.91 | 40 |
| T3-challenge | reviewer (openai 고정) | `gpt-5.6-sol/high` | 0.94 | 30 |
| T4-licence | license-reviewer | `gpt-5.6-sol/high` | 0.94 | 3 |
| T5-shrink | ponytail | `gpt-5.6-sol/high` | 0.96 | 30 |

5건 모두 CLI 봉투가 아닌 **실제 워커 receipt**를 반환했다.

## T1 — 사실 수집 (researcher)

내 사전 조사보다 정확했고 두 가지를 정정했다.

- 저장소 URL은 `affaan-m/ECC`. 사전 추정 `AffaanMustafa/ECC`는 오답이었고 워커가 README 표기로 바로잡았다.
- 호스트 어댑터는 **18종**(`.claude` `.claude-plugin` `.codebuddy` `.codex` `.codex-plugin` `.cursor` `.gemini` `.github` `.hermes` `.kimi` `.kiro` `.openclaw` `.opencode` `.pi` `.qwen` `.trae` `.vscode` `.zed`, + 범용 `.agents`). 사전 집계 7종은 과소였다.
- 규모: `skills` 463, `docs` 1510, `scripts` 260, `tests` 262, `rules` 122, `commands` 94, `agents` 68(전부 `.md`).
- 라이선스 MIT를 LICENSE 파일 9줄 직접 인용. 최근 커밋 2026-08-16(`06c5e11`).

프리셋 지시("순위 매기지 마라")를 그대로 지켜 *"순위·추천·코드 품질 평가는 하지 않았으며"*로 명시했다.

## T3 — 반박 (reviewer, 교차 provider)

**이 단계가 값을 냈다.** T2의 주장 중 2건을 반박했고, 서면 검토가 아니라 직접 실행으로 확인했다.

- T2의 verification이 `passed: true`지만 `results: []`(검증 명령 0건)임을 스스로 발견하고, **T2의 자신감이 아니라 파일과 새 실행 결과에 근거하겠다**고 선언한 뒤 진행했다.
- **REFUTED** — 5축 evaluator 차용 가치: `evaluate.py`를 실제로 돌려 키워드 나열 출력이 5.0을 받는 것을 확인.
- **REFUTED** — T2가 보고한 installer 실행 결과("5 copy, 1 skip, 1 unsupported"): 재실행 시 4개만 copy, OpenCode는 빌드 산출물 부재로 실패, Kiro는 unknown target. **T2 결과가 재현되지 않았다.**
- 안전 지적: ECC `build-error-resolver.md`가 `rm -rf node_modules package-lock.json`을 권한다(데이터 손실·재현성 위험).

## T4 — 라이선스 (license-reviewer)

- **그대로 복사 / 수정 후 복사**: 상류 LICENSE 전문(저작권 줄 + 무보증 조항 포함)을 루트 `NOTICE`에 별도 절로 넣고, 해당 코드를 담은 모든 배포물에 동봉해야 한다. 파일명·소스 헤더·광고 문구 의무는 없다.
- **학습 후 독립 작성**: 표현·코드를 복사하지 않았다면 고지 의무 없음. 다만 "충분히 독립적인가"는 라이선스 문언이 답하지 않는 분류 문제라고 명시.
- 현재 `NOTICE`에 Affaan Mustafa 항목은 없고, **이번 결론(아무것도 복사 안 함)에서는 필요하지 않다.**

## T5 — 축소 판정 (ponytail)

8개 항목 전부 "가져오지 않는다"로 판정하고, 각각에 대해 **이미 여기 있는 것**을 파일 경로로 지목했다.

| ECC 항목 | 이미 있는 것 |
|---|---|
| code-reviewer 증명 규칙 | `aorch-reviewer` + `src/run-loop.js`·`src/verify.js`·`src/change-guard.js` |
| code-explorer 보고 형식 | `aorch-researcher`·`aorch-analyst` + `src/providers/base.js` |
| build-error-resolver | `aorch-fixer` + `executeWithVerification`의 실패 증거 전달 |
| dispatchable explorer 역할 | 의도적 부재 — 루트 워크플로가 정찰 위임을 금지 |
| 전역 reviewer 강제·고정 체크리스트 | `src/task.js` 수용조건 + `src/router.js` risk 기반 선택 |
| preset `model:`/`tools:` | `selectRoute` → `src/task-runner.js` → 어댑터 |
| evaluate.py 5축 채점 | 수용조건 + receipt 스키마 + `src/verify.js` + `src/change-guard.js` |
| 멀티호스트 installer | `installProject` (지원 요구는 Claude·Codex 2종) |

그리고 세 번째 호스트가 실제 요구가 되면 **14타깃 프레임워크가 아니라 기존 installer에 분기 하나를 더하라**고 권했다.

## 이 실행이 드러낸 우리 쪽 문제 2건

**① 오케스트레이터가 워커를 오염시킬 수 있다 (1차 실행 실패).**
워커가 도는 도중에 같은 저장소에서 커밋해 `HEAD`가 움직였고, change guard가 `headChanged: true`로 잡아 실행 전체를 반환했다. escalation으로 복구되지 않는 위반이라 실행 1건이 통째로 낭비됐다. **운영 규칙**: `aorch dispatch` 실행 중 같은 저장소에서 커밋하지 않는다.

이건 가드의 결함이 아니라 가드가 제 일을 한 사례다 — 다만 잡힌 오염원이 워커가 아니라 오케스트레이터였다.

**② 검증 명령 없는 task는 관측을 남기지 않는다.**
이번 5개 task는 전부 분석·검토라 `verificationCommands`가 없었고, `src/run-loop.js`가 명령이 없으면 verify 게이트와 관측 기록을 건너뛴다. 결과적으로 **관측 원장이 13행에서 그대로**다. 루트 스킬이 이미 "검증 명령 없는 task는 게이트가 없다"고 밝히므로 설계대로지만, 계획 템플릿의 완료 조건이 "관측이 기록됨"을 가정한 것은 틀렸다.

T3이 바로 이 공백을 직접 지적했다는 점이 시사적이다 — 검증 없는 산출을 신뢰하지 말라는 지시가 실제로 작동했다.

## 드림팀 자체 평가

**값을 낸 단계**: T3(반박)이 압도적이다. T2의 재현 불가 주장을 잡아냈고, 채택 여부를 가르는 결정적 실측(evaluator 5.0 스푸핑)을 직접 수행했다. **교차 provider 고정**이 유효했다고 볼 근거다.

T5(ponytail)는 결론을 "아무것도 안 가져온다"로 수렴시키면서 각 항목에 대체물의 파일 경로를 붙여, 나중에 같은 논의가 재발할 때 근거가 남는다.

**값이 적었던 단계**: T4(라이선스)는 결론이 "복사 안 하므로 의무 없음"이라 사후적으로는 불필요했다. 다만 그건 T5의 결론을 미리 알아야 판단할 수 있는 것이라 순서상 낭비로 보기 어렵다. T1은 사실 수집으로서는 정확했지만 대상이 이미 정해진 상황이라 후보 탐색 능력은 검증되지 않았다.

**미검증**: 다중 후보 상황에서의 researcher, write 작업이 섞인 파이프라인, escalation 발동.

## 원본 증거 경로

- T1: `.aorch/task-runs/87137b01-979d-4007-816f-807ee263f88e/T1-survey/`
- T2~T5: `ecc-result3.json`의 각 `runDir` (세션 스크래치패드)

---

# 후속: ponytail 자기 감사 (같은 날)

우리가 **이미 차용한** 대상을 같은 드림팀으로 돌려 우리 적응본을 감사했다. 교차 방향을 뒤집어 분석은 `codex-terra/xhigh`, 반박은 `claude-opus/xhigh`로 provider를 갈랐다. P1~P3 완료, P4(축소 판정)는 실행 중 외부 중단 — 다음 세션에서 재개해 완료했다(아래 P4 절).

## 결과: 오늘 커밋한 프리셋에서 안전 결함 1건 발견

**P2가 P1을 3건 반박하면서** 우리 파일의 누락을 파일 대조로 입증했다.

| 항목 | 판정 |
|---|---|
| 축소 금지선 누락 | **결함 — 수정함.** 상류 `AGENTS.md:30`·`SKILL.md:92-95`가 신뢰 경계 검증·데이터 손실 방지·보안·접근성을 축소 대상에서 제외하는데, 우리 프리셋엔 해당 어휘 0건이었다 |
| 근본원인 추적 규칙 누락 | **결함 — 수정함.** `trace|caller|root cause` 0건 |
| 사다리 3단 누락 | **수정함.** 상류 7단 중 4단만 유지 중이었다(표준 라이브러리·플랫폼·단일 표현식 누락). P1은 2개라 했으나 실제 3개 |
| `NOTICE`의 "wording is our own" | **입증됨.** 기계적 n-gram 대조에서 공유 5-gram 0개, 4-gram 2개(기능적 상용구) |
| 벤치마크 재현성 | 재현 불가 결론 유지. 다만 상류는 이미 80~94%를 철회했고(`README.md:84` "the per-task ceiling, not the average") 현행은 `~54% (up to 94%)`. **우리 저장소가 상류 수치를 0건 인용한 것은 옳은 자세로 판정됨** |

반박자의 핵심 지적: *"read-only는 완화책이 아니다 — 판정이 후속 fixer task의 입력이 되기 때문."* 즉 "판정만 하고 수정은 fixer가" 구조가 오히려 잘못된 축소 권고의 위험을 키운다.

## P3 — 라이선스: 충분함

차용 형태는 수정 후 복사이고, 루트 `NOTICE`의 MIT 전문 + 두 프리셋 헤더로 의무가 충족된다. **변경 불필요.** 단 프리셋을 단독 배포하면 헤더만으로는 부족하고 `NOTICE` 블록이 동반돼야 한다.

## 수정 중 생긴 문제와 재수정

금지선을 넣으면서 상류 문구를 축자로 들여왔다(`trace the real flow end to end`, `can it be one line` — 공유 6-gram 2개 발생). `NOTICE`의 "문구는 우리 것" 주장이 약해지므로 다시 썼다. 재측정 결과 **공유 6-gram 0개, 5-gram은 attribution URL 하나뿐**. MIT는 축자 복사도 허용하므로 법적 문제는 아니었고, 내 `NOTICE` 문장을 참으로 유지하기 위한 수정이다.

## 드림팀 평가 (2회차)

교차 provider를 뒤집어도 반박이 작동했다 — 이번엔 opus가 terra의 분석에서 개수 오류·읽기 경계 미진술·병합 오판을 잡아냈다. **자기 감사 용도로 쓸 때 값이 가장 컸다**: 같은 세션에서 내가 방금 쓴 파일의 안전 결함을, 내가 아니라 워커가 찾았다.

## P4 — 축소 판정 (재개 후 완료)

중단됐던 P4를 단일 task 계획으로 재개했다(`gpt-5.6-sol/high`, 워커 receipt 정상, confidence 0.95, 검토 파일 33). P2 생존 항목과 `1fcb58e` 수정 사실을 objective에 인라인으로 넘겼고, 판정은 넷으로 수렴했다.

| 항목 | 판정 |
|---|---|
| 벤치마크 harness 차용 | **가져오지 않음.** 상류 harness는 상류 자신의 `SKILL.md`를 직접 로드해 쓰기 가능한 구현 에이전트를 평가한다 — 판정만 하는 우리 read-only 프리셋과 입출력 계약이 다르다. 정량 주장이 필요해지면 상류 복사가 아니라 우리 프리셋의 판정 정확도를 재는 별도 벤치마크가 필요 |
| 상류에만 남은 규칙·문구 | **추가 차용 없음.** 세션 persona·persistence·모드는 bounded task 구조에 불필요, lazy-first·ceiling comment는 "판정만 한다"는 역할과 충돌, 나머지는 현행 사다리·미작성 규칙이 이미 포괄 |
| `1fcb58e` 복구 | **확인됨.** 금지선(claude:30-36/codex:25-31)·추적 규칙·사다리 3단 전부 현행 파일에서 실측, 14개 문구 read-only 단언 통과 |
| NOTICE 정밀도 | **수정 가치 있음.** 유일한 수정 항목: NOTICE 10행을 "The `ponytail` role name and the behavioural rules of its presets"로 교체 — 역할명이 `schemas/task-plan.schema.json:45` 등 공개 표면에 퍼져 있어 현행 문구가 차용 범위를 과소진술 |

이 한 줄 수정은 write 파이프라인 도그푸딩의 실전 소재로 실행했다 — 그 경위와 발견은 `2026-08-17-dogfood-escalation-write.md`에 있다.
