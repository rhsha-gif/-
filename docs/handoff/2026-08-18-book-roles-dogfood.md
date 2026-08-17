# 도그푸딩: 책 제작 역할군 첫 실전

**일자**: 2026-08-18
**대상**: 신규 역할 writer/editor/qa-analyst + kind `writing` — 계획 `docs/plans/2026-08-18-book-production-roles.md` 작업 6.
**실행 환경**: 책 워크스페이스(`책 만들기`)에 합성 테스트 북 `books/aorch-dogfood`(픽스처 `minimal-v2` 복사, 8쪽 1장)를 만들어 실제 파이프라인을 격리 실행. 진행 중인 사람 작업(reading-english-poetry 미커밋 수정)과 분리하기 위한 선택.

## 라우팅 실측 (dry-run)

| task | 역할 | route | 의도 |
|---|---|---|---|
| B1-draft | writer | `codex-sol-deep` gpt-5.6-sol/high | 집필=최상위 ✓ |
| B2-edit | editor | anthropic 고정(교차) → sonnet 계열 | 편집=중간, 집필과 교차 provider ✓ |
| B3-accept | qa-analyst | `claude-haiku-scout` haiku/low | 판정=최저가 ✓ (tokens-first + minimumQuality 0.75) |

- kind `writing`은 저가 티어(haiku/luna)에 없어 **저가 모델이 원고를 잡는 것이 구조적으로 불가능**함을 라우터 회귀 테스트로 고정(`test/downshift-matrix.test.js`).
- B3의 "빠르고 싸게"는 tokens-first 선언으로 성립 — quality-first 기본값이면 luna/max로 떠서 팔1 교훈("라우터는 quality-first라 tokens-first는 선언해야 한다")이 재확인됐다.

## 구현 중 잡힌 함정

1. **설치본 config 정체(재발)**: dispatch는 `.aorch/config.json`을 읽는데 `install`이 기본으로 config를 보존해, 패키지에 추가한 `writing` kind·roleAgents가 설치본에 없어 `No eligible route`로 죽었다. `--force-config`로 해소(이 저장소·책 워크스페이스 모두). **미해결 개선 후보**: `update`는 agents/skills만 갱신하고 config 정체를 감지하지 않는다 — 카탈로그가 바뀔 때마다 같은 함정이 재발할 구조다.
2. **워크스페이스 스킬 노출 간극**: 책 스킬은 `.agents/skills/`(codex 관례)에만 있어 claude 워커가 네이티브 스킬로 호출할 수 없다 — 프리셋이 "SKILL.md 경로를 읽고 따르라"로 우회(계획 실행 중 조정으로 기록).
3. **책 저장소 `test:skills`와 aorch 설치 충돌**: aorch가 설치하는 `.agents/skills/adaptive-orchestrate`가 책 저장소의 "정확히 8종" 단언을 깨뜨렸다 — aorch 관리 스킬을 제외하도록 책 테스트 수정(책 저장소 커밋 `9f78fc6`).
4. **change guard git 스냅샷의 원인 불명 실패(1회)**: 1차 실 실행이 baseline 캡처에서 `Unable to capture Git state for change guard`로 죽었다. `runGit`은 명령당 10초 고정 타임아웃이고 에러가 어느 명령이 죽었는지 말하지 않는다. 직후 수동 재현은 전부 성공(0.4초) — 방금 만든 테스트 북의 OneDrive 콜드 캐시로 추정. **미해결 개선 후보**: 타임아웃 상향 또는 실패 명령·원인을 에러에 포함.
5. **write task와 worktree의 의존성 충돌**: 책 npm 검증 명령은 워크스페이스 `node_modules`가 필요해 linked worktree에서 깨진다 — 템플릿이 `allowInPlaceWrite: true`를 선언하고 근거를 objective에 남기는 것으로 해소.

## 실 실행 결과

**게이트 통과.** 세 역할 모두 실전에서 워커 receipt를 냈고, 파이프라인이 진짜 결함을 잡았다.

