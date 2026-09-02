---
name: aorch-model-upgrade
description: 새 프런티어 모델이 나왔을 때 프로젝트를 신모델의 판단으로 점검·개선하고 모델 참조를 옮기는 런북. 사용자가 "신모델 나왔어", "모델 업그레이드", "새 모델로 점검해", "Fable 6 대응", "모델 바뀌었으니 점검"이라고 하거나 카탈로그에 새 모델 프로필을 넣을 때 사용한다. 단일 파일의 모델 ID 치환 요청에는 쓰지 않는다.
---

# aorch 모델 업그레이드 런북

새 모델이 나올 때마다 같은 순서로 돈다. 판단은 `auditor` 역할이, 인벤토리와 실사용 실행은 오케스트레이터(이 세션)가, 수정은 사용자가 고른 것만 worker 태스크가 한다. 산출물은 프로젝트 `docs/plans/<날짜>-model-upgrade-<모델>.md` 한 문서에 계획·실측·발견·선택·이월을 모은다.

## 0. 카탈로그 등록

- `config/aorch.config.json` `models`에 새 프로필을 넣는다. **`maturity`는 `challenger`**로 시작한다 — 라우터의 critical 게이트(`criticalMinimumSamples`)는 challenger에만 걸리고, stable로 등록하면 관측 0건인 모델이 곧바로 critical 작업의 단독 실행자가 된다(2026-09-02 실측: fable이 그렇게 등록돼 있었다).
- 품질 prior는 직전 최상위 프로필 + 0.02 이내. 에스컬레이션 사다리 끝에 붙인다.
- 검증: `node --test test/config.test.js test/router.test.js`.

## 1. 브랜치와 설치본

- `node src/cli.js branch status` → 사용자 승인 → linked worktree에서 작업.
- 워크트리에서는 dispatch 전에 반드시 `node src/cli.js install --project . --target both --force-config`. 없으면 Claude CLI가 상위 체크아웃의 구 설치본을 읽어 `--agent not found`로 2초 만에 죽는다(2026-08-30 실측).
- **dispatch는 git bash에서 `nohup node src/cli.js dispatch … > log 2> err < /dev/null &`로 띄운다.** 검증 게이트는 dispatch 프로세스의 환경을 물려받는데, PowerShell `Start-Process`로 띄우면 `test/executor.test.js`의 PATH shim 테스트가 `spawn fixture ENOENT`로 죽어 멀쩡한 워커가 실패·에스컬레이션된다(2026-09-02 실측). 종료 감시는 로그 파일 크기(dispatch는 끝에 JSON을 쓴다)로 하고, Windows PID가 필요하면 `Get-CimInstance Win32_Process`로 찾는다.

## 2. 인벤토리 — 오케스트레이터가 직접

정찰은 위임하지 않는다(adaptive-orchestrate 규율). 아래 패턴을 대상 루트에서 직접 돌리고 결과를 문서 "매핑표" 절에 `경로 | 현재 값 | 새 값 | 승인` 표로 적는다. 갱신은 사용자가 승인한 행만 한다.

```bash
grep -rnE "claude-[a-z]+-[0-9]|\b(opus|sonnet|haiku|fable|mythos)\b|gpt-[0-9]|canonicalModel|^model:" \
  --include=*.md --include=*.json --include=*.toml --include=*.yaml --include=*.yml --include=*.js --include=*.py \
  --exclude-dir=node_modules --exclude-dir=.venv --exclude-dir=task-runs --exclude-dir=worktrees .
```

## 3. 실사용 실행 — 오케스트레이터가 직접

플랜에 실사용 태스크를 두지 않는다. 바뀐 것 없는 트리에서 스모크만 돌리는 읽기 전용 태스크는 모델과 무관하게 통과해 무의미한 관측을 남긴다. 대신 대상 프로젝트의 규약 문서와 기존 smoke 명령에서 핵심 사용자 흐름 1회를 고른다. 이를 직접 실행하고 로그·스크린샷을 `<usage-evidence-dir>`(관례: `.aorch/evidence/<날짜>/`)에 남긴다.

## 4. 감사

