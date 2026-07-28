# Handoff: 리빌드 후 잔여 문제 수리 (2026-07-28)

수신자: Codex (또는 후속 작업 세션). 이 문서만 읽고 작업을 시작할 수 있도록 자족적으로 작성했다.

## 현재 상태

- branch `left`, HEAD `8edf546` (origin/left에 push됨).
- 6-슬라이스 리빌드 완료: 다운시프트 실효화 → verify 게이트+escalation(+Fable 잠금 프로필) → PreToolUse subagent-gate → provider limits+크로스 fallback → 도그푸딩 왕복 성공 → 청소+문서 재작성. 결정 원장은 `docs/superpowers/specs/2026-07-28-aorch-rebuild-design.md`, 변경 요약은 `CHANGELOG.md`의 "리빌드" 섹션.
- 테스트: `npm run check` 기준 **138 tests / 137 pass / 1 fail**. 유일한 실패는 아래 Issue 2(환경 문제)다.
- 도그푸딩 증거: `.aorch/task-runs/d31972b1-*/T-dogfood-reviewer-wording/`의 receipt.json·verification.json, `.aorch/observations.jsonl`의 verify-gate 관측 1건. (`.aorch/`는 gitignore — 로컬에만 있음.)

## 작업 규율 (구속력 있음)

- TDD: 실패하는 테스트 먼저, 그다음 최소 구현. 기존 테스트·경고를 약화해 통과시키지 않는다.
- 신규 의존성 0, 데몬/폴링 0. 기존 인터페이스(task/route/receipt/run-loop) 위에 최소 변경.
- 커밋은 이슈 단위, 메시지는 영어. 완료 주장 전 `npm run check` 실행(허용되는 기존 실패는 Issue 2 하나뿐 — Issue 2를 고치면 0 fail이어야 한다).
- `.env*`·자격증명 접근 금지. push는 사용자 명시 요청 시에만.

---

## Issue 1 — Windows에서 `codex` 실행 파일 해석 실패 (우선순위 1, 실측 결함)

**증상**: packaged config의 openai provider는 `"executable": "codex"`인데, Windows에서 `aorch exec`가 `spawn codex ENOENT`로 죽는다.

**원인**: npm 전역 설치된 codex는 `codex.cmd`/`codex`(sh) 셔틀이고, `src/executor.js`의 `spawn(..., { shell: false })`는 Windows에서 `.cmd`를 PATH로 해석하지 못한다(Node는 보안상 .cmd를 shell 없이 실행하지 않음).

**현재 워크어라운드(취약)**: 이 머신의 `.aorch/config.json`(gitignore됨)에 네이티브 exe 절대경로를 박아둠:
`C:/Users/goyan/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`
이 파일이 지워지면 codex 위임이 다시 깨진다.

**요구 수정**: 이식성 있는 실행 파일 해석. 권장 방향 — provider 실행 직전(예: `task-runner.js`의 commandSpec 구성 후 또는 `executor.js` 진입점)에 win32 한정으로:
1. `spec.command`가 확장자 없는 이름이고 PATH에서 `.exe`로 해석되지 않으면,
2. PATH+PATHEXT 순회로 `<name>.cmd`/`<name>.bat`을 찾고, 발견 시 `%ComSpec% /d /s /c "<full path> <args...>"` + `windowsVerbatimArguments`(verify.js의 기존 패턴 재사용)로 감싸거나,
3. npm 셔틀이면 인접한 `node_modules/<pkg>/bin/*.js`를 `process.execPath`로 직접 실행하는 해석을 시도한다.
2번이 가장 단순하고 인자 이스케이프 함정은 verify.js가 이미 푼 방식(`/d /s /c` + 전체 명령 재인용 + verbatim)을 따르면 된다. **주의**: prompt는 argv가 아니라 stdin으로 전달되므로(codex adapter) cmd 인용 부담이 작다.

**검증**: 단위 테스트(가짜 `.cmd` 셔틀을 임시 PATH에 만들어 spawn 성공 단언, win32 아닌 플랫폼에서는 기존 동작 불변) + 이 레포에서 `.aorch/config.json`의 executable 오버라이드를 지우고 `node src/cli.js exec --task <envelope> --dry-run`이 아닌 실제 exec가 ENOENT 없이 codex에 도달하는지 확인.

## Issue 2 — cli-smoke symlink 테스트가 Windows에서 EPERM으로 항상 실패 (우선순위 2)

**증상**: `test/cli-smoke.test.js:57` "npm-style bin symlinks execute the CLI entrypoint" — `symlink()`가 `EPERM: operation not permitted`로 실패. Windows에서 심볼릭 링크 생성은 개발자 모드/관리자 권한이 필요하다.

