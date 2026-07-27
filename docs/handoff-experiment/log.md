# 핸드오프 왕복 실측 로그

프로브: T-thin-exec-tests (envelope.json)
스펙: docs/superpowers/specs/2026-07-24-handoff-roundtrip-experiment-design.md

## 봉인(위임 전 — 블라인드 자기추정)

- 자기추정(내가 직접 하면): 75분 (사용자 봉인, "60분+" 버킷)
- 봉인 커밋: `5fd6fd8` (2026-07-24T21:55:17+09:00) — Codex 결과(23:09) 전 시점 고정

## 실측(2026-07-24 왕복 — 쿼터 조기 재충전으로 7/29 대기 없이 실행)

모든 수치는 회상이 아니라 **타임스탬프·커밋 해시에서 산출**했다(출처 병기).

| 항목 | 값 |
|---|---|
| 핸드오프 준비 시간 | **≤10분** (상한): envelope+log 작성 ≈4분37초(커밋 56baa98 21:50:40 → 봉인 5fd6fd8 21:55:17) + worktree 생성·디스패치 ≤5분41초(아래 왕복 창에 포함) |
| Codex 왕복 벽시계 | **≈5분41초**: worktree 체크아웃 mtime 23:03:26 → `test/task-runner.test.js` 생성 mtime 23:09:07 (probe worktree `~/.claude/jobs/50c8fd88/tmp/handoff-probe`) |
| 리워크 시간 | **0분**: 산출물이 무수정 채택됨 — aorch-v1 커밋 `8d5720e`(23:24:36)의 `test/task-runner.test.js`가 probe 산출물과 **바이트 동일**(diff 없음, 2026-07-28 재검증) |
| **순이득 = 추정 − (준비+리워크)** | **≥ +65분** (75 − ≤10 − 0) |
| acceptance 통과? | **4/4**: ①dry-run route+capabilities+commandSpec ②high-risk 비격리 거절 ③standard in-place 거절 ④신규 테스트 포함 그린 |
| verification(node --test) | **통과**: 89→93(+4) 전부 그린. 유일 실패는 기존 `cli-smoke.test.js` symlink EPERM(Windows 환경성, 소스 무관) — 조건 4는 "기존 EPERM 외 신규 실패 없음"으로 판정 |
| 관찰된 실패 모드 | **없음**: forbiddenScope(src/**, docs/**, integrations/**) 완벽 준수, 단일 파일만 생성. envelope에 없던 소스를 worktree에서 직접 읽음 → "worktree=파일상태 + envelope=의도" 가설 작동 |
| **부호 판정** | **(+)** — 준비 상한을 2배로 잡아도 부호 불변 |
| 다음 함의 | (+) 분기 → "envelope 품질 민감도" 실험. 팔2(Codex 위임 + 크로스 fallback) 게이트 해제. 운영 교훈: `codex exec`가 파이프 하에서 장시간 미종료 → 실 디스패치엔 프로세스 관리 필요 |

### 프로토콜 이탈 기록 (정직성)

- 계획은 "사람이 대화형 차가운 Codex 세션" 수행을 상정했으나, 실제는 **사용자 지시로 에이전트가 `codex exec --sandbox workspace-write` 헤드리스 실행**(codex-cli 0.144.4, 맥락 0·envelope 텍스트만 전달). 차가움(맥락 격리)은 유지됐고, 반사실(자기추정 75분)은 봉인 커밋으로 오염 없음.
- 시간 수치는 실시간 타이머가 아니라 **사후 타임스탬프 재구성**(파일 mtime + 커밋 시각). 부호 판정 목적(정밀 숫자 아님)에는 충분.
