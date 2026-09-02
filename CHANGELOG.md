# Changelog

## Unreleased

### Changed

- **목적함수 개정**: "시간 + 구독 한도 절약" → **"사용자 개입 최소화 + 구독 한도 절약"**(품질 바닥선 유지). 벽시계 시간이 늘더라도 사람이 다시 손대는 횟수가 줄면 이득으로 친다. 귀결로 다운시프트의 기준이 "바닥선을 넘는 가장 싼 모델"에서 **"한 번에 검증을 통과할 모델"**이 됐고, `config`의 `quality.<kind>`는 `qualitySemantics` 필드로 그 의미(1회 통과 확률)를 명시한다.

- **`aorch classify`가 관측을 읽는다**: 이전에는 `observations: []`를 하드코딩해, 거의 모든 프롬프트에서 발동하는 서브에이전트 게이트가 학습된 성과를 **한 번도 쓰지 못했다**. 이제 관측 원장을 읽으므로 반복 실패한 티어가 다운시프트 대상에서 밀려난다. 원장이 깨져 있으면 fail-open으로 prior에 의존하고 stderr에 한 줄 남긴다 — 이 게이트는 비용 최적화이지 안전장치가 아니다.
  - 다운시프트 우선순위(`standard`의 tokens-first)는 **의도적으로 유지**했다. quality-first로 뒤집으면 구현·테스트가 이력과 무관하게 상위 티어로 가면서 관측 메커니즘이 무의미해지고 한도 절약도 사라진다.

### Fixed

- **2026-09-02 Fable 5.1 자기 감사에서 고른 17건**(auditor findings, 사용자 선택): dispatch가 run당 하나의 runId를 써서 `task-runs/<run>/<task>/`에 모임 · 플랜의 미지 태스크 키를 `Unknown task field`로 거부하고 task 스키마에 `additionalProperties: false` · 분류기에 review 규칙(영·한 리뷰·판정 어휘, security 아래) · 에스컬레이션 사다리가 `allowedProfileIds`·`forbiddenProfileIds`·provider 핀을 존중 · 비객체 receipt fail-closed · 검증 명령 실행 뒤 HEAD·control path 재검사 · `paths.stateDir` 형식 검증 · self-update 락 `wx` 배타 생성 · `branch finish` push 실패 시 pre-merge SHA를 오류에 실음 · receipt 스키마 compact 복원 + OpenAI strict 계약 재귀 테스트 + `findings.id` pattern · 런북에서 `--force-config` 재설치 지침·외부 대상 사전 백업·개인 스모크 표 제거 · Codex용 `aorch-model-upgrade` 사본 추가. 제외(사용자 결정): installFile atomic write.

### Added

- **`auditor` 역할과 receipt `findings`**: 14번째 역할. ponytail·reviewer receipt와 리드가 직접 만든 실사용 증거를 종합해 **순위 있는 발견**을 receipt의 `findings[]`(id·severity·fixCost·axis·location·evidence·proposal, 어휘는 risk·complexity와 같은 `low/standard/high/critical`)에 적는다. reviewer 프리셋은 단일 diff 반증에 고정돼 있어 재사용할 수 없었고, qa-analyst와 같은 이유로 reviewer 라우팅을 받는다. `findings`는 선택 필드라 기존 receipt는 그대로 통과한다 — paper-researcher 계획이 이월했던 "조사형 역할의 산출물이 summary에만 남는" 공백을 닫는다.
- **`aorch-model-upgrade` 스킬과 템플릿 2종**: 새 모델이 나올 때의 런북(`integrations/claude/skills/aorch-model-upgrade/SKILL.md`, install이 함께 복사). 감사 플랜 `examples/plan-model-upgrade.json`(ponytail → 교차 프로바이더 reviewer → 신모델 고정 auditor)과 적용 플랜 `examples/plan-model-upgrade-apply.json`(사용자가 고른 finding만 + 매핑표 기반 모델 참조 갱신). auditor는 새 플랜 필드 `allowedProfileIds`(`forbiddenProfileIds`의 양성 쌍둥이)로 신모델에 고정한다 — `minimumQuality`로는 안 된다는 것을 dry-run으로 실측(opus의 review 사전값+effort 가산이 fable을 이김). 실사용 실행과 모델 참조 인벤토리는 정찰이라 위임하지 않고 리드가 직접 한다. 새 모델은 `maturity: challenger`로 등록한다 — fable이 관측 0건인 채 stable로 들어가 있던 것을 2026-09-02에 발견.