| task | route (실측) | 결과 |
|---|---|---|
| B1-draft | `gpt-5.6-sol/high` | attempt 1 통과. 8쪽 재집필, claimed=actual 8파일, guard 통과, conf 0.98. **unresolvedRisks에 "book:check는 overflow를 못 본다"고 스스로 경고** — 그게 정확히 뒤에서 터진 결함이다 |
| B2-edit | `sonnet/high` (anthropic 고정 — 집필과 교차) | attempt 1 통과. 직접 수정은 문장 1건(page-002 서법), **여러 파일에 걸친 용어 불일치('근거 그래프' vs 'claim graph')는 파일:행 근거와 함께 unresolvedRisks로 보고하고 손대지 않음** — 편집 경계 계약이 그대로 작동 |
| B3-accept (1차) | haiku/low → **escalation 낭비 실측**: opus/high → fable/high | `book:quickqa`가 7·8쪽 overflow(730/799 > 699px)로 3회 전부 실패. **QA가 집필 결함을 잡은 것 자체는 파이프라인의 성공**이고, read-only 판정자를 ladder로 올린 것이 낭비였다 |
| F1-overflow | 중간 티어 writer | 외부 중단 2회·10분 타임아웃 1회로 receipt는 유실됐으나 트림 자체는 대부분 수행(7쪽 해소, 8쪽 8px 잔여). **잔여 8px는 운영자가 직접 정리**(반복 중단으로 워커 재투입 비용이 무의미해진 시점) |
| F2-accept | `claude-haiku-scout/low` (tokens-first) | receipt 완성(conf 0.98): **filesChanged [], 열람 파일 qa-report.json 단 1개** — quick 모드라 스크린샷이 없고 기계 플래그도 0건이라 "열 것이 없음"을 규율대로 기록. verify(quickqa)는 타임아웃이 게이트를 죽여 verification.json은 없고, 동일 명령 수동 재실행으로 pass 확인 |

**관측 원장 최종 상태**: 정확히 2행 — `gpt-5.6-sol/writing q=1`, `sonnet/writing q=1`. write task만 기록된다.

## 이 실행이 낳은 구조 변경: read-only fail-fast 불변식

B3의 escalation 낭비는 08-17의 "검증 실패 원인이 작업 범위 밖이면 escalation은 낭비" 교훈의 세 번째 실측이고, 이번엔 **증명 가능한 형태**였다: change guard가 트리 무변경을 증명한 read-only task는 어떤 티어로 재시도해도 검증 결과를 바꿀 수 없다. `src/run-loop.js`에 반영:

- guard가 적용 가능하고(`applicable`) task가 read-only면 → 검증 실패 시 **ladder 없이 즉시 실패**(증거 경로 첨부)
- 같은 조건에서 **verify-gate 관측을 기록하지 않는다** — 통과든 실패든 저장소 상태의 성적이지 모델의 성적이 아니다 (haiku·opus·fable이 각각 허위 0.2를 받은 실측이 근거)
- guard 증명이 없는 환경(비-git)은 기존 동작 유지. 테스트 2건 추가(`test/run-loop.test.js`), 책 원장의 허위 0.2 3행은 제거

## 남은 위험·미해결

- **외부 중단 3회**(백그라운드 2회 killed + 10분 포그라운드 타임아웃 1회)의 원인 미상 — 책 dispatch만 반복적으로 당했다. F1의 receipt 유실이 그 비용. 장시간 dispatch의 실행 환경(백그라운드 정책·타임아웃 상한)은 별도로 볼 문제.
- `qa-analyst`의 열람 규율은 quick 모드(스크린샷 0장)에서는 스트레스 테스트가 안 됐다 — full `book:qa` 마일스톤에서 재확인 필요.
- change guard git 스냅샷 10초 타임아웃·원인 불명 에러(위 함정 4)와 `update`의 config 정체 미감지(함정 1)는 개선 후보로 남김.
- 합성 테스트 북 `books/aorch-dogfood`는 도그푸딩 증거로 책 저장소에 남아 있다(커밋 여부는 마감에서 결정).
