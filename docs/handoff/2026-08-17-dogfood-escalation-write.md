# 도그푸딩: escalation 발동과 write 파이프라인

**일자**: 2026-08-17
**대상**: ECC 검토 문서가 남긴 미검증 영역 중 둘 — escalation 발동, write 작업이 섞인 파이프라인. (셋째인 다중 후보 researcher는 실제 차용 질문이 생길 때 자연 검증하기로 하고 보류.)

## 결론

- **escalation은 설계 문서 그대로 동작한다.** 격리 샌드박스에서 결정적으로 발동시켜 ladder 상승·`.escN` id·실패 증거 전달·기준선 동결까지 전부 실측했다.
- 그리고 같은 날 **실전에서 escalation이 저절로 발동해 우리 결함 하나를 드러냈다**: verify 게이트가 주입하는 `AORCH_VERIFIER=1`이 자체 테스트 스위트와 충돌해, 옳은 워커 산출을 3번 기각했다. 수정 커밋 `9989ce7`.

## 1. escalation 프로브 (격리 샌드박스)

관측 원장 오염을 막기 위해 스크래치패드의 임시 git 저장소에서 실행했다(별도 `.aorch`). 리깅된 하니스임을 명시한다 — 모델 품질 평가가 아니라 메커니즘 동작 확인이다.

**1차 설계는 워커에게 무산됐다.** 검증 명령을 "1회차 실패 후 통과"로 리깅했더니, 워커가 verificationCommands를 받아 **스스로 사전 실행**해(receipt에 1차 exit 1, 2차 exit 0 기록) 리깅을 소진했고 attempt 1이 통과해버렸다. 워커의 자기 검증은 실전에서는 미덕이고, 교훈은: **워커에게 보이는 어떤 리깅도 유능한 워커가 통과시킬 수 있다.**

**2차 설계: 워커 손이 닿지 않는 외부 게이트.** 검증 명령은 부작용 없는 순수 체크(외부 플래그 존재 확인)로 바꾸고, attempt 1의 검증 실패를 감시자가 확인한 뒤에만 플래그를 만들었다. 결과:

| attempt | route | 결과 |
|---|---|---|
| 1 | `claude-sonnet-general` sonnet/medium | 검증 실패(리깅), change guard 통과 |
| 2 | `claude-opus-deep` opus/high (ladder 강제) | task id `E2-probe.esc1`, 검증 통과 |

- 샌드박스 원장에 `quality 0.2 → 1` 두 행이 순서대로 기록됐다.
- **기준선 동결 설계 검증**: escalation 워커가 attempt 1이 만든 파일을 다시 쓰고 claim해도 guard가 통과했다(`changeGuardPassed: true`) — run-loop 주석이 약속한 그 동작이다.
- 증거: 샌드박스 `.aorch/task-runs/33988e5d-*/E2-probe.esc1/`.

**부수 발견**: aorch 미설치 프로젝트에서 dispatch를 돌리면 프리셋 폴백(`src/role-agent.js`)은 패키지 경로에서 maxTurns를 읽어 통과하지만, claude CLI의 `--agent`는 실행 디렉터리에 설치된 에이전트만 인식해 **워커 spawn 시점에야** `--agent not found`로 죽는다. 실패가 늦고 메시지가 원인(`aorch install` 필요)을 가리키지 않는다. 미수정 상태로 남김.

## 2. write 파이프라인 (실전, linked worktree)

소재는 P4 감사가 지목한 실제 수정 — NOTICE 10행 정밀화. 2-task 계획: W1 worker가 NOTICE 한 줄 교체(`write: true`, `allowedScope: ["NOTICE"]`, 검증 `npm run check`), W2 reviewer(openai 고정)가 diff를 독립 검토. `git worktree add .claude/worktrees/notice-fix`로 격리하고 관측은 본 저장소 원장에 연결했다.

### 1차 실행: 실전 escalation 발동, 그리고 우리 결함

W1이 3회 전부 `npm run check` 실패로 끝났다 — luna/max → sol/high → sol/xhigh, ladder와 시도 예산 소진, 에러 메시지에 증거 경로 첨부. **그런데 세 워커의 NOTICE 산출은 전부 정확했다** (worktree diff로 확인). 실패 원인은 작업이 아니라 게이트 자신이었다:

- `src/self-update.js:47-49`는 `AORCH_VERIFIER=1`이면 auto-refresh를 `disabled`로 단락한다.
- verify 게이트는 검증 명령을 정확히 그 `AORCH_VERIFIER=1` 환경에서 돌린다(설치 훅이 비켜서게 하는 설계).
- `test/update.test.js:101`의 미개입 프로젝트 테스트만 ambient env에 의존해 `unmanaged` 대신 `disabled`를 받았다. 같은 파일의 다른 테스트는 전부 `env: {}`를 명시한다.
- 재현: 본 트리에서 `AORCH_VERIFIER=1 node --test test/update.test.js` → 동일 실패.

수정은 한 줄(`env: {}` 추가), 커밋 `9989ce7`. 이 결함이 드러낸 일반 명제 둘:

1. **검증 실패의 원인이 워커 작업 범위 밖이면 escalation은 순수 낭비다.** 더 강한 모델 두 번이 같은 벽에 부딪혔다. escalation은 "작업이 부족했다"는 가설에만 유효하다.
2. **게이트 결함은 원장을 오염시킨다.** 세 attempt가 luna/sol에 quality 0.2를 기록했다 — 모델 잘못이 아니므로 해당 3행을 원장에서 제거했다(13행 유지). 원장 신뢰는 게이트 신뢰에 종속된다.

### 2차 실행: 수정된 기준(`9989ce7`) 위에서

**W1(write)은 attempt 1에 완주했다** — luna/max, `npm run check` 통과, guard 통과, claimed=actual=`["NOTICE"]`. escalation 없이 첫 티어가 끝냈다는 것 자체가 1차 실패의 원인이 게이트였다는 최종 증거다.

**W2(read-only 검토)는 change guard에 걸렸다.** 위반 두 종이 동시에 잡혔고, 둘 다 워커 품질이 아닌 시스템 쪽 원인이다:

1. **OneDrive 오염**: 실행 중 `scripts/desktop.ini`가 생겨 `unclaimedFiles`/`readOnlyFiles` 위반. 이 저장소가 OneDrive 아래라 언제든 재발한다. → `.gitignore`에 `desktop.ini` 추가로 guard 시야에서 제거.
2. **receipt 계약 문구와 판정 기준의 불일치**: reviewer(terra/max)가 자기가 바꾸지 않은 NOTICE를 `filesChanged`에 넣어 `overclaimed`. 그런데 이는 워커의 반항이 아니라 **지시를 따른 결과다** — 계약 문구가 "Git이 변경으로 보고하는 모든 경로를 나열하라"였고, W1의 미커밋 NOTICE가 `git status`에 잡혔다. guard의 실제 판정 기준은 task 실행 전후 델타다. 지시가 판정과 어긋나 있었다. → `src/providers/base.js`의 계약 문구를 "task 시작 시점 대비 네가 만든 변경만, 없으면 빈 배열"로 정정(테스트 단언 동반 갱신).

이 두 원인 수정 후 W2를 단독 재실행했다:

### 3차 실행: W2 통과, 파이프라인 완주

- terra/max, attempt 1, guard 통과, **`filesChanged: []`** — 정정된 계약 문구가 첫 실행에서 바로 효과를 냈다.
- 판정: 두 질문 모두 확인(새 문구는 차용 범위를 정확히 진술, diff는 NOTICE 한 줄뿐), confidence 0.94. 부수 지적으로 "its presets"의 선행사가 다소 모호하다는 것과, 요청 범위 밖에 `.gitignore` 변경이 존재한다는 사실(운영자 수정, 의도된 것)을 정직하게 보고했다.
- 검증 명령이 없는 read-only task라 verify 게이트는 설계대로 생략됐다(`passed: null`) — 이 경로의 증거는 receipt와 guard다.

### write 파이프라인 도그푸딩 판정

worker 산출(NOTICE 한 줄)은 사람 검토 후 본 트리에 반영했고 worktree는 폐기했다. 미검증 영역이던 "write 섞인 파이프라인"은 이제 실측됐다: **write task의 receipt·verify·guard·관측 기록, 실전 escalation과 그 한계, read-only task의 dirty-tree 함정까지.** 이 과정에서 저장소 결함 2건(테스트 비밀폐성, 계약 문구 불일치)과 환경 위험 1건(OneDrive desktop.ini)을 고쳤다.

## 미검증으로 남은 것

- 다중 후보 상황의 researcher (보류 사유 위 참조)
- ladder 소진의 실전 종료 경로는 1차 write 실행이 우연히 실측해 줬다 — 별도 프로브 불필요해짐