- **`paper-researcher` 역할과 역할별 MCP 주입**: 13번째 역할이 `paper-search-mcp`(MIT, `uvx`)로 논문 서지·인용수·초록을 수집만 한다(순위·종합 금지). 역할 프리셋이 MCP를 주입하는 첫 사례 — `src/role-agent.js`가 체크인된 `integrations/claude/mcp/paper-researcher.mcp.json`과 **이름으로 열거한** 도구 목록을 반환하고, Claude는 `--mcp-config` + `--strict-mcp-config`, Codex는 `-c mcp_servers.*`로 받는다(둘 다 08-30 실측). "모든 역할이 같은 allowlist"라는 READ_TOOLS 원칙의 유일한 예외이며, 근거는 MCP 서버가 기동 비용과 실패점을 가진 프로세스라는 것. 범용 `roleAgents.*.mcpServers` 설정 필드는 소비자가 하나뿐이라 의도적으로 만들지 않았다. 서버가 없으면 워커는 `blocked`를 보고하고 run이 멈춘다 — 웹 검색으로 폴백하지 않는다. 인용 관계(`references`)는 이 서버가 전 소스에서 비워 돌려주므로 수집 대상에서 제외. 예시 플랜 `examples/plan-paper-search.json`.

- **분해–분배 파이프라인** (`aorch decompose` / `aorch dispatch`): 이전에는 리드가 작업마다 15필드 엔벨로프를 손으로 쓰고 `aorch exec`를 반복 호출해야 했다. 분해는 여전히 리드(호스트 모델)가 하지만, **결과의 형식을 aorch가 스키마로 강제하고 검증하며 실행까지 책임진다.** 2026-07-24 설계의 "분해기 non-goal"을 폐기한 것이 아니라, 그 문서가 스스로 지목한 "권고지 강제가 아니다"라는 약점을 제거한 것이다.
  - `aorch decompose --print-schema` — 리드가 채워야 할 계획 계약(`schemas/task-plan.schema.json`)을 출력. `--plan <path>`로 검증하며 위반 시 exit 1.
  - `aorch dispatch --plan <path> [--dry-run]` — 계획의 모든 작업을 **선언 순서대로** 라우팅·실행하고 첫 실패에서 멈춘다(뒤 작업이 반쯤 적용된 트리 위에서 돌지 않도록). 활성 rate-limit은 첫 작업뿐 아니라 모든 작업에 적용된다.
  - `decomposed: false`는 작업이 정확히 1개여야 한다 — "분해하지 않음"을 적극적으로 선언하게 해서 불필요한 분해를 억제한다.

