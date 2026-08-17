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