- `examples/plan-model-upgrade.json`을 복사해 `<project-root>`, `<scope>`, `<conventions-doc>`, `<usage-evidence-dir>`를 채운다. A1의 `allowedProfileIds`에 새 프로필 id를, R1의 `allowedProviders`에 다른 프로바이더를 넣고 `--dry-run`으로 확인한다. 품질 라우팅으로는 고정할 수 없다 — 2026-09-02 실측: `minimumQuality 0.95`+anthropic이 opus xhigh로 갔다(opus는 review 사전값 0.96에 effort 가산, fable은 review 사전값 없음·high effort가 critical 복잡도 전용). 그래서 A1은 complexity critical, risk high다.
- git이 아닌 대상(전역 `~/.claude`)은 aorch 저장소를 projectRoot로 두고 objective에 절대 경로를 적는다. 세 태스크가 모두 `write: false`라 change guard는 aorch 트리만 본다.
- git 아닌 대상은 dispatch 전에 `~/.claude/backups/<날짜>-pre-audit/`로 복사하고, 런 종료 후 diff가 비어 있는지 확인한다.
- `dispatch --timeout-ms 1200000`. **run 중 커밋 금지**(change guard가 HEAD 이동을 잡아 run 전체가 무효).
- receipt 스키마를 손댈 때는 `required`에 모든 키를 넣고 선택 필드를 두지 않는다 — OpenAI strict 구조화 출력이 400 `invalid_json_schema`로 모든 Codex 워커를 죽인다(2026-09-02 실측, `test/task-runner-receipt.test.js`의 재귀 계약 테스트가 회귀를 막는다).
- run이 실패해 멈추면 `verification.json`의 검증 출력과 change guard를 먼저 읽는다. 에스컬레이션은 직전 시도의 트리 변경을 되돌리지 않으므로, 게이트가 환경 문제로 실패한 경우 직전 워커의 변경을 직접 검증하고 그 태스크를 뺀 플랜으로 재dispatch한다.
- A1 receipt의 `findings`를 문서 "발견" 절에 표로 옮긴다. 표기: critical 치명, high 불편, standard·low 사소. `fixCost`는 그대로.

## 5. 선택

AskUserQuestion(multiSelect)으로 수정할 finding id를 고른다. 자동 수정은 없다.

## 6. 적용

- `examples/plan-model-upgrade-apply.json`을 복사해 고른 finding마다 `X<n>-<id>` 태스크(동작 보존이면 `refactorer`, 아니면 `worker`), 매핑표 승인 행으로 `M1-model-refs`를 채운다. 모든 write 태스크에 프로젝트의 진짜 검증 명령을 둔다 — 이 플랜이 새 모델의 첫 라우팅 관측을 남기는 자리다.
- git이 아닌 대상은 오케스트레이터가 직접 고친다. 고치기 전 원본을 `~/.claude/backups/`에 복사한다.

## 7. 재설치와 승격

- 각 프로젝트에서 `.aorch/config.json`을 `config/aorch.config.json`과 diff한다. 차이가 없으면 `--force-config`, 차이가 있으면 플래그 없이 `install`을 돌리고 새 프로필과 사다리 단계만 프로젝트 config에 손으로 추가한다.
- 검증 명령이 없는 리뷰 태스크(A1 포함)는 관측을 남기지 않는다. 승격 근거는 새 모델이 실제로 실행한 write 태스크 또는 검증 명령을 가진 reviewer 태스크에서만 쌓인다(2026-09-02: 감사 2회 뒤에도 fable 관측 0건).
- `.aorch/observations.jsonl`에서 새 모델의 `role: reviewer` 관측 수를 센다. `criticalMinimumSamples`(기본 3) 이상이면 사용자에게 물어 `maturity`를 `stable`로 올리고 문서에 건수와 날짜를 적는다. 미만이면 challenger로 둔다.

## 8. 되먹임

이번 run에서 절차가 바뀐 곳(패턴 누락, 템플릿 필드, 함정)을 이 스킬과 `CHANGELOG.md`에 반영한다. 문서 "이월" 절에 다음 모델 때 볼 것을 남긴다.