- **역할 에이전트 자동 배정**: 계획의 각 작업이 `agentRole`(`worker`/`reviewer`/`fixer`)을 선언하면 dispatch가 해당 역할 에이전트로 띄운다.
  - 라우팅 `role`은 `agentRole`에서 **파생**된다(worker·fixer→`executor`, reviewer→`reviewer`). 계획에 `role`을 손으로 쓰면 거부한다 — 둘이 어긋날 수 없게.
  - `aorch-fixer` 신설(검증 실패한 작업을 실패 출력과 기존 diff로 최소 수정). `aorch-worker`/`aorch-reviewer`/`aorch-fixer`에서 **모델·effort 고정을 제거**했다 — 프리셋은 행동과 도구 제한을, 라우터는 등급을 담당한다.
  - **정찰은 위임하지 않는다.** `scout` agentRole은 의도적으로 없고, `aorch-scout`은 리드 도구로 남아 모델 고정도 유지한다(검증이 스팟체크≈직접하기라 순이득 ~0).
  - 프리셋 전달 경로가 provider마다 다르다: Claude는 `--agent`로, `codex exec`는 에이전트 플래그가 없어 `developer_instructions`를 프롬프트에 주입한다. 양쪽 모두 역할의 **행동**을 얻는다.
  - **정정(2026-08-17)**: 최초 릴리스 노트는 "Claude는 --agent로 도구 제한까지 적용되어 reviewer가 편집하지 못한다"고 적었으나 실측이 반박했다. 편집 도구를 CLI와 프리셋 양쪽에서 막아도 워커는 **셸로 파일을 만들 수 있고**(실측), 셸은 검증 실행에 필요해 뺄 수 없다. read-only의 실질 보장은 **change guard의 사후 git 트리 대조** 하나뿐이다. `write: false`는 샌드박스가 아니라 change guard가 검사하는 주장으로 취급할 것.
  - `config.roleAgents`로 adapter별 에이전트 이름을 선언한다. 블록이 없으면 shipped 기본값을 쓰고(기존 설치본 호환), 선언하면 엄격 검증한다. dispatch는 매핑에 없는 adapter에서 **어떤 프로세스도 띄우기 전에** 실패한다.

### Added

- **설치본 갱신** (`aorch update`): 설치본은 패키지 스냅샷이라 패키지가 바뀌면 낡는데, 지금까지는 대상 프로젝트마다 `aorch install`을 손으로 다시 돌려야 했다.
  - 설치 시 프로젝트 경로를 사용자 레벨 레지스트리(`~/.aorch/installs.json`, `AORCH_HOME` override)에 기록하고, 프로젝트에는 payload 내용 해시를 담은 `.aorch/install-stamp.json`을 남긴다. 버전 문자열이 아니라 내용 해시인 이유는 패키지가 버전보다 훨씬 자주 바뀌기 때문.
  - `aorch update [--project <path>] [--check]` — 등록된 설치본을 일괄 갱신. `config.json`은 보존하고, 사라졌거나(`missing`) 통합이 제거된(`unmanaged`) 항목은 레지스트리에서 정리한다.
  - **자동 갱신**: 설치된 `user-prompt-submit` 훅이 매 프롬프트마다 해시를 대조하고, 낡았으면 분리된 프로세스로 갱신을 띄운다(훅 3초 제한 안에 머물기 위해 복사는 훅 밖에서 — 반영은 다음 프롬프트부터). 프로젝트당 60초 락으로 중복 스폰을 막고, 모든 실패 경로는 fail-open, 스탬프도 통합도 없는 프로젝트에는 설치하지 않는다. 탈출구는 `AORCH_NO_AUTOUPDATE=1`.
  - 설치가 내용이 바뀐 파일만 쓰도록 바꿨다(Windows에서 실행 중인 훅 파일을 덮어써 EBUSY가 나는 것을 피하기 위함).