**요구 수정**: 테스트 약화가 아니라 **환경 감지 스킵**. 테스트 시작부에서 symlink 생성을 시도해 EPERM이면 `t.skip('symlink privilege unavailable')`로 스킵하고, 그 외 오류는 그대로 실패시킨다. 스킵 사유가 출력에 남아야 한다. 다른 플랫폼(리눅스/맥, 권한 있는 Windows)에서는 계속 실제 검증.

**완료 기준**: 이 머신에서 `npm run check` **0 fail**.

## Issue 3 — claimed diff vs actual diff 대조 가드 (우선순위 3, 로드맵 기능)

README "아직 없는 것" 1번. verify 게이트는 테스트를 돌리지만, worker receipt의 `filesChanged` claim과 실제 Git 상태를 대조하는 값싼 가드가 없다.

**요구 구현** (run-loop의 verify 단계 앞 또는 병행):
1. write task: worker 실행 전후 `git status --porcelain`(또는 diff)을 비교해, 변경된 파일이 receipt의 `filesChanged` 및 task의 `allowedScope` 안에 있는지 확인.
2. read-only task(`write !== true`): 실행 후 워킹트리 변경이 없어야 한다. 있으면 fail.
3. worker가 `HEAD`를 바꾸지 않았는지(커밋/리셋 금지) rev-parse 비교.
4. 위반 시 verify 실패와 동일하게 escalation 경로를 타지 말고 **즉시 사람 반환**(scope 위반은 재시도로 안 고쳐진다) — 단, 이 설계 판단은 재량이며 근거를 커밋 메시지에 남길 것.

`git` 헬퍼는 `task-runner.js`에 이미 있다(`AORCH_WORKER=1` env 포함). 결과는 `runDir/verification.json`에 `changeGuard` 필드로 병기 권장. 테스트는 `test/run-loop.test.js`의 주입 패턴(executeTaskImpl/runVerificationImpl 스텁)을 따르되, git 동작은 임시 레포로 실검증.

## Issue 4 — executor 드레인 경로가 Windows 테스트에서 실제로 밟히지 않음 (우선순위 4, 소형)

`8edf546` 이전 커밋 `bb0198e`에서 executor에 "worker `exit` 후 2초 드레인" 폴백을 넣었다(코덱스 헬퍼 프로세스가 stdio 파이프를 쥐면 `close`가 영원히 안 오는 실측 행 때문). 그런데 `test/executor.test.js`의 orphan 테스트는 이 머신에서 93ms에 `close`가 와서 통과한다 — 즉 **드레인 분기 자체는 테스트가 안 밟는다**.

**요구**: 파이프를 확실히 쥐는 재현(예: 자식이 grandchild에 stdout fd를 dup해 넘기고 즉시 종료하는 스크립트)을 시도해 드레인 분기를 결정론적으로 커버하거나, 시도 결과 플랫폼 간 재현이 불안정하면 그 사실을 테스트 주석으로 정직하게 남기고 종료. 프로덕션 코드 변경은 불필요(동작은 실전에서 검증됨 — 도그푸딩 왕복이 이 수정 후 성공).

## Issue 5 — rate-limit 메시지 fixture (차단됨, 착수 금지)

`src/limits.js`의 `detectRateLimit` 패턴은 추정이다. 실제 provider 한도 이벤트가 발생하기 전에는 fixture를 캡처할 수 없다. **한도 이벤트가 실제로 났을 때** stderr/stdout 원문을 `test/fixtures/`에 저장하고 패턴을 조이는 작업이다. 지금은 손대지 말 것.

---

## 참고 지도

| 파일 | 역할 |
|---|---|
| `src/executor.js` | spawn + timeout + kill escalation + exit-드레인 |
| `src/verify.js` | verificationCommands 셸 실행 (win32 인용 패턴의 정답지) |
| `src/run-loop.js` | exec→verify→escalate→cross-fallback 루프 |
| `src/task-runner.js` | 1회 디스패치, write isolation, git 헬퍼 |
| `src/limits.js` | limits 상태 + rate-limit 감지 |
| `test/run-loop.test.js` | 주입 스텁 테스트 패턴 |
| `docs/DESIGN.md` | 재작성된 설계 (Fable 잠금 트릭 §6, verify 게이트 §7) |

작업 순서 권장: Issue 2(작고 즉시 0-fail 달성) → Issue 1(실측 결함) → Issue 3(기능) → Issue 4. 각 이슈는 독립 커밋.
