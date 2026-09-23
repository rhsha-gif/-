# 모델 업그레이드 — Opus 5.5 · GPT-6 sol/luna · Gemini 3.8 Flash (2026-09-23)

방향: Opus·Luna·Gemini 3.8 Flash를 더 적극적으로 쓰되, 그 전에 하네스를 공식 문서와 목적(사용자 개입 최소화 + 구독 리미트 절약, 품질 바닥선)에 맞게 정비한다. 인터뷰 3라운드와 포니테일 과잉설계 점검 2회로 확정했다. 4개 프로젝트 신모델 감사(런북 §4~§6)는 후속이다.

## 실측 (설치본·공식 문서)

| CLI | 버전 | 확인한 사실 |
|---|---|---|
| claude | 2.1.280 | `opus` = Opus 5.5(1M), 기본 effort `medium`. `--effort` low·medium·high·xhigh·max. `ultracode`는 help에서 빠졌고 경고 없이 수용(code.claude.com/docs/en/model-config) |
| codex | 0.153.4 | 설치 카탈로그 `gpt-6-astra`(ultra까지), `gpt-6-sol`(ultra까지), `gpt-6-luna`(max까지). `gpt-5.6-*`는 "Older". `gpt-6-terra` 없음. 문서 도메인이 learn.chatgpt.com으로 이동. `exec --full-auto`·`-a never`는 설치본에서 거부(어댑터는 둘 다 안 씀) |
| agy | 1.2.8 | `gemini-3.8-flash-{high,medium,low}`, 접미사가 곧 사고 수준. `--effort low|medium|high`는 같은 축 |
| grok | 1.0.30 | 인증 모델 목록은 `grok-4.7` 하나 |

하네스 상태(기준선 커밋 전): 미커밋 P2 복구 트리 408 통과·1 skip. 관측 `observations.jsonl` 14건(7~8월), 주간 학습 적격 0건.

## 포니테일 점검이 바꾼 것

- low/standard는 classify 경로에서 tokens-first다. prior를 올려도 Flash·Opus는 haiku·luna를 이기지 못한다. 그래서 "적극 사용"은 prior가 아니라 선호 규칙으로 구현했다.
- 쿼터 게이트·wide 모드는 `usageProbe`가 어느 설정에도 없어 도달 불가였다(`dispatch`는 `quota: null` 고정). 삭제.
- 관측 적격 0건은 코드 결함이 아니다. attestation 도입(09-14) 뒤 검증 게이트를 통과한 write 실행이 없었을 뿐이다. 코드 변경 없이 실전 실행으로 쌓는다.
- 규칙 파일은 `prefer`만 둔다. prior 보정·effort 덮어쓰기·활성화는 기존 카탈로그 손잡이와 중복이다.

## 결정

| 항목 | 결정 |
|---|---|
| 기준선 | P2 복구를 3커밋으로 먼저 커밋(8ffdc9a, 7ac8861, 7c30a6c) |
| Opus 5.5 | `claude-opus-deep`에 `medium` effort(standard) 추가 |
| Codex | 프로필 id 유지, luna→`gpt-6-luna`, sol→`gpt-6-sol`(둘 다 challenger), terra 은퇴 |
| Flash | base 슬러그 `gemini-3.8-flash`, validated kinds 구현·테스트·문서. 노가다(`grunt` 태그)는 규칙이 Flash로 보냄 |
| 배분 | `~/.aorch/allocation.json`의 `prefer` 규칙, 재설치 없이 반영, route 결정에 후보별 탈락 사유 |
| 쿼터·wide | 삭제, 설치본의 `quotaGate`는 `aorch configure` 안내와 함께 거부 |
| 에스컬레이션 | 사다리 전에 상위 모델(fable/astra)이 read-only로 1회 진단 |
| P1 | 검증 뒤 forbiddenScope 쓰기·read-only 추적 파일 수정 거부 |
| 전역 설정 | `modelSettings` 키 `claude-opus-5`→`claude-opus-5-5`(백업 `~/.claude/backups/2026-09-23-pre-model-upgrade/`) |

## 매핑표

| 경로 | 현재 값 | 새 값 | 승인 |
|---|---|---|---|
| config `codex-luna-repeatable.model` | gpt-5.6-luna | gpt-6-luna | 인터뷰 |
| config `codex-sol-deep.model` | gpt-5.6-sol | gpt-6-sol | 인터뷰 |
| config `codex-terra-general.enabled` | true | false | 인터뷰 |
| config `agy-flash.model` | gemini-3.8-flash-medium | gemini-3.8-flash | 인터뷰(접미사 통일) |
| config `grok-general.model` | grok-4.6 | grok-4.7 | 인터뷰(어댑터 정합) |
| shared definitions `aorch-scout` openai | gpt-5.6-terra | gpt-6-luna | 계획 |
| `~/.claude/settings.json` modelSettings | claude-opus-5 | claude-opus-5-5 | 인터뷰 |

## 검증·스모크

- 기준선: `npm run check` 408 통과·1 skip·0 실패(커밋 전).
- 변경 후: 문법 99 소스·21 JSON 통과, 생성 파일 0건 낡음, `node --test --test-concurrency=2` 391개 중 390 통과·1 skip(Windows symlink 권한)·0 실패. 기본 병렬 실행은 시스템 메모리 부족으로 강제 종료돼 병렬 수를 2로 낮춰 다시 돌렸다.
- 영역별: router·config·providers·downshift·allocation·cli-smoke 84, run-loop 42(진단 3·P1 2 추가), config-upgrade·input-continuation 10.
- 미실행(다음 세션): worktree 설치 뒤 `diagnose --probe`, route 4개 시나리오, dispatch 스모크(opus medium·gpt-6-luna·gpt-6-sol·agy-flash), 11개 등록 프로젝트 `aorch configure` → `aorch update`·`update --user`, `~/.aorch/allocation.json` 생성(`examples/allocation.json` 복사), codexss 병합과 메인 체크아웃 `install --force-config`.

## 이월

- 역할 에이전트 파일 설치 대신 `claude --agents`·`grok --agents` 인라인 전달 검토(포니테일).
- run-evidence attestation·digest 단순화 검토(포니테일, 단일 사용자 로컬).
- luna·sol·fable 승격: reviewer 관측 3건 이상이면 `maturity: stable` 검토.
- 적격 관측 축적: write+검증+저위험+비고정 태스크 셀당 5건.
- 4개 프로젝트 신모델 감사(런북 §4~§6).
- 규칙 파일은 모든 등록 프로젝트 카탈로그에 해당 프로필·effort가 있어야 검증을 통과한다. 새 프로젝트를 등록하면 `aorch configure`를 먼저 돌린다.