- **브랜치 수명주기 관리** (`aorch branch`): 작업 시작·마감 시 어느 브랜치에서 일할지의 판단을 돕는 서브 기능.
  - `aorch branch status` — 읽기 전용 사실(현재/대상 브랜치, 각 브랜치의 ahead·behind·staleness·머지 여부, 정리 후보, 위치 위험, repoIntegration)을 JSON으로 반환. 의미 매칭은 호스트 몫.
  - `aorch branch apply --action <start|finish|cleanup|sync>` — 가드형 실행자. **`--approved` 없이는 git 쓰기 0, 계획만 출력**(딸깍 전 미리보기). `start`(자동 stash→분기→복원), `finish`(verify 녹색 게이트→main merge+push→머지 브랜치 삭제, undo용 pre-merge SHA 기록), `cleanup`(머지된 로컬 자동 삭제+원격추적 prune, 미머지-stale은 `--confirm-unmerged` 필요), `sync`(main을 현재 브랜치에 merge, 충돌 시 abort).
  - 루트 스킬(Claude·Codex)에 능동적 시작 흐름 추가(위험·애매할 때만 발동, 정리 먼저→시작 추천→위치 경고, 훅 아님).
  - 선택적 `config.branch`(mainBranch/staleDays/integration/verificationCommands) 검증. 브랜치 이름은 호스트가 정하므로 이름 규칙 config는 두지 않음.
  - 경계: push·merge·삭제는 `--approved` 뒤에만, 미머지 삭제는 별도 확인. PR 실행 경로는 이 버전에서 감지만(direct 머지 자동화, PR 생성은 후속).

## 0.5.0 - 2026-08-08

프루닝(대청소) 위에 올린 6-슬라이스 리빌드와, 리빌드 직후 독립 리뷰·실사용 도그푸딩에서 드러난 결함을 경화한 릴리스. 목적함수는 시간·구독 한도 절약(품질 바닥선 유지)이다.

### 리빌드 (rebuild on the pruned baseline)

인터뷰로 확정한 6-슬라이스 리빌드.

### Added

- **다운시프트 실효화**: haiku 카탈로그 확장(testing/implementation/exploration/research/log-analysis)과 exploration/research 분류 규칙. 광고한 다운시프트 대상 전부가 실제로 haiku에 도달하며, `test/downshift-matrix.test.js`가 경계를 회귀 고정한다.
- **verify 게이트 + escalation**: `aorch exec`가 작업의 `verificationCommands`를 직접 실행하고, 실패 시 같은 provider의 사다리(Claude: opus→fable, Codex: sol/high→sol/xhigh)를 `forcedRoute`로 상향한다(총 attempt ≤ 3, 소진 시 증거와 함께 사람 반환). verify 결과는 quality 1.0/0.2 관측(`metadata.source:'verify-gate'`)으로 자동 기록되어 나쁜 다운시프트가 자기교정된다. `claude-fable-apex` 프로필은 `complexities:["critical"]` 잠금으로 일반 라우팅에서 숨긴다(escalation 전용).
- **훅 강제**: PreToolUse(`Task|Agent`) `subagent-gate.mjs`가 서브에이전트 스폰을 classify하고 과등급/모델 미지정 스폰을 정확한 모델 안내와 함께 차단한다(fail-open, `AORCH_NO_ENFORCE=1` 탈출구).
- **provider limits + 크로스 fallback**: `.aorch/limits.json`(만료 타임스탬프, 데몬 없음), `aorch limits` CLI, route/exec의 forbiddenProviders 주입, rate-limit 감지 시 남은 provider로 재선택. 실제 한도 메시지 포맷은 미확정 — 이벤트 발생 시 fixture로 패턴을 고정할 것; 그때까지 수동 토글이 1차 경로다.
- `classify --providers`로 Claude-전용 기본을 넘어 크로스-provider 라우팅 개방.

### Fixed

- Windows에서 워커(codex)가 stdio 파이프를 쥔 헬퍼 프로세스를 남기면 executor가 `close` 이벤트를 영원히 기다리던 행 — worker `exit` 후 2초 드레인 윈도우로 settle.

### Dogfooding (성공 기준 달성)

aorch 자기 자신의 실제 서브태스크(리뷰어 에이전트 문구 정합화)를 `classify --providers openai` → `codex-luna-repeatable@medium` 다운시프트 → `aorch exec` 위임 → verify 게이트(수용 기준 검사 + `node --test test/install.test.js`) 1차 통과로 왕복했다. receipt: `.aorch/task-runs/d31972b1-2fd5-4b25-be64-e8bd3fed725e/T-dogfood-reviewer-wording/receipt.json`, 관측: `.aorch/observations.jsonl`의 verify-gate 레코드 1건.

### Fixed (리뷰·도그푸딩 후속 경화)

리빌드 직후 독립 리뷰어(opus, CRITICAL 1 + MAJOR 다수)와 실사용 도그푸딩(한국어 분류 신호 라우팅 왕복)에서 확인·재현한 결함을 수리했다.

- **cmd 셰이프 명령 주입 (CRITICAL, BatBadBut/CVE-2024-27980)**: `resolveWindowsCommandSpec`이 `.cmd`/`.bat` 셰이프를 cmd.exe에 넘길 때 MSVCRT식 따옴표를 cmd가 파싱하지 못해, cmd 메타문자(`& | < > ^ %` 개행)를 담은 인자가 따옴표 상태를 깨고 별도 명령으로 실행됐다. `route.model`/`route.effort`가 `.aorch/config.json`(gitignore + 가드 제외)에서 argv로 흘러들어, 워커가 config를 쓰면 다음 exec에서 호스트 명령 실행이 가능했다. 해당 문자에 fail-closed(정당한 `model_reasoning_effort="..."`는 왕복 유지). `%VAR%` 경로 손상도 함께 차단.
- **claude 어댑터 워커 전멸**: claude CLI의 `--json-schema` 검증기가 receipt 스키마의 `$schema: draft/2020-12` 선언을 해석하지 못해 claude 워커가 스폰 즉시 죽었다. 어댑터 경계에서 `$schema`를 제거(키워드는 draft-07 호환). 또한 워커가 run 디렉터리 생성 전에 죽으면 stderr가 버려지던 것을 실패 메시지에 스트림 tail로 실어 진단 가능하게 함.
- **에스컬레이션 베이스라인 오염 (도그푸딩 발견)**: change guard의 before-snapshot을 매 시도마다 재캡처해, 한 시도가 트리를 수정하면 다음 시도의 동일 수정이 이미 더러워진 baseline 대비 순변화 0으로 읽혀 정직한 claim이 overclaimed로 거부됐다(코드는 정상인데 사다리가 실패). baseline을 루프 밖에서 1회 캡처해 전체 run의 순변화를 원본 대비 검증.
- **change guard 사각지대**: gitignore된 호스트 훅 설치 파일(`.claude/settings.json` 등)과 `.git/hooks`·`.git/info/exclude`·`.git/config`를 가드가 못 봤다. 제어 평면 지문(호스트 훅 타깃 + `.aorch/config.json` + `.git` 훅/config/exclude)을 before/after 비교해 변경 시 실패. (전체 ref 집합 비교는 도그푸딩에서 오탐이 확인돼 제외 — write 작업은 refs를 공유하는 워크트리에서 돌고 사용자가 메인에서 커밋/fetch하는 것이 정상이므로. HEAD 고정이 무결성 앵커이고 비-HEAD ref 조작은 워킹트리 변경을 숨기지 못한다.)
- **`forbiddenScope` 디렉터리 fail-open**: glob 메타문자 없는 패턴이 정확-일치 정규식으로 앵커링돼 `"src/secret"`가 하위 파일에 매치되지 않아 금지 경로 쓰기를 조용히 허용했다. 메타문자 없는 패턴을 경로 prefix로 취급.
- **executor 드레인 핸들 누수**: `exit` 후 드레인이 프로미스는 settle하되 상속된 stdio 읽기 끝을 닫지 않아, 고아 헬퍼가 이벤트 루프를 살려 두어 aorch가 프로미스 해소 뒤에도 ~8초 매달렸다. settle 전에 stdout/stderr destroy.
- **워커 프롬프트 정확-일치 계약 미고지**: `filesChanged`가 Git 델타와 정확히 일치해야 하는데 프롬프트가 이를 말하지 않아, rename source나 검증 명령이 만든 산출물을 빠뜨린 정직한 워커가 거부됐다. 계약을 프롬프트에 명시.

남은 알려진 이슈(MINOR, 후속 예정): parse 실패 경로의 가드 증거 유실(F6), Windows 대소문자-only receipt 오탐(F8), 스냅샷 지문 무제한 동시성·대형 저장소 status 타임아웃(F9), 미사용 확장 시 launcher 재해결 범위(F10), PATH 대소문자 프록시 불일치(F11).

### 대청소 (scope pruning, 리빌드 이전 단계)

이 도구의 실제 제품 정의(개인용 두 구독 CLI — Claude Code + Codex CLI — 를 위한 다운시프트 판단 층)와 어긋나는, "워커를 불신하고 시간에 따라 학습하는 분산형 도구"용 코드를 제거했다. 남긴 핵심은 난이도→등급 라우팅, 크로스-에이전트 디스패치, 테스트 실행 게이트다.

#### Removed

- **독립 verifier attestation** (`verifier.js`의 SHA-256 attestation, 숨은 `verifierCommands`, sterile worktree 재실행 격리, `aorch verify` 명령, `verifier-attestation` 스키마). 완료 게이트를 작업 자신의 `verificationCommands`를 실제 실행하는 **테스트 실행 게이트**로 대체했다. 값싼 변경 검증(claimed==actual diff, read-only 무변경, HEAD 불변, write 격리)은 유지.
- **공급망 trust tier** (trusted/reviewed/untrusted): provider·capability의 trustTier, `controlPlane.providerTrustByRisk`/`capabilityTrustByRisk`, `allowUntrustedProviders`/`allowUntrustedCapabilities`. adapter maturity(stable/experimental)와 challenger 게이트는 유지.
- **데이터 없는 학습 시스템** (`learning.js` 전체): retrospective, TTL lessons, 승인형 improvement proposal, 기술부채 추적, 사용자 feedback, `aorch lessons`, `run --action reflect|feedback|decide`, `post-run-reflection` 스킬, `session-retrospective` 스키마, run의 `reviewStatus`/reflection 게이트.
- **과잉 내구성·운영 기계**: 체크섬·sequence JSONL 저널 envelope, `repairJournal`/`inspectFileStore`, hook용 `journal.mjs`, release harness(`scripts/release-harness.mjs`), 그리고 저장소에 딸려 있던 독립 v0.7.0 handoff 클론·리뷰 산출물. atomic write와 live-PID-aware 파일 락은 유지.

#### Changed

- 모델 성능 관측 매칭을 8차원 → **4차원(provider·model·effort·taskKind)**으로 축소해 솔로 볼륨에서도 셀이 실제로 축적되도록 했다.
- `doctor`의 상태 점검은 active-run pointer 검사로 축소(저널 복구 제거).

## 0.4.0 - 2026-07-16

Critical-review hardening release. Every change below fixes a defect confirmed against the running code (most reproduced empirically) during a full-source review of 0.3.0. Test suite grew from 141 (1 failing) to 172, all passing.

### Correctness and crash fixes

- Handle `EPIPE` on worker stdin: a worker CLI that exits without consuming its prompt no longer crashes the whole orchestrator process.
- Korean gate patterns never matched because JavaScript `\b` has no word boundary next to Hangul; all Korean classification patterns now work.
- Destructive prompts without a development verb (`drop the users table in production`) and destructive prompts padded with display verbs (`... and show me what remains`) now classify high-risk/fail-closed instead of read-only/fail-open.
- Explicit read-only phrasing no longer masks external actions (`deploy ..., do not modify any files`), and Korean negative connectives (`수정하지 말고`) are recognized as explicit read-only intent.
- Bare `order`/`position` no longer escalate everyday prompts (`in order to`, `cursor position`) to critical.
- `--dry-run true` used to silently run a real execution: boolean flags no longer swallow values, unknown options fail loudly, and non-numeric timeouts are rejected instead of disabling the timeout.
- Bounded workers now default to a 60-minute watchdog (explicit `--timeout-ms 0` disables) instead of hanging forever.

### Durable-state hardening

- Stale locks are reclaimed by atomic rename with content verification, closing a race where two reclaimers could both acquire the lock.
- Locks older than a hard ceiling are reclaimable even when the recorded PID appears alive (PID reuse, EPERM); `release()` is retryable after transient unlink failures.
- `doctor --repair` refuses to rewrite a journal when damage precedes valid records; it previously deleted every record after a mid-file corruption.
- Journal payload checksums now hash the JSON round-trip, so `Date`-like values no longer produce permanently unreadable records; appends after a torn tail line start on a fresh line and stay sequence-valid; new journal files fsync their directory entry.
- The hook-side journal counts only parseable records for sequencing, matching `readJournal` semantics.
- Active-run containment checks compare realpaths, so symlinked project aliases are no longer misjudged (and no longer repair-deleted); a pointer to a missing run file blocks the Stop gate instead of silently disabling reflection.
- Task patches are field-whitelisted; a patch can no longer rewrite task `id` or `weight`.

### Routing, trust, and verification

- The router respects `provider.enabled`, uses a locale-independent tie-break, and reports generic ineligibility before the critical challenger gate so an empty candidate set is not misattributed to model maturity.
- `executeTask` reports low confidence when the attestation is inconclusive; capability rejection errors name the actual reason (write vs risk vs opt-in); doctor reports `exit N` when a provider CLI fails silently.
- Removed the unused `saveRun` export, whose blind load-then-save pattern would clobber concurrent updates; all run writes go through the re-reading `mutateRun` path.
- A partial or blocked worker receipt is still compared against actual workspace changes; a lying worker cannot hide in-place mutations behind a non-complete status.
- Attestations report `inconclusive` instead of `pass` when zero checks ran and no change evidence was verified.
- Verifier checks run in a non-login shell so user profiles cannot pollute hashed stdout/stderr evidence.
- Config capability entries no longer receive an implicit `reviewed` trust default, and a user-global artifact colliding with a configured template ID merges with conservative trust instead of inheriting `trusted`.
- Lesson confidence derives idempotently from raw evidence confidence instead of compounding across revisions; an explicit `--limit 0` returns no lessons.
- Empty-task runs report `planning` at 0% instead of `complete` at 100%.

### Install and integration

- Existing settings/hooks JSON is parsed before any file is written, with the file path in parse errors; non-array hook events are rejected with context.
- Codex hooks locate `.aorch/hooks` by upward search, so monorepo package installs work regardless of the git toplevel.
- `schemas/` is installed into `.aorch/schemas/` and skill instructions reference the installed path.
- The shipped review-observation example now uses an effort that the shipped catalog can actually produce.

## 0.3.0 - 2026-07-16

### Control-plane hardening

- Reduced `UserPromptSubmit` to a bounded classifier and minimum-policy injector. Inventory discovery, lessons retrieval, decomposition, routing, and provider execution now occur outside the blocking hook.
- Added risk-first provider and capability trust policy with `trusted`, `reviewed`, and `untrusted` tiers; untrusted capability descriptions are withheld from inventory output.
- Added provider adapter maturity (`stable` or `experimental`), explicit opt-in for untrusted providers, and fail-closed critical routing.
- Capability discovery now rejects instruction-like manifest/frontmatter IDs, falls back to safe directory IDs, and fails closed on cross-type ID collisions.
- Read-only questions about high-risk subject matter remain read-only instead of triggering a durable mutation workflow.
- Write workers now require an isolated linked worktree. Low/standard in-place execution requires explicit `allowInPlaceWrite`; high/critical in-place writes fail closed.
- Separated worker receipts from verifier attestations. Worker output is now a claim, not completion evidence.
- Added verifier-only commands, optional sterile Git-worktree replay, real-diff comparison, command/artifact hashes, and persisted failure attestations.
- Completed write claims require Git evidence, and bounded workers are rejected if they change Git `HEAD` to conceal commits.
- Added `aorch verify` for independent replay of an existing worker claim.

### Durable state

- Added atomic JSON writes using fsync and rename.
- Added locked, sequenced, checksummed JSONL journals with legacy-read compatibility.
- Added partial-tail repair and stale-lock recovery through `aorch doctor --repair`.
- Stale-lock recovery checks whether the recorded owner PID is still alive before reclaiming the lock.
- Added active-run pointer validation and repair.
- Migrated observations and lifecycle fallback logging to the durable journal format.

### Learning and progress governance

- Lessons now require scope tags, evidence, confidence, source runs, advisory status, and expiry.
- Expired or malformed lessons are excluded from retrieval; `aorch lessons --lint` reports governance failures.
- The root hook no longer reads or injects lessons. The root skill loads relevant advisory lessons outside the blocking path.
- Progress now reports phase, confidence, blockers, evidence count, last evidence timestamp, and active tasks in addition to an estimated percentage.
- Progress text neutralizes control characters and malformed lesson files produce lint findings instead of crashing retrieval tooling.

### Adaptive evidence and integration integrity

- Model-performance evidence is stratified by provider, profile, model, effort, task kind, role, risk, and complexity so low-risk observations do not silently promote high-risk routes.
- Standard-risk verification now defaults to an isolated Git worktree.
- Codex hook installation works in non-Git projects by falling back to the current directory, and repeated installation remains idempotent.
- Worker, verifier, and installation artifacts use atomic writes.

### Documentation and compatibility

- Documented the thin-gate architecture, verifier plane, supply-chain trust boundary, file-state repair, and proposal-only self-improvement.
- Kept the dependency-free Node.js runtime and file-first state. No daemon, database, dashboard, nested worker scheduler, or autonomous source mutation was added.

## 0.2.0 - 2026-07-16

### Changed

- Reframed the product around prompt interception, task decomposition, and task-specific capability selection.
- Removed the misleading claim that `quality > tokens > latency` is the orchestrator's universal runtime objective.
- Route decision metadata now reports `task-specific-priority-order`, explicit constraints, and per-stage candidate counts.
- Updated both root skills to start and close durable runs.

### Added

- `aorch run` lifecycle actions: `start`, `task`, `finish`, `show`, `reflect`, `feedback`, and `decide`.
- Durable active-run pointer and terminal review state.
- Post-run retrospective storage with revision support.
- User feedback linked to completed runs.
- Approval-gated improvement proposals that never apply code automatically.
- Enforcement that technical debt introduced by the current run must be resolved with evidence before closure.
- Claude `Stop` and `SessionEnd` review hooks.
- Codex `Stop` review hook.
- `post-run-reflection` skill for both CLIs.
- Session retrospective JSON Schema and examples.
- Bounded operational memory for verified error-prevention rules.
- Lifecycle guards for unsafe run IDs, unresolved active runs, incomplete `completed` states, and retrospective outcome mismatches.
- Additive retrospective revisions that preserve prior findings and proposal decisions.
- Task-specific routing priorities and hard quality/token/latency constraints, with fail-closed validation.
- A separate task-complexity axis that constrains eligible model-effort profiles without conflating difficulty with risk.
- Model-catalog validation for cost indices, effort variants, and adaptive evidence controls.
- Path-safe task run IDs for evidence directories.
- Retrospective input may omit `runId` when the target run is already selected; mismatched explicit IDs still fail closed.
- Honest doctor output that distinguishes executable/catalog checks from unprobed account-level model support.

### Safety

- Harness code, prompts, hooks, skills, plugins, policies, dependencies, adapters, and unrelated project debt require explicit user approval before modification.
- Proposal approval records consent only; implementation happens in a separate orchestrated run.
