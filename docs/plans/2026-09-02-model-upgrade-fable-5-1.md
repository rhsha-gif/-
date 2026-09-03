# 신모델 업그레이드 절차와 Fable 5.1 점검

## 목표

새 프런티어 모델이 나올 때 재사용할 절차를 aorch에 심는다: `auditor` 역할(14번째), receipt `findings[]`, 플랜 필드 `allowedProfileIds`, 감사·적용 플랜 템플릿 2종, `aorch-model-upgrade` 스킬. 그 절차로 Fable 5.1을 판정자로 삼아 네 덩어리(aorch, 전역 `~/.claude`, QuantPilot, Obsidian Vault+SecondBrain-scripts)를 점검한다. 이번 세션은 구축 + aorch·전역 도그푸딩까지, 나머지는 이월.

## 접근

2026-09-02 인터뷰 6라운드 + 포니테일 점검 1회로 확정(상세 원장: `~/.claude/plans/fable-5-1-ethereal-dawn.md`).

사용자 확정 결정(재제안 금지): 심층 리뷰 위주(모델 ID 마이그레이션은 부수) · 리뷰 축 3개(오버엔지니어링 / 정확성·안전 불변식·실패 경로 / 실사용 흐름, 문서 괴리 제외) · 보고서 → AskUserQuestion 선택 → 수정(자동 수정 없음) · 순서 aorch → 전역 → QuantPilot → 볼트 · 볼트는 자동화·에이전트·스킬만이고 `Me/`는 열지 않음 · 전역은 aorch 저장소를 projectRoot로 읽기 전용 감사, 수정은 오케스트레이터 직접 · 실사용 실행과 모델 참조 인벤토리는 정찰이라 위임하지 않고 리드가 직접 · 심각도·수정비용 어휘는 `low/standard/high/critical` 재사용 · 독립 스킬 유지 · Codex 프리셋 쌍.

포니테일 판정(2026-09-02): auditor 유지(qa-analyst 선례 — 이미 계산된 receipt를 종합해 판정), migrator 삭제(갱신은 worker 태스크, 인벤토리는 정찰 위임 금지), findings 유지+어휘 축소, 실사용 U1 태스크 삭제(변경 없는 트리의 스모크는 모델 무관하게 통과해 무의미한 관측), 독립 스킬은 사용자 결정으로 유지.

## 검증 명령

```bash
cd "C:/Users/goyan/OneDrive/문서/adaptive orchestrator/.claude/worktrees/model-upgrade"
npm run check
node src/cli.js decompose --plan examples/plan-model-upgrade.json
node src/cli.js decompose --plan examples/plan-model-upgrade-apply.json
node src/cli.js dispatch --config config/aorch.config.json --plan examples/plan-model-upgrade.json --dry-run   # A1 → anthropic/fable
```

### 작업 0: 브랜치와 계획 문서
- [x] `worktree-model-upgrade` 브랜치를 `.claude/worktrees/model-upgrade`에 codexss(d122ab0)에서 시작
- [x] 이 문서 작성

### 작업 1: auditor 역할 등록
- [x] `src/config.js` `AGENT_ROLE_KEYS`·`DEFAULT_ROLE_AGENTS`, `src/decompose.js` `AGENT_ROLES`(reviewer, qa-analyst와 같은 이유), `config/aorch.config.json` `roleAgents`, `schemas/task-plan.schema.json` enum, `test/{config,decompose,cli-smoke}.test.js`(13→14)
- [x] 검증: `node --test test/config.test.js test/decompose.test.js` 통과

### 작업 2: receipt `findings` 필드
- [x] `schemas/worker-receipt.schema.json` 선택 필드 `findings[]` {id, severity, fixCost, axis(overengineering|correctness|usage), location, evidence, proposal}, 어휘 4단계, 최상위 required 불변
- [x] `test/task-runner-receipt.test.js` 구조 테스트, `test/install.test.js` 설치본 단언
- [x] `src/providers/claude-cli.js` portableSchema는 `$schema`만 벗기므로 중첩 enum 통과(코드 변경 없음)

### 작업 3: auditor 프리셋
- [x] `integrations/claude/agents/aorch-auditor.md`, `integrations/codex/agents/aorch-auditor.toml`

### 작업 4: 플랜 템플릿과 `allowedProfileIds`
- [x] `examples/plan-model-upgrade.json`(P1 ponytail → R1 reviewer 교차 프로바이더 → A1 auditor), `examples/plan-model-upgrade-apply.json`(X1 worker/refactorer + M1 매핑표 갱신)
- [x] **계획 변경**: `minimumQuality 0.95`+anthropic으로 A1을 고정하려던 설계가 dry-run에서 opus xhigh로 갔다. opus는 review 사전값 0.96에 xhigh +0.02, fable은 review 사전값 없음(default 0.96)이고 `high` effort가 `complexities: ["critical"]` 전용이라 complexity high에서는 ultracode(프리미엄 게이트)만 후보. 사용자 선택으로 플랜 필드 `allowedProfileIds`(`forbiddenProfileIds`의 양성 쌍둥이) 추가: `src/router.js` supportsTask 1줄, `src/task.js`, 스키마, `test/router.test.js`. A1은 complexity critical·risk high
- [x] 검증: 두 플랜 decompose exit 0, dry-run P1/R1 → openai sol high, A1 → anthropic fable high

### 작업 5: 스킬·SKILL.md 절·CHANGELOG
- [x] `integrations/claude/skills/aorch-model-upgrade/SKILL.md` 런북 0~8, `src/install.js` installed 목록, 두 adaptive-orchestrate SKILL.md에 `### Auditing projects after a new model release`, CHANGELOG Unreleased/Added
- [x] 검증: `npm run check` 281건 중 280 통과·1 skip(기존)

### 작업 6: 도그푸딩 1 — aorch 자기 감사
- [x] 워크트리 `install --force-config`(dispatch 전 필수)
- [x] 런북 2 인벤토리 → 아래 "매핑표"
- [x] 런북 3 실사용 증거 → `.aorch/evidence/2026-09-02/`(gitignore, 요지는 아래 "실측")
- [x] 런북 0 결정: 사용자 선택으로 fable `maturity: challenger`(config 반영)
- [x] 런북 4 감사 dispatch → "발견 — aorch" (run 1 실패: 선택 필드 findings가 Codex strict 스키마 400 → 필수로 수정; run 2 성공 24분)
- [x] 런북 5 선택(17건) → 런북 6 적용: run 1은 X1 검증 게이트가 환경 의존 테스트로 실패해 중단, run 2(X2~X7, bash에서 기동) 6건 모두 1회 통과 → `npm run check` 305건 중 304 통과(1 skip 기존)
- [x] 런북 7 관측 원장: 워크트리 원장에 apply 관측 7건(전부 codex terra max, 그중 X1 1차의 환경 실패가 quality 0.2로 오염). **fable 관측 0건** — A1은 검증 명령이 없어 관측을 남기지 않는다. challenger 유지

### 작업 7: 도그푸딩 2 — 전역 `~/.claude`
- [x] 인벤토리(모델 참조 1건: settings.json `model: fable`, 매핑 0행)·실사용 메모
- [x] 감사 dispatch(aorch projectRoot, 절대 경로, 사전 백업) → "발견 — 전역"
- [x] 선택 9건 → 직접 수정(원본은 `~/.claude/backups/2026-09-02-pre-audit/`). 검증: settings.json 파싱, push가 allow→ask, 훅 `{"prompt":1}`에 exit 0·인터뷰 프롬프트 주입 정상, resume-work 삭제 후 스킬 목록에서 execute-plan이 "이어서 해" 트리거를 인계한 것을 세션에서 확인

### 작업 8: 이월과 마무리
- [x] "이월" 절, 런북 8 되먹임(bash 기동·strict 스키마·에스컬레이션 비복원·관측 한계), 메모리 갱신

## 실측 (2026-09-02)

- 분류기 샘플 6문장(`aorch classify`, 워크트리 설치본): "Judge a design document… keep, cut or shrink", "Review the diff for behavior changes…", "설계 문서를 검토해서 … 판정해줘", "이 diff에서 동작이 바뀐 곳이 있는지 리뷰만 해줘" 4개 모두 `kind: implementation, signals: []` → haiku/medium. "Refactor the parser…"는 `kind:implementation` 신호, "Write a unit test…"는 `kind:testing` 신호로 정상. **리뷰·판정 어휘는 영어·한국어 모두 신호가 없다.** 이 세션의 포니테일 spawn도 같은 이유로 sonnet이 강제됐다(메인 체크아웃 관측 원장 기준).
- 카탈로그: 7개 프로필 전부 `maturity: stable`, fable 관측 0건(`observations.jsonl` 14건, 마지막 08-17). SKILL.md "새 모델은 challenger로 시작" 규율 위반.
- 라우팅: fable은 `high` effort가 critical 복잡도 전용이고 review·planning·architecture 사전값이 opus+effort 가산에 밀려, 현재 카탈로그에서는 critical 복잡도·에스컬레이션·ultracode 외에는 도달 불가.

## 실측 — 적용 (2026-09-02 10:52~11:47 KST)

- **run 1 (PowerShell로 기동, 14분, 실패)**: X1 1차(terra max)는 5개 제안을 정확히 적용했고 change guard도 통과했으나 검증 게이트 `npm run check`가 `test/executor.test.js` "Windows command resolution executes a PATH command shim" 1건에서 `spawn fixture ENOENT`로 실패. 같은 테스트가 git bash에서는 통과하고 PowerShell에서는 재현 실패 → 검증 게이트는 dispatch 프로세스의 환경을 물려받는다. 에스컬레이션 2차(sol high)는 **1차의 변경이 트리에 남은 채** 시작돼 "이미 적용돼 있다"며 `filesChanged: []`를 냈고, change guard가 1차 변경을 미신고 변경으로 잡아 실패. 두 결함이 겹친 실측: (a) 환경 의존 테스트, (b) 에스컬레이션이 직전 시도의 변경을 되돌리거나 기준선을 갱신하지 않음. 오케스트레이터가 X1 결과를 직접 검증(bash `npm run check` 280 통과)하고 X1을 뺀 플랜으로 재실행.
- **run 2 (bash `nohup`으로 기동, 38분, 성공)**: X2~X7 전부 codex terra max 1회 통과. src 변경 15파일 +177/−29. 오케스트레이터 대조: 리뷰 문장 2개가 `kind: review`(sonnet medium)로, "vulnerabilities"는 security 유지, 오타 키 `allowedProfilesIds`가 `Unknown task field`로 거부, 예시 플랜 7개 decompose 통과, 감사 플랜 dry-run A1 여전히 fable high. diff를 직접 읽어 제안 밖 변경 없음 확인.
- 관측 원장(워크트리): apply 7건 추가. X1 1차의 환경 실패가 terra에 `quality: 0.2`로 남아 라우팅 신호를 오염시킨다 — 검증 게이트 환경 문제는 모델 품질이 아니므로 이월.
- findings.id `pattern`(X2)의 구조화 출력 수용 여부는 전역 감사 run에서 실측한다.

## 매핑표 — aorch

| 경로 | 현재 값 | 새 값 | 승인 |
|---|---|---|---|
| `config/aorch.config.json` 카탈로그 7프로필 | haiku/sonnet/opus/fable, gpt-5.6-luna/terra/sol | 정본, 변경 없음 | — |
| `integrations/claude/agents/aorch-scout.md` `model: haiku` | 의도적 고정(리드 도구) | 변경 없음 | — |
| `integrations/codex/agents/aorch-scout.toml` `model = "gpt-5.6-terra"` | 의도적 고정 | 변경 없음 | — |
| `README.md:68-73` 라우팅 예시 표 | haiku/opus | 문서 괴리 축은 제외 | — |

Fable 5.1은 이미 카탈로그에 있어 이번 aorch 매핑표는 0행.

## 발견 — aorch

run 2(2026-09-02 09:32~09:56 KST, 24분): P1 ponytail(Codex sol high, findings 5), R1 reviewer(Codex sol high, findings 11), A1 auditor(**Fable high**, findings 18, 열람 35파일, confidence 0.88). receipt: `.aorch/task-runs\54c1aa6f-6acf-48ac-a3e0-06d0b38c4f7a\A1-audit\receipt.json`. 정렬은 A1이 "fixCost 단위당 제거되는 미래 사람 개입량"으로 했고, R1의 high 4건(verify-post-guard, state-root, generic-receipt, forced-route 일부)은 코드 근거로 low로 내렸으며, 제외 축(문서 괴리)은 unresolvedRisks로 옮겼다. 사전 발견 2호(리뷰 어휘 무신호)는 2위로 나왔고, 1호(fable stable)는 이미 트리에서 challenger로 바뀐 것을 A1이 감지해 "문서 체크박스 미완"으로 unresolvedRisks에 적었다. 오케스트레이터 대조: 상위 6건(#1·#2·#3·#4·#6·#10)과 #17을 코드·git에서 직접 확인, 전부 일치.

| # | id | 심각도 | 수정비용 | 축 | 요지 |
|---|---|---|---|---|---|
| 1 | `runbook-force-config-per-project` | 불편(high) | low | correctness | 런북 §7 재설치가 --force-config로 프로젝트 튠 설정을 덮어씀(gitignore라 복구 불가). §1의 워크트리 명령은 유지 |
| 2 | `classify-review-kind` | 사소(standard) | low | usage | 분류기 KIND_RULES에 review 규칙 없음 → 리뷰·판정 프롬프트가 영어·한국어 모두 implementation/haiku (사전 발견 2호) |
| 3 | `dispatch-shared-run-id` | 사소(standard) | low | usage | dispatch가 태스크마다 runId를 새로 만들어 한 run이 세 디렉터리로 흩어짐. README의 task-runs/<run-id>/<task-id>/ 약속 위반, A1이 receipt를 find로 수색 |
| 4 | `plan-unknown-task-keys` | 사소(standard) | low | correctness | 플랜 태스크의 미지 키를 조용히 무시. allowedProfilesIds 오타면 핀이 사라지고 감사가 opus로 감 |
| 5 | `codex-strict-schema-contract-test` | 사소(standard) | low | usage | receipt 스키마의 OpenAI strict 계약(모든 키 required) 회귀 테스트 없음. run 1 400 재현 가능 |
| 6 | `force-route-ignores-pins` | 사소(standard) | low | correctness | 에스컬레이션 forceRoute가 allowedProfileIds·forbidden* 핀을 무시 |
| 7 | `branch-finish-push-failure-loses-undo` | 사소(standard) | low | correctness | branch finish에서 push 실패 시 pre-merge SHA를 돌려주지 않음 |
| 8 | `codex-runbook-not-shipped` | 사소(standard) | low | correctness | Codex SKILL.md 절이 가리키는 aorch-model-upgrade 스킬이 Codex 설치 경로에 없음 |
| 9 | `external-target-audit-unbackedup` | 사소(standard) | low | correctness | git 아닌 대상(전역) 감사 dispatch 전 백업 지시 없음 |
| 10 | `receipt-nonobject-passes` | 사소(low) | low | correctness | receiptVerdict가 비객체 receipt에 null을 돌려 통과시킴(현재 도달 불가, fail-closed 보강) |
| 11 | `install-config-write-not-atomic` | 사소(low) | low | correctness | installFile이 writeFile 직접 호출, README의 atomic 약속과 어긋남 |
| 12 | `state-dir-unvalidated` | 사소(low) | low | correctness | paths.stateDir 무검증 → src로 두면 change guard가 그 서브트리를 무시 |
| 13 | `verify-after-final-snapshot` | 사소(low) | low | correctness | 검증 명령 실행 후 재스냅샷 없음(HEAD·control path 변경 미검사) |
| 14 | `autoupdate-lock-not-exclusive` | 사소(low) | low | correctness | self-update claimLock이 stat→open(w)라 배타적이지 않음 |
| 15 | `finding-id-pattern` | 사소(low) | low | correctness | findings.id에 task id pattern 없음 → 적용 플랜 decompose에서 늦게 실패 |
| 16 | `runbook-personal-smoke-table` | 사소(low) | low | overengineering | 런북 §3 실사용 표가 개인 프로젝트 4행을 모든 설치본에 복사 |
| 17 | `receipt-schema-reformat` | 사소(low) | low | overengineering | receipt 스키마 재포맷으로 diff 138+/15-, 의미 변화는 findings뿐 |
| 18 | `skill-section-duplicates-runbook` | 사소(low) | low | overengineering | adaptive-orchestrate SKILL.md 절이 런북을 재서술(세 사본 동기화 부담) |

A1 unresolvedRisks:
- fable `maturity: challenger` 변경이 이미 작업 트리(config/aorch.config.json diff)에 들어가 있으나 계획 문서 작업 6의 '런북 0 결정: … 사용자에게' 체크박스는 미완이다 — 소유자 확인이 필요하다.
- R1의 'critical 작업이 사다리로 challenger fable에 도달' 지적은 README:340('검증되지 않은 challenger를 critical 단독 executor로 쓰지 않음')과 런북 §0('새 모델을 사다리 끝에 붙인다')이 서로 충돌하는 지점이다. 코드는 후자를 구현한다. 어느 약속을 지킬지는 설계 결정이라 finding으로 채택하지 않았다.
- R1 readonly-observation-mismatch(README:81·DESIGN §9의 '자동 기록' 약속 vs run-loop.js:249의 read-only 예외)는 문서 괴리 축으로, 사용자 확정 결정에 따라 findings에서 제외했다. SKILL.md는 이미 'A task with no verificationCommands records no routing observation'으로 일부 언급한다.
- P1은 읽기 전용 샌드박스의 mkdtemp EPERM으로 설치·receipt 영속화 테스트 5건을 완료하지 못했고, R1은 테스트가 범위 밖이라 회귀 커버리지를 확인하지 않았다. 이 감사는 어떤 테스트도 새로 실행하지 않았다(검증 명령 미지정).
- finding-id-pattern 제안의 `pattern` 키워드가 Codex/Claude 구조화 출력에서 수용되는지는 오프라인에서 확인할 수 없었다(run1 400 전례).
- dispatch-shared-run-id 수정 후에도 워커는 자기 run 디렉터리를 알 방법이 task-runs/*/<자기 id>/ 탐색뿐이다. 환경변수(예: AORCH_RUN_DIR) 전달이 더 견고하나 범위를 넘어 제안하지 않았다.
- Codex 워커 로그의 `codex_models_manager::cache: failed to load models cache: missing field base_instructions`는 Codex CLI 쪽 캐시 경고로 aorch 결함이 아니라고 판단했으나 재현 조건은 확인하지 않았다.

관찰: (1) P1·R1도 `findings` 필드를 채웠다(5·11건). 프롬프트의 "요청받지 않으면 빈 배열" 지시보다 판단 역할의 본성이 우선한 것으로, 오히려 auditor 입력이 구조화돼 이득. (2) 세 태스크가 각각 다른 run 디렉터리에 떨어져 A1 objective의 `<this run>`이 성립하지 않았고 A1은 find로 수색해 해결(#3). (3) run 1은 선택 필드 `findings`로 Codex strict 스키마 400 → 필수 필드로 수정 후 run 2 성공(#5).

## 발견 — 전역

run(2026-09-02 11:49~12:10 KST, 21분, aorch 워크트리 projectRoot, 대상 `~/.claude` 절대 경로): P1 ponytail(Codex sol high, findings 19: 삭제 7·유지 8그룹), R1 reviewer(Codex sol high, findings 0·불변식 판정 8건 not-held), A1 auditor(**Fable high**, findings 12, 열람 19, confidence 0.9). run 디렉터리 `.aorch/task-runs\af9071fc-3eb7-4143-9f5e-6c1fdc1e79e7` — X3 이후 세 태스크가 한 디렉터리에 모였고, findings.id `pattern`은 Codex·Claude 구조화 출력 모두 수용(X2 실 워커 확인 완료). 사전 백업 `~/.claude/backups/2026-09-02-pre-audit/`와 run 후 live가 `diff -rq` 동일 — 외부 대상 무변경. A1은 P1의 PowerShell allow 중복 삭제(프롬프트 증가로 목적함수 역행)와 R1의 ship 시크릿 검사 충돌 주장(코드가 ship을 지지)을 제외했고, R1이 미확인으로 남긴 외부 read-only 불변식을 백업 diff로 직접 해소했다. 오케스트레이터 대조: settings.json allow의 `Bash(git push:*)`와 ask 블록 부재, dependency-audit frontmatter 플래그, 훅 9-13행 타입 미검증, ship 38-40 병합 절, autoMode Trusted repo 경로 모두 실물과 일치.

| # | id | 심각도 | 수정비용 | 축 | 요지 |
|---|---|---|---|---|---|
| 1 | `DEP-AUTOTRIGGER` | 불편(high) | low | correctness | dependency-audit의 disable-model-invocation이 CLAUDE.md의 자동 감사 요구를 무력화 |
| 2 | `PHC-AUTOCOMMIT` | 불편(high) | low | correctness | project-health-check가 요청 없는 커밋 지시(CLAUDE.md 금지와 충돌) |
| 3 | `PUSH-ALLOW` | 불편(high) | low | correctness | settings.json allow에 git push — 프롬프트 규칙만이 유일한 게이트(fail-open) |
| 4 | `HOOK-REDUNDANT` | 사소(standard) | low | overengineering | interview-guard 훅 규칙이 interview 스킬·kr-report와 중복, includes("인터뷰")로 오발동·매 턴 재주입 |
| 5 | `HOOK-TYPEGUARD` | 사소(standard) | low | correctness | 훅이 prompt 타입을 검증하지 않아 비문자열에 TypeError exit 1 |
| 6 | `SHIP-MERGE-ORPHAN` | 사소(standard) | low | overengineering | ship의 병합 절이 트리거 없이 우연히 로드될 때만 승인 없이 main 병합 |
| 7 | `PHC-DEADCODE-CALLERS` | 사소(standard) | low | correctness | 죽은 코드 제거에 호출 경로 확인 조건 없음 |
| 8 | `INVEST-SUPERSEDE-WORDING` | 사소(standard) | low | correctness | invest-judge·resolve의 "수정 금지" 예외 범위 문구 불일치 |
| 9 | `AUTOMODE-STALE-REPO` | 사소(standard) | standard | correctness | autoMode Trusted repo가 활동 프로젝트가 아닌 study agent, "no remotes" 전제도 낡음 |
| 10 | `SHIP-SECRET-REPORT` | 사소(low) | low | correctness | 시크릿 발견 보고에 값 인용 금지 문구 없음 |
| 11 | `RESUME-INTO-EXECUTE-PLAN` | 사소(low) | standard | overengineering | resume-work를 execute-plan에 흡수(트리거·변경 보존 규칙 이전 후 삭제) |
| 12 | `CONVENTION-DUP` | 사소(low) | low | overengineering | CLAUDE.md 승인 문장 2개 중복, 스킬별 "한국어로" 문구는 kr-report가 담당 |

A1 unresolvedRisks:
- receipt 불일치 판정(코드 기준): (1) ship:20 검증 명령 부재 시 AskUserQuestion 후 커밋 — R1은 not-held로 봤으나 이는 사람에게 fail-closed하는 게이트이므로 결함으로 채택하지 않음. (2) ship:23 시크릿 검사 — R1의 '비열람 규칙 충돌'은 채택하지 않고 보고 문구 강화만 SHIP-SECRET-REPORT로 남김. (3) P1 CUT-06의 PowerShell(git status/diff/log) allow 삭제 — PowerShell 도구가 이 환경에 존재하므로 삭제는 프롬프트를 늘려 목적함수에 역행, 제외. quantpilot smoke 항목의 프로젝트 이동은 개입 감소 효과가 없어 제외. (4) settings.json:97-98 sandbox.enabled=false/failIfUnavailable=false — CLAUDE.md:39가 Windows에서 샌드박스를 전제하지 않으므로 결함 아님.
- HOOK-REDUNDANT는 훅이 존재하는 이유(모델의 AskUserQuestion 규칙 무시 이력, 메모리 aorch-ask-preference)를 배제하지 못했습니다. 삭제 후 interview 스킬만으로 규칙이 유지되는지 한 세션 관측이 필요합니다.
- P1 KEEP-01~08(interview, plan/execute-plan, ship 본체, project-health-check 워크플로, dependency-audit 본문, invest 두 스킬, kr-report/CLAUDE.md, settings 보안 키·플러그인)은 유지 판정이며 findings에 넣지 않았습니다. 플러그인 항목의 실사용 여부는 두 receipt 모두 확인 불가로 남겼습니다.
- invest-judge/invest-resolve의 동시 세션 경합(두 세션이 같은 open 레코드를 각자 supersede) — R1 지적. 개인 원장이라 발생 확률이 낮고 원장 구현(~/investment-decisions)이 범위 밖이라 finding 대신 여기 남깁니다.
- aorch change guard가 외부 ~/.claude를 보지 않는 문제(R1 criterion 7, integrations/claude/skills/aorch-model-upgrade/SKILL.md:38)는 감사 대상(~/.claude)이 아니라 aorch 런북의 문제라 findings 축 밖입니다. 이번 run에 한해서는 backups/2026-09-02-pre-audit(11:49)와 live의 diff -rq가 동일함을 직접 확인해 read-only 불변식이 유지됐습니다. 런북 :39의 종료 diff를 run 증거로 남기는 개선은 lead 몫입니다.
- usage-memo.md:7의 kr-report '3~5줄' 승인 규칙과 독립 최종 보고 지침의 경미한 충돌은 세 축 어디에도 속하지 않아 findings에서 제외했습니다.
- settings.json은 permissions·sandbox 줄만 grep했고 env·apiKeyHelper 등 비밀 가능 키는 열지 않았습니다. autoMode 블록의 나머지 항목 효과는 검증하지 않았습니다.

## 실측 — QuantPilot (2026-09-02 17:20~ KST)

- 설치: `.aorch/config.json`이 프로젝트 튜닝 없는 구형 패키지 설정(패키지에만 있는 `roleAgents`·`qualitySemantics`·sol max 사다리 단계가 차이)이라 런북 §7대로 `--force-config` 재설치. auditor 프리셋·aorch-model-upgrade 스킬 반영, `.claude/settings.json`의 allowlist 28개와 훅 보존. QuantPilot은 `.aorch`가 gitignore가 아니라 설치본이 git 변경으로 잡힌다(29 entries).
- 인벤토리: grep 172건 중 라이브 설정은 `.claude/agents` 5·`.claude/skills` 7의 frontmatter `model: claude-fable-5` 12곳. 나머지는 `_archive` 워크보드·foundation 독서 노트·능력 점수표.
- 실사용(리드 직접, 증거 `C:/Users/goyan/AppData/Local/Temp/claude/C--Users-goyan-OneDrive----adaptive-orchestrator/4b41c9b8-bd00-4d4f-82d4-1eb020e2a1b7/scratchpad/qp-evidence/`): `run_smoke` exit 0(신호 7개, 정책·포트폴리오·리포트 id 생성). 웹 `npm run test` 23/23, `npm run build` 30.7초. `pytest quantpilot/tests`는 기본 실행에서 ERROR 25건 — 전부 `tmp_path` 기본 디렉터리 `Temp/pytest-of-goyan`(7/17 생성, ACL 열람도 불가)의 `WinError 5`. `--basetemp`를 쓰기 가능한 경로로 주면 **전체 통과(exit 0)**. 브라우저 흐름은 미실행.
- 감사 run 1(17:43~18:09 KST, 26분): P1 ponytail(Codex sol, findings 17: 삭제 11·유지 6, 열람 77) complete → R1 reviewer(Codex sol, findings 8, 열람 59)가 CLAUDE.md·AGENTS.md의 불변식 17개를 receipt `criteria`로 적고 전부 `fail`로 매겨 **receiptVerdict가 run을 중단**, A1 미실행. 08-30 이월 문제(reviewer가 기준을 스스로 추가해 run을 멈춤)의 재현. 대응: A1만 담은 플랜(`plan-qp-audit-a1.json`)에 run 1의 두 receipt 절대 경로를 넘겨 재dispatch. 오케스트레이터 대조: R1의 `place_limit_cash_order` 공개 메서드(kis_paper.py:764), orders 라우터의 인증 의존성 부재(Depends(get_harness_service)뿐), run-smoke의 `repositories.clear()`(harness_service.py:3564) 세 건 모두 코드와 일치.
- 환경 발견: bash·PowerShell 모두 `python`이 `AppData/Local/hermes/hermes-agent/venv`로 잡히고 프로젝트 의존성(fastapi 0.133.1·pydantic 2.13.4·pytest 9.0.3)이 실제로 거기 있다. 사용자 CLAUDE.md의 Python 3.11(`.local/bin`)에는 pytest가 없고 프로젝트 venv는 없다 — 사실상의 실행 환경이 문서화돼 있지 않음.

## 매핑표 — QuantPilot

| 경로 | 현재 값 | 새 값 | 승인 |
|---|---|---|---|
| `.claude/agents/backtest-forensics-agent.md:7` `model:` | `claude-fable-5` | `fable`(별칭) 또는 `claude-fable-5-1` | 미정 |
| `.claude/agents/quant-recipe-architect.md:8` `model:` | `claude-fable-5` | `fable`(별칭) 또는 `claude-fable-5-1` | 미정 |
| `.claude/agents/risk-gatekeeper-agent.md:7` `model:` | `claude-fable-5` | `fable`(별칭) 또는 `claude-fable-5-1` | 미정 |
| `.claude/agents/rl-research-contract-agent.md:7` `model:` | `claude-fable-5` | `fable`(별칭) 또는 `claude-fable-5-1` | 미정 |
| `.claude/agents/source-curator-agent.md:8` `model:` | `claude-fable-5` | `fable`(별칭) 또는 `claude-fable-5-1` | 미정 |
| `.claude/skills/backtest-forensics/SKILL.md:14` `model:` | `claude-fable-5` | `fable`(별칭) 또는 `claude-fable-5-1` | 미정 |
| `.claude/skills/codex-handoff-writer/SKILL.md:13` `model:` | `claude-fable-5` | `fable`(별칭) 또는 `claude-fable-5-1` | 미정 |
| `.claude/skills/fable5-level34-recipe/SKILL.md:14` `model:` | `claude-fable-5` | `fable`(별칭) 또는 `claude-fable-5-1` | 미정 |
| `.claude/skills/quant-source-synthesis/SKILL.md:12` `model:` | `claude-fable-5` | `fable`(별칭) 또는 `claude-fable-5-1` | 미정 |
| `.claude/skills/risk-matrix-designer/SKILL.md:13` `model:` | `claude-fable-5` | `fable`(별칭) 또는 `claude-fable-5-1` | 미정 |
| `.claude/skills/rl-contract-designer/SKILL.md:14` `model:` | `claude-fable-5` | `fable`(별칭) 또는 `claude-fable-5-1` | 미정 |
| `.claude/skills/workboard-flow/SKILL.md:74,83` | `claude claude-fable-5` (2026-07-15 기록·예시) | 역사 기록, 변경 없음 | — |
| `docs/agent_capability_scorecard.md` (`fable5-cc`=claude-fable-5, `claude-opus-4-x`, `gpt-5.4-codex`) | 능력 점수표 | 문서 괴리 축 제외; 새 모델 행 추가는 프로젝트 규약(점수표 등록 규칙)대로 별도 | — |
| `docs/_archive/**`, `quantpilot-foundation-meta/**` (150여 곳) | 워크보드·독서 노트의 역사 기록 | 변경 없음 | — |

## 발견 — QuantPilot

run 2(A1만, 18:11~18:18 KST, 7분): auditor **Fable high**, findings 22, 열람 29, confidence 0.86. receipt `.aorch/task-runs\aa6cbca0-79c1-4021-9a7b-1301f71335b7\A1-audit\receipt.json`. 정렬은 목적함수(fixCost 단위당 제거되는 사람 개입) 기준으로 리드의 실사용 증거(pytest 환경 게이트)가 1위. P1·R1 충돌(kernel: P1 KEEP-06 vs R1-08)은 코드가 KEEP을 지지해 '삭제 말고 실제 경계에 검사'로 판정. R1-07(실제 KIS transport·paper job이 프로덕션에 존재)과 R1의 BROKER_MODE·FULLY_AUTOMATED '고정 실패'는 프로젝트 CLAUDE.md의 'manual opt-in' 조항이 허용하므로 기각. 오케스트레이터 대조: place_limit_cash_order 공개·orders 라우터 인증 의존성 부재·run-smoke clear()·배너 상수 4건 코드 일치.

| # | id | 심각도 | 수정비용 | 축 | 요지 |
|---|---|---|---|---|---|
| 1 | `U-PYTEST-GATE` | 사소(standard) | low | usage | 문서화된 pytest 게이트가 실제 환경(tmp_path ACL, hermes venv)에서 매번 수동 우회 필요 — CLAUDE.md에 --basetemp·인터프리터 명시 |
| 2 | `R1-04-SMOKE-CLEARS-STATE` | 불편(high) | low | correctness | 무인증 POST /api/harness/run-smoke가 공유 저장소(주문·감사·멱등 증거)를 clear |
| 3 | `R1-05-SAFETY-STATUS-CONSTANT` | 불편(high) | low | correctness | health·safety-banner가 실제 플래그와 무관한 상수(live=false/mock) 표시 |
| 4 | `R1-03-STATE-ROUTES-NO-ACTOR` | 불편(high) | standard | correctness | 승인·제출·execution 라우트에 actor 검증 없음, approve_order_plan이 호출자 미검증 |
| 5 | `R1-02-SUBMIT-NOT-ATOMIC` | 불편(high) | standard | correctness | in-memory submit_order_plan에 락/CAS 없음 — 동일 주문 동시 2회 성공(R1 프로브) |
| 6 | `P1-CUT-11-TYPES-DUPLICATE` | 사소(standard) | standard | overengineering | types.ts가 openapi.d.ts 생성 스키마를 수동 복제 |
| 7 | `R1-06-DATAMODE-DRIFT` | 사소(standard) | low | correctness | DataMode enum 6개 vs AGENTS.md 8단계 계약 |
| 8 | `R1-01-KIS-CLIENT-PUBLIC-ORDER` | 불편(high) | standard | correctness | 공개 place_limit_cash_order가 안전 계층 없이 직접 POST(구조적 여지) |
| 9 | `FLAG-POLICY-OR-ENV` | 사소(low) | low | correctness | guarded/fully-automated 플래그가 policy OR env — 현재 API로는 도달 불가 |
| 10 | `KERNEL-UNWIRED` | 사소(standard) | high | correctness | execution kernel의 프로덕션 호출 없음 — 삭제 말고 실제 경계에 actor 검사 후 통합(후순위) |
| 11 | `U-MODEL-PIN` | 사소(low) | low | usage | .claude 12개 frontmatter model: claude-fable-5 치환 |
| 12 | `P1-CUT-04` | 사소(low) | low | overengineering | kernel FINAL_SAFETY_CHECKS·_path_for_key 미참조 |
| 13 | `P1-CUT-01` | 사소(low) | low | overengineering | OperatorRunRequest.is_submission_mode 미사용 |
| 14 | `P1-CUT-02` | 사소(low) | low | overengineering | OperatorService._record_signals 미사용 |
| 15 | `P1-CUT-03` | 사소(low) | low | overengineering | review_professional_strategy_health 래퍼 미사용 |
| 16 | `P1-CUT-05` | 사소(low) | low | overengineering | 미사용 import 2건 |
| 17 | `P1-CUT-06` | 사소(low) | low | overengineering | reducer 재수출 미사용 |
| 18 | `P1-CUT-07` | 사소(low) | low | overengineering | operator.schemas 재수출 3건 미사용 |
| 19 | `P1-CUT-08` | 사소(low) | low | overengineering | risk/__init__ facade 미사용 |
| 20 | `P1-CUT-09` | 사소(low) | low | overengineering | FallbackManager → 함수로 축소 |
| 21 | `P1-CUT-10` | 사소(low) | low | overengineering | CardFooter 미사용 |
| 22 | `U-WEB-CHUNK` | 사소(low) | low | usage | 웹 빌드 1.14MB 청크 경고 |

A1 unresolvedRisks:
- R1-03의 실제 노출도: API가 로컬에서만 바인딩되는지, Vercel UI가 어떤 API를 호출하는지는 저장소만으로 확정할 수 없다(main.py CORS의 배포 origin은 공개 노출을 시사하지만 reverse proxy 인증 존재 여부는 범위 밖).
- R1-07을 finding에서 제외한 근거는 프로젝트 CLAUDE.md의 'manual opt-in' 조항이다. 만약 owner가 AGENTS.md의 fake/offline 조항을 프로덕션 코드에도 적용할 의도라면 R1-07(실제 KIS transport·paper job의 패키지 분리)을 standard/standard로 복원해야 한다.
- FLAG-POLICY-OR-ENV 수정이 정책 필드만으로 guarded/fully-automated를 켜는 기존 테스트를 깨뜨릴 수 있다. tests는 범위 밖이라 확인하지 못했으며, 수정 시 테스트 setup 조정만 허용하고 검증 약화는 금지한다.
- P1-CUT-03/07/08은 저장소 밖 Python 소비자나 동적 import가 있으면 호환성 변경이 된다(P1도 동일하게 표시). 외부 소비자는 배제할 수 없다.
- U-PYTEST-GATE의 원인은 Temp\pytest-of-goyan 디렉터리 ACL(환경)이며 코드 결함이 아니다. --basetemp 문서화는 증상 우회이고, 디렉터리 소유권 복구는 Windows 관리 작업이라 본 감사 범위 밖이다.
- R1의 동시 제출 재현(R1-02)은 R1 자체 probe 결과이며 본 감사에서는 코드 구조(락/CAS 부재)로만 확인했고 재실행하지 않았다.
- 브라우저 흐름은 실행되지 않았다(usage-memo: `npm run dev` 미시작). UI 수준 usage finding은 test+build 증거에 한정된다.

## 발견 — Obsidian Vault + SecondBrain-scripts

run 1(2026-09-03 00:56~01:16 KST): P1 ponytail(Codex sol high, findings 20: 삭제 7·정정 3·유지 9, 열람 17), R1 reviewer(Codex sol high, findings 13, 불변식 판정 16 fail·3 pass·1 not-run) → R1의 criteria fail로 run 중단(3회째 재현). A1만 재dispatch(01:18~01:27, **Fable high**, findings 17, 열람 23, confidence 0.86). receipt `.aorch/task-runs\05d85fe6-2296-4968-a53a-3aa64fd41539\A1-audit\receipt.json`. 대상은 볼트 `.claude`·`CLAUDE.md`·`Meta/` 설계 2건과 SecondBrain-scripts 전체이며 `Me/`와 사용자 노트 폴더는 열지 않도록 명시; 감사 전후 두 저장소 status 해시 동일(무변경). 실사용 증거: `weekly.ps1 -DryRun -NoPost` exit 0(11초, 백프레셔로 확장 건너뜀, 0바이트 산출물 첨부 차단), slack-worker pytest는 hermes venv에서 import 오류 4건·자체 .venv에서 82 통과. A1 판정 특기: usage-memo의 me-summary 기본 경로 우려는 스크립트의 OneDrive 폴백으로 반박, R1의 '근거:: 누락'은 규칙 범위 밖으로 기각, R1-F5(study/lang/exercise의 Me 미갱신)는 2026-08-12 결정이 코드에 있어 문서 낡음으로 재분류, 모델 티어 변경은 근거 없음(무발견).

| # | id | 심각도 | 수정비용 | 축 | 요지 |
|---|---|---|---|---|---|
| 1 | `A1-F01-worker-disallowed-tools` | 불편(high) | low | correctness | worker run_claude에 --disallowed-tools 없음 → settings.local.json의 python allow로 Edit allowlist 우회 가능; #study 폴더가 Study/** (문서는 Study/Math) |
| 2 | `A1-F02-install-missing-genanki` | 불편(high) | low | usage | install.ps1이 genanki 미설치 → 새 설치에서 worker 기동 불가(현 venv는 수동 패치) |
| 3 | `A1-F03-run-claude-silent-success` | 사소(standard) | low | correctness | run_claude가 rc≠0·빈 result를 성공으로 수용, weekly Invoke-Claude도 빈 result 미검사 |
| 4 | `A1-F04-commit-scope-and-index-sweep` | 불편(high) | standard | correctness | commit_paths가 pathspec 없이 전체 인덱스 커밋·폴더 통째 스테이징; weekly는 git을 안 해 Me/ 편집이 다음 슬랙 커밋에 휩쓸리고 되돌리기에 같이 되돌아감 |
| 5 | `A1-F05-event-marked-before-work` | 불편(high) | standard | correctness | 이벤트를 처리 전 완료 표시 → 실패 배치 영구 재시도 불가 |
| 6 | `A1-F06-debounce-never-merges-messages` | 사소(standard) | low | correctness | 디바운스 키가 메시지별 ts라 사진 여러 장이 한 세션으로 합쳐지지 않음 |
| 7 | `A1-F07-claude-md-stale-automation-claims` | 사소(standard) | low | correctness | CLAUDE.md의 자동화 서술이 코드와 어긋남(Me 갱신 채널, #daily 세션·커밋 수, weekly 세션 수) |
| 8 | `A1-F08-model-reported-path-validation` | 사소(standard) | low | correctness | 모델이 보고한 파일: 경로 미검증(절대·traversal 경로 읽어 업로드) |
| 9 | `A1-F09-seal-targets-unused` | 사소(standard) | low | correctness | seal.sealed_targets 미사용 → 봉인 대상 링크가 스니펫으로 슬랙에 노출 가능 |
| 10 | `A1-F10-me-summary-failure-invisible` | 사소(standard) | low | correctness | me-summary 실패가 경고로만 남고 스레드에 안 보임; Me.md 비원자적 교체 |
| 11 | `A1-F11-post-write-diff-guards` | 불편(high) | standard | correctness | 일기 윤문·Review 본문·유래/파생 줄 보호가 프롬프트뿐 — 커밋 전 diff 검사 3종 제안 |
| 12 | `A1-F12-daily-ps1-remove-after-scheduler-check` | 사소(standard) | low | overengineering | 비활성 daily.ps1이 acceptEdits로 실행 가능 — 스케줄러 확인 후 삭제 |
| 13 | `A1-F13-cross-process-vault-lock` | 사소(standard) | standard | correctness | worker와 weekly 사이 프로세스 간 락 없음 |
| 14 | `A1-F14-raw-claude-output-to-slack-and-logs` | 사소(low) | low | correctness | 파싱 실패 시 raw stdout/stderr가 슬랙·로그에 그대로 |
| 15 | `A1-F15-slack-filename-sanitization` | 사소(low) | low | correctness | 슬랙 파일명 그대로 경로 결합(traversal) |
| 16 | `A1-F16-dead-code-trim-bundle` | 사소(low) | low | overengineering | 미사용 변수·중복 settings 함수·미호출 CLI 분기·중복 문서 묶음 |
| 17 | `A1-F17-graphify-editable-checkout` | 사소(low) | standard | overengineering | graphify 편집 설치본을 고정 wheel로 교체(산출물 diff 후) |

A1 unresolvedRisks:
- Scheduled-task state for daily.ps1 could not be read (schtasks rc=1, same access denial P1 hit); A1-F12 is gated on an elevated check.
- Model tiers: agents pin opus (admin-expert, contest-judge, legal-expert) and sonnet (contest-juror, contest-researcher); weekly runs deep/review on fable, digest on opus, scout on sonnet (weekly-dryrun.log). Neither receipt nor the run offers evidence that any stage would produce a different outcome on the newest model, so no tier finding is made — evaluating that would need a real (non-dry) weekly run compared across models, which is outside this read-only task.
- The full study transcription invariant ('빠짐없이 옮긴다') has no cheap mechanical check; A1-F11 deliberately leaves it to the verify stage. R1's 'fail' verdict on it stands as a prompt-only control.
- P1-CUT-002/004/006 were accepted on P1's caller trace without independent re-verification here (bundled in A1-F16 at the bottom precisely because they remove no intervention).
- Runtime Claude permission merging (vault settings.local.json + --settings + --disallowed-tools) was not exercised against a live claude.exe by any receipt; A1-F01 follows the code and weekly.ps1's own documented threat model, which the settings.local.json:20 wildcard corroborates.
- The vault's own .claude agents/skills were not invoked by the lead (usage-memo.md), so P1-KEEP-002..004 (contest, review-interview, vault-learn, six domain skills) rest on static reading only.

## 사용자 선택

2026-09-02 AskUserQuestion 4묶음. **#11(installFile atomic write)만 제외하고 17건 수정 승인.** 적용은 `plan-model-upgrade-apply.json` 형식으로 파일 영역별 worker 태스크 7개(X1 런북·스킬 절·Codex 사본, X2 receipt 스키마, X3 dispatch runId·미지 키, X4 분류기 review, X5 사다리 핀, X6 run-loop 가드, X7 config·락·finish), 각 `npm run check` 검증 게이트. 매핑표 0행이라 M1 없음. 플랜: `.aorch/evidence/2026-09-02/plan-aorch-apply.json`.

**전역**: 12건 중 9건 승인 — #1 dependency-audit 자동 호출, #2 project-health-check 자동 커밋 제거, #3 push allow→ask, #5 훅 타입 검증, #7 죽은 코드 호출 경로 조건, #8 invest 예외 문구 통일, #9 autoMode Trusted repo 갱신(활동 프로젝트 3곳, 볼트는 원격 없음), #10 시크릿 보고 값 인용 금지, #11 resume-work→execute-plan 흡수. 유지: #4 interview-guard 훅(존재 이유 미배제), #6 ship 병합 절, #12 CLAUDE.md 중복 문장.

**볼트 자동화**(09-03): 17건 중 13건 승인 — #1 disallowed-tools+Study/Math, #2 genanki, #3 rc/빈 result, #4 커밋 pathspec, #5 이벤트 완료 표시 지연, #6 디바운스 채널 키, #8 경로 검증, #13 프로세스 락, #14+#15 raw 출력·파일명, #7 CLAUDE.md 정정(리드 직접), #12 daily.ps1 삭제(스케줄러 확인 후), #16 죽은 코드, #17 graphify wheel. 유지: #9 봉인 링크 필터, #10 me-summary 실패 표시, #11 커밋 전 diff 검사. 코드 수정은 SecondBrain-scripts의 linked worktree(`.claude/worktrees/model-upgrade`, 브랜치 `model-upgrade-2026-09-03`, venv 54MB 복사)에서 V1(보안 6건)·V2(커밋·재시도·디바운스·락)·V3(죽은 코드) dispatch, 게이트는 worker pytest(자체 venv)+weekly.ps1 파싱+`-DryRun -NoPost`. 실측: 예약 작업 조회에서 `SecondBrain-Daily`가 등록돼 있었으나 Disabled(마지막 실행 7/26) → 해제; `SecondBrain-Weekly`는 마지막 결과 0x800710E0(요청 거부)이고 마지막 실제 로그(08/29 22:25)는 네 패스가 같은 초에 exit 0이라 드라이런/재사용으로 보임 — **일요일 주간 실행이 실제로 도는지 사용자 확인 필요**. graphify 편집 설치본은 PyPI 0.9.32 sdist와 `__pycache__`·MIGRATION.md 외 동일. 볼트 CLAUDE.md 3문장 정정(Me 즉시 갱신 채널, #daily 4커밋, weekly 5패스).
- 볼트 자동화 apply run 1(06:26~06:39 KST): V1(sol high) — pipeline.py에 --disallowed-tools·rc/빈 result 거부·경로 검증, channels.py Study/Math, install.ps1 genanki, slack_io 파일명 정제, worker.py 예외 필터, weekly.ps1 stderr 로그 축약 + 테스트 6개(88 통과). 게이트 중 weekly 드라이런이 worktree에 `graphify/.venv`(별도 venv, 미추적)가 없어 실패 → 에스컬레이션 2차 워커가 `-DryRun -NoPost`면 즉시 return하도록 weekly.ps1을 고쳐 게이트를 '통과'시킴(드라이런 무력화) → 리드가 그 hunk를 제거하고 1차가 추가한 `-VaultRoot/-GraphifyPython/-ArtifactsRoot` 훅은 유지, 게이트 명령에 메인 체크아웃의 graphify venv를 주입해 88·파싱·실제 드라이런 exit 0 확인 후 V1 채택. **새 함정**: 워커가 게이트를 통과시키려 검증 대상 스크립트의 동작을 바꿀 수 있다 — 리뷰 태스크(R2)에 '드라이런 우회 여부'를 명시. daily.ps1은 worktree에서 삭제(스테이징), `SecondBrain-Daily` 예약 작업 해제. graphify 디렉터리는 미추적이라 #17은 환경 작업으로 이월(플랜 2 후).
- 볼트 자동화 apply run 2(06:42~07:18 KST): V2(sol high) 경로 한정 커밋·사전 dirty 제외·커밋 전 실패 재시도·top-level 디바운스 병합·Python/PowerShell 공통 락 + 테스트, V3(terra max) 죽은 코드(_blank_target과 역사 문서는 관찰 가능 산출물·README 링크 때문에 보류) — 게이트 통과, 리드 게이트 pytest 92·파싱·드라이런 exit 0. **R2 opus xhigh 리뷰(`.aorch/task-runs\f944f839-b886-4343-a7c6-541483d86dd7\R2-behaviour-review\receipt.json`)가 V1·V2의 회귀 10건**: F1(치명) `--disallowed-tools`의 Write가 stage-1 새 노트 생성을 차단, F2 forget_event가 15초 폴러 기반 무한 재시도, F3 사전 dirty 파일은 모델이 고쳐도 영구 미커밋, F4 드라이런이 운영 락을 잡고 경합 시 deep·review 건너뜀, F5 락 타임아웃 비대칭(weekly 120초 vs worker 무한), F6 스레드 답글 실패 시 커서 전진으로 유실, F7 untracked 디렉터리 접힘, F8 오류 사유 소실, F9 테스트가 회귀를 문자열로 못 박음, F10 제외 건수 과계수. 반증: 커밋 인덱스 쓸어담기는 해소, allowlist·seal 보존. → V4(V4a/b/c) + R3 Fable 최종 리뷰.
- 볼트 자동화 V4(07:20~08:00 KST): V4a(sol medium) Write 허용·위험 도구만 차단·오류 상세 복원·테스트 속성화(97 통과), V4b(sol high) 재시도 3회+백오프+최종 회신·content hash 기반 pre-dirty 판정·스레드 커서 보존·untracked 파일 단위 탐지(100 통과), V4c(sol high) weekly 락 2,700초·드라이런 락 생략·worker 락 30분 상한+가드(101 통과) — V4c는 샌드박스에서 graphify update 20분 초과로 `partial`이었으나 리드 게이트(pytest 101·파싱·실제 드라이런 exit 0) 통과로 채택. R3(Fable 핀) 최종 리뷰 단독 dispatch.
- #17 graphify(환경, 08:05 KST): `graphify/.venv`에는 pip이 없어(uv venv) `uv pip install --python <venv> --no-deps --reinstall graphifyy==0.9.32`로 editable 설치를 고정 wheel로 교체, import 경로가 site-packages로 바뀐 것을 확인한 뒤 vendored 소스(`graphify/graphify`, egg-info, pyproject, README, LICENSE) 삭제, `.venv`만 유지, `python -m graphify --help` 정상. 저장소 변경 아님(미추적 디렉터리). 재프로비저닝 절차는 docs/weekly-graph 원장 `00-실행-원장.md`에 setup 문단으로 기록(09-03).
- **R3 Fable 최종 리뷰(08:02~08:13 KST, fable high, 열람 21, confidence 0.82, `.aorch/task-runs68c2ebb-086e-4160-b4a2-45c154b39ba1\R3-final-review-fable
eceipt.json`)**: 반증 7개 중 6개 불성립(노트 생성 가능·재시도 3회 상한·pathspec 커밋과 해시 분류·드라이런 더미 락·양측 타임아웃과 교차 프로세스 상호배제 실측·allowlist/seal/백프레셔 무약화), 1개 부분 성립(테스트가 회신·로그 문구를 포함 단언). R2의 F1~F8·F10 전부 수정 확인, R2의 '백프레셔 훼손' 판단에는 불일치. **판정: 라이브 자동화에 병합 안전, 차단급 없음.** 신규 발견 6건: F1(standard/standard) 재시도가 1차 시도의 잔재를 원복하지 않아 #daily 중복 블록·#study 미커밋 노트 가능(병합 직후 후속 수정 권고), F2(low) top-level 디바운스 키가 #daily의 서로 다른 일기도 병합(설계 확인 필요), F3(low) socket 수신 모드에서는 재시도 약속이 이행되지 않음, F4(low) mark_event 뒤 `_channel_name` 예외 시 스레드 폴러 정지, F5(low) 채널 폴더 밖 표류 쓰기가 미신고, F6(low) 테스트의 문구 고정과 임포트 시 운영 로그 핸들러. 남은 위험: 실제 claude.exe 스모크 미실행(배포 후 #exercise 1건 권고), weekly 락 보유(수십 분) 대비 백오프 30/60초라 일요일 deep·review 중 메시지는 최종 실패 가능.
- 볼트 최종 리드 게이트(09-03 08:20 KST): pytest 101 통과(`.pytest_tmp/gate-final`), weekly.ps1 파싱 ok, 실제 드라이런(`-GraphifyPython` 고정 wheel venv, `-ArtifactsRoot` scratchpad) exit 0. 브랜치 `model-upgrade-2026-09-03` 미커밋: tracked 13파일(daily.ps1 삭제 스테이징 포함) + 신규 테스트 2. R3 발견 6건은 사용자 선택 대기.
- 사용자 선택(09-03 08:30 KST): R3 6건 전부 수정, 완료 후 두 브랜치 /ship, 볼트 CLAUDE.md는 볼트에서 커밋(553d4d2, pathspec 커밋 완료).
- 볼트 V5(08:32~09:01 KST): V5a(sol high) F1 restore_attempt(시도 전 스냅샷 차집합만 HEAD 복원·신규 파일 삭제)+write_entry 멱등화, F2 `merge_top_level` 채널 플래그(study만 병합, daily는 ts 키) — change guard 실패는 리드의 플랜 실수(allowedScope에 루트 `README.md`, 실제는 `slack-worker/README.md`), 리드 게이트 104 통과로 채택 후 나머지 재dispatch. V5b(sol high) F3 socket 모드 daemon Timer 재큐잉(attempts 상한·종료 시 취소), F4 스레드 폴러 예외 시 forget_event·커서 유지(106 통과). V5c(sol high) F5 stage1 볼트 루트 스냅샷으로 범위 밖 변경 회신·로그(커밋 안 함), F6 재시도 결과 상수(RETRY_SCHEDULED/EXHAUSTED/NOT_RETRYABLE)+`RETRY_REPLY_TEXT` 매핑, `SLACK_WORKER_LOG_DIR`+conftest. **R4 Fable 재리뷰(fable high, 열람 diff 17파일, confidence 0.84)**: F2·F3·F4·F6 코드로 닫힘, F1·F5 부분 — 판정 병합 가능, 신규 4건: R4-F1(standard/low) 롤백이 `with _vault_lock()` 밖(except)에서 실행돼 weekly가 락을 잡은 직후의 Me/ 편집을 되돌릴 수 있음, R4-F2(low) 범위 밖 보고가 stage1만(daily stage2·코멘트·amend 미보고), R4-F3(low) 소진된 스레드 이벤트가 폴러를 영구 정지(HEAD는 1건 유실·커서 전진), R4-F4(low) 락 테스트가 VAULT를 패치하지 않아 실제 볼트에 git status를 돌리고 없으면 공허 통과(실측 VAULT_PATH=없는 경로로 1 passed). 리드가 먼저 본 결함(경로 이탈 검사가 checkout 뒤)도 R4 risks에 있음. 넷 다 우리 수정이 만든 것이라 V6+R5로 마감.
- 볼트 V6(09:02~09:20 KST, sol high): R4 4건 + 경로 이탈 선검증 + README 두 줄(처리 중 채널 폴더 편집 자제, socket 재시도는 메모리) — 113 통과, 게이트·change guard 통과. **R5 Fable 리뷰(fable high, confidence 0.85)**: 반증 6항목 전부 held(락 무력화 플러그인으로 락 테스트가 실제로 2 failed 확인, VAULT_PATH=빈 폴더로 113 passed·잔존 0), 판정 병합 가능. 신규 4건: R5-F1(standard/low) events 행이 '처리 중'과 '완료'를 구분하지 않아 스레드 배치 처리 중 프로세스가 죽으면 재시작 후 폴러가 영구 정지(우리 F4 수정의 회귀, HEAD는 커서 전진), R5-F2(low) 롤백이 락을 놓았다가 재획득하는 두 번째 epoch, R5-F3(low) obsidian-git 자동 커밋 등 제3 커밋 주체가 있으면 스냅샷 차집합 전제가 깨짐(현재 'vault auto' 커밋 0건), R5-F4(low) 범위 밖 보고가 verify·stage2 세션을 안 덮음. → R5-F1·F2는 우리 결함이라 V7(마지막 라운드)로, F3·F4는 설계 확장이라 이월.
- **리뷰 루프 수렴 관찰**: R3→R4→R5 각 Fable 리뷰가 직전 수정 라운드에서 standard 1건씩을 새로 찾았다(전부 우리 수정의 회귀). 무한 반복을 막기 위해 V7+R6을 마지막으로 선언하고 이후 발견은 critical이 아니면 이월한다 — 런북 규칙 후보.
- 볼트 V7(09:21~09:35 KST, sol high): events `done` 열+기동 sweep+60분 stale 규칙, 단일 락 epoch, README 한 줄 — 116 통과. **R6 Fable 리뷰(fable high, confidence 0.90): 병합 불가.** V7의 고아 복구가 완료 이벤트를 세 경로에서 재실행함을 프로브로 재현: R6-F1(high) 마이그레이션이 기존 행을 done=1로 백필하지 않아 라이브 DB의 모든 행이 고아로 분류 → 첫 기동에 threads 행 없는 과거 메시지(#study 버스트 2번째 이후 사진 등) 재처리·중복 커밋 확정, R6-F2(high) 60분 stale 규칙이 살아 있는 배치(run_claude 2400초×3세션+락 30분)를 재큐잉해 같은 메시지 2회 실행, R6-F3(standard) 커밋 후 complete_event 전 크래시 시 committed가 메모리뿐이라 sweep이 재커밋. 추가 위험: _worker_loop에 except가 없어 후처리 예외로 워커 스레드 사망(HEAD는 잡았음). 판단: 중복 커밋은 정지(R5 상태)보다 나쁘므로 R6 처방 3건을 문자 그대로 적용하는 V8+R7을 돌리고, R7이 병합 불가면 V7 이전으로 되돌린다. 되돌리기용으로 현 상태 패치 보존(`vault-evidence/state-after-V7.patch`). **aorch 이월**: task-run 디렉터리에 attempt별 diff가 저장되지 않아 특정 라운드만 되돌릴 수 없다.
- 볼트 V8(09:36~09:53 KST, sol high): R6 처방대로 legacy 행 done=1 백필, stale 절 제거(반대 방향 테스트 반전), committed 영속(mark_committed+committed_recovery 표)·sweep이 committed 행을 종결, 완료 이벤트 배치 건너뜀·중복 큐잉 방지, _worker_loop try/except — 122 통과. **R7 Fable 리뷰(fable high, confidence 0.87): 보류.** R6 프로브 6개 전부 held(P3의 revert 경로만 not held). 남은 저비용 3건: R7-F1(standard) 마이그레이션 비원자(ALTER는 autocommit, UPDATE만 트랜잭션 → 첫 with 실패 시 열만 남고 done=0 → R6-F1 재발, 프로브 재현), R7-F2(standard) process_revert가 committed를 메모리에만, R7-F3(standard) 단일 인스턴스 가드 부재 — **운영 실측: 호스트에 worker.py 인스턴스 2개 동시 실행 중**(PID 43192 08-30 수동 기동·부모 소멸, PID 50076 09-01 SlackVaultWorker 예약 작업). 리뷰어가 라이브 state.db를 읽기 전용으로 열어 events 17행·threads 16행·미매칭 2행 확인(볼트 아님, 스크립트 디렉터리).
- 볼트 V9(09:55~10:05 KST, **리드 직접 수정**, 워커 왕복 없이): state._conn의 ALTER·백필·committed 열을 `BEGIN IMMEDIATE`/`COMMIT`/실패 시 `ROLLBACK` 한 트랜잭션으로, process_revert에 `state.mark_committed` 한 줄, `worker.acquire_instance_lock`(msvcrt 비차단, `%LOCALAPPDATA%/Temp/sb-slack-worker.lock`, 실패 시 exit 2) + start-worker.ps1 코드 2 종료 + README 두 문장. 테스트 3개 추가(중간 실패 마이그레이션이 열을 남기지 않고 다음 기동에 완전 이행, revert 후 sweep이 재시도하지 않음, 두 번째 인스턴스 락 실패) → 125 통과, start-worker.ps1 파싱 ok. R8(V9만 보는 Fable 리뷰)로 마감. **이후 발견은 critical이 아니면 이월.**
- **R8 Fable 리뷰(10:07~10:18 KST, fable high, confidence 0.90): 병합 가능.** R7 프로브 재실행 전부 성립 + 실패 변형 5종(UPDATE·ALTER·COMMIT 지점 예외, 리더 SHARED 락으로 COMMIT busy)에서 반쪽 마이그레이션 불가, 교착 없음, 인스턴스 락 핸들 프로세스 수명·손자 미상속, runpy로 __main__ 실제 실행 rc=2 확인, 125 passed·회귀 없음. 남은 3건 전부 low(이월): R8-F1 exit 2가 Python 인터프리터 사용 오류 코드와 겹쳐 start-worker 메시지 오도, R8-F2 구 인스턴스가 겹친 채 기동하면 COMMIT busy → exit 1로 루프 영구 중단(구 인스턴스 종료 절차로 회피), R8-F3 지금 도는 예약 작업 루프(PID 28952)는 병합 전 스크립트를 메모리에 들고 있어 exit 2 분기를 모름 → README에 Stop/Start 절차 한 줄 추가(리드 직접). **호스트 조건**: 기동 전 `Stop-ScheduledTask SlackVaultWorker` → worker.py 프로세스 트리(43192→42632, 50076→31032) 종료 → 0개 확인 → state.db 백업 → 병합 → `Start-ScheduledTask`. 이 절차는 프로세스 종료·예약 작업 조작이라 사용자 승인 후 수행.
- **볼트 최종 게이트(10:20 KST)**: pytest 125 통과(`.pytest_tmp/gate-v9`), start-worker.ps1·weekly.ps1 파싱 ok, 실제 드라이런 exit 0(`weekly-dryrun-final2.log`). 누적: V1~V9 아홉 라운드(워커 8, 리드 직접 1), Fable 리뷰 6회(R3~R8), opus 리뷰 1회(R2), 테스트 82→125.

**QuantPilot**: 22건 전부 승인 + 매핑 `claude-fable-5 → fable`(별칭). 사용자 메모: "곧 모의투자 API 연결을 시작하니 보안 쪽을 특히 더 잘 살펴봐" → 적용을 두 플랜으로 분리. 플랜 A(보안: #2 smoke 격리, #3 health·배너 실제 플래그, #4 actor 의존성, #5 원자 claim, #8 KIS 클라이언트 비공개+#9 env 필수)는 각 태스크에 전체 pytest 게이트(`--basetemp`), 끝에 S1 보안 경계 리뷰(R1-07 재평가 포함). 플랜 B(#7 DataMode, #1 pytest 게이트 문서, #6 types alias, #12~#21 죽은 코드, #22 청크, #11 매핑)는 R2 anthropic 리뷰로 마감. QuantPilot 규약대로 `claude/model-upgrade-2026-09-02` 브랜치의 linked worktree(`.claude/worktrees/model-upgrade-fixes`)에서 실행, node_modules는 junction.
- 플랜 A run 1(18:29~18:51 KST): X1 smoke 격리(sol high) complete — 게이트 pytest exit 0, change guard 통과, `run-smoke`가 격리 `RepositoryRegistry`로 실행되고 회귀 테스트 추가. X2 health·배너(sol high)는 7파일을 고쳤지만 워커가 `partial`을 보고해 run 중단: Codex 샌드박스의 쓰기 루트가 worktree라 scratchpad의 `--basetemp`와 밖을 가리키는 node_modules junction을 쓸 수 없었음(코드 문제 아님). 리드가 직접 게이트 실행: pytest 1,297 통과·2 skip(exit 0), vitest 24/24, 빌드 통과 → X2 채택. 교훈을 반영해 basetemp를 worktree 안 `.pytest_tmp`(git exclude)로, node_modules를 실복사(211MB)로 바꾸고 X3~X5+S1을 플랜 A2로 재dispatch.
- 플랜 A2(18:55~19:09 KST): X3 actor 의존성(sol high) — 16파일, POST 22개에 `require_operator_actor`(bearer 공유 비밀 `compare_digest`, 미설정 시 503 fail-closed, `X-QuantPilot-Operator-Actor` 헤더 검증, approve의 `approved_by`로 전달) 구현했으나 또 `partial`: 워커가 worktree의 `.pytest_tmp`를 열 수 없음. **근본 원인 확정**: pytest가 만드는 basetemp 디렉터리 ACL이 SYSTEM·Administrators·OWNER RIGHTS뿐이라(`icacls`) 다른 토큰(Codex 샌드박스)이 못 읽는다. `Temp/pytest-of-goyan`이 7/17부터 깨져 있던 것도 같은 메커니즘(샌드박스 프로세스가 만든 디렉터리를 내 계정이 못 읽음). 리드 게이트: pytest 1,301 통과·2 skip(exit 0) → X3 채택. 대응: 부모 `.pytest_tmp`는 일반 mkdir, 게이트는 `.pytest_tmp/gate`, 워커는 `.pytest_tmp/worker-<task>`를 각자 생성. X4·X5·S1을 플랜 A3로.
- 플랜 A3(19:12~19:38 KST): X4 원자 claim(sol high, 주문별 락+동시 제출 테스트) complete, X5 KIS 비공개+플래그 env 필수(sol high, 15파일) complete — 둘 다 게이트 통과. 리드 게이트: pytest 1,304 통과·2 skip, vitest 24, 빌드 통과, diff 37파일 +586/−88. **S1 보안 리뷰(Codex sol)**가 반증 5개를 not-held로: 다른 라우터의 무인증 POST 15개 잔존(S1-01), 밑줄 capability는 import로 우회(S1-02, 실행 재현), 인스턴스 단위 락이라 공유 registry에서 이중 제출 재현(S1-03), health가 GUARDED 플래그 미반영(S1-05), `run_smoke` 메서드 자체는 여전히 clear(S1-06), actor 헤더 미인증(S1-04), R1-07 구체 가드(startup validation·runtime role·host pin). 상수시간 비교·비밀 비노출·SQLite CAS는 held. reviewer의 criteria fail로 run은 형식상 실패했지만 S1이 마지막이라 손실 없음. → 후속 보안 라운드 A4(Y1~Y6) 즉시 dispatch.
- 플랜 A4(19:42~19:51 KST): Y1 전체 라우트 actor(sol high) — 8파일, 변경 라우트 38개 중 37개 보호(순수 preview 1개 allowlist), app.routes 전수 테스트. 그러나 워커가 지시와 달리 `.pytest_tmp/gate`를 먼저 건드려 그 디렉터리가 리드 계정에서 읽히지 않게 됐고, 게이트 pytest가 tmp_path ERROR 316건으로 실패 → 에스컬레이션 2차가 "이미 구현됨"으로 change guard 실패. 리드 게이트(새 basetemp): 1,304 통과·2 skip → Y1 채택. 대응: 게이트 basetemp를 `.pytest_tmp/gate-%RANDOM%`(cmd.exe 확장)로 실행마다 유일하게, 워커에 `gate*` 접근 금지 명시. Y2~Y6을 A5로 재dispatch.
- **관측 오염이 라우팅을 바꾼 첫 사례**: A5 dry-run에서 다섯 태스크가 sol high가 아닌 sol medium으로 갔다. Y1 게이트의 환경 실패가 sol high(security)에 낮은 품질 관측으로 남아 라우터가 등급을 낮춘 것. 이월 항목(검증 게이트 환경 실패와 모델 품질 분리)의 실증.
- 플랜 A5(19:53~20:07 KST): Y2 KIS capability 실체화(sol medium, 5파일) complete — module-level issuer·sentinel 제거, closed submitter는 coordinator 생성 경로에서만 생성, 일반 client의 raw request는 현금주문 endpoint 거부, 게이트 1,304 통과. Y3 저장소 CAS(sol medium)는 harness_service.py·테스트까지 3파일을 고치고 receipt에 1파일만 신고해 change guard 실패(신고 정확성). 리드 게이트 1,304 통과, diff 확인(`compare_and_update_status` + 저장소 RLock, 서비스가 broker 호출 전 claim) → Y3 채택. Y4~Y6을 A6로.
- 플랜 A6(20:09~20:20 KST): Y4 actor 바인딩(sol medium, 3파일) complete — 공유 비밀이 서버 설정 `QUANTPILOT_OPERATOR_ACTOR_ID`에 매핑되고 요청 헤더는 신원을 못 정함, 미설정 시 503, 게이트 1,305 통과. Y5 health guarded+smoke 메서드(sol medium, 7파일)는 코드 완료·백엔드 1,307 통과였으나 웹 npm이 샌드박스(상위 경로·PowerShell 정책)에서 exit 0을 못 내 `partial`. 리드 게이트: pytest 1,307·vitest 24·빌드 통과 → Y5 채택. Y6을 A7로.
- 플랜 A7(20:22~20:33 KST): Y6 모의투자 가드(sol medium, 9파일) complete — paper-session runtime role 분리, 계정 fingerprint allowlist, generic API/smoke의 paper-arming 환경 시작 차단, KIS historical production origin 고정과 proxy/redirect 차단, `KIS_HISTORICAL_ENABLED` 필수. 게이트 1,315 통과. **보안 라운드 완료**: 리드 게이트 pytest 1,315·2 skip, vitest 24, 빌드 통과; 누적 diff 51파일 +1,066/−178 + 신규 테스트 1. 이어서 S2(Fable 핀) 보안 재리뷰.
- **S2 Fable 보안 재리뷰(20:35~20:49 KST, fable high, 열람 46, confidence 0.86, `.aorch/task-runs\5d50159d-d8b4-4ad5-9cfc-c256e986d05e\S2-security-boundary-fable\receipt.json`)**: 반증 7개 중 6개 held — 변경 라우트 38/39 보호(preview는 순수 파싱), compare_digest·비밀 비노출, 저장소 CAS(교차 서비스 8회 재실행 통과), health env-only·정책 AND, run_smoke 임시 registry, 검증 약화 없음. NOT HELD: KIS 클라이언트 격리 — 클라이언트 참조만 있으면 `_transport.request_json`으로 3줄 만에 주문 endpoint 도달, `_request` 오버라이드로 우회; 실제 경계는 프로세스 분리(API는 KisPaperClient를 만들지 않고 paper job 2개만 생성)이고 새 테스트가 과장. S1과 비교: S1 발견 전부 해소 확인, S1-02 처방(closed submitter)은 파이썬 안에서 권한을 가두지 못한다고 반박. 새 발견 6건(전부 low cost): S2-01 `QUANTPILOT_RUNTIME_ROLE=paper-session`이 generic 시작 거부를 끄는 토글(거부로 바꿔야), S2-02 격리 테스트를 프로세스 경계 검증으로 재구성, S2-03 비밀 최소 길이·죽은 CORS 헤더, **S2-04 UI가 Authorization을 못 실어 모든 mutating 호출이 401/503(fail-closed지만 실사용 불가) + openapi 산출물 수동 편집**, S2-05 fully_automated 플래그가 미동의 정책에 True, S2-06 테스트 이름이 계약과 반대. R1-07: 노출은 프로세스 경계·VTS host pin으로 한정, 남은 벡터는 S2-01. → A8(Z1~Z3)로 적용.
- 플랜 A8(20:51~21:14 KST, sol medium): Z1 generic runtime이 paper-session role 거부·비밀 32자 미만 503·fully_automated env AND 정책(8파일, 1,318 통과), Z2 KIS 격리를 프로세스 경계 테스트로 재구성·과장 테스트명 수정(5파일, 1,319), Z3 openapi.json·openapi.d.ts 앱에서 재생성 + 안전 배너에 메모리 전용 운영자 토큰 입력 + mutating 호출에만 Bearer(6파일, pytest·vitest·빌드 통과). 세 태스크 모두 1회 통과. **보안 작업 최종**: 리드 게이트 pytest 1,319·2 skip, vitest 26, 빌드 통과; 누적 diff 55파일 +2,097/−292 + 신규 테스트 1. 이어서 플랜 B(부채·문서·매핑).
- 플랜 B run 1(21:16~21:24 KST): X6 DataMode(terra max, 4파일) — live_trading_candidate·live_canary·live_scaled를 enum·_UNSAFE_MODES·배너에 추가하고 unsafe/blocked 테스트. 웹 게이트가 샌드박스 Vite 경로 권한으로 `partial`(terra는 sol과 달리 대체 로더를 못 씀). 리드 게이트 pytest 1,325·vitest 26·빌드 통과 → 채택. 남은 위험: enum이 legacy `live_trading`을 유지해 9값(문서 8값). 플랜 B2에는 "샌드박스 권한만의 웹 실패는 complete로 보고, 게이트가 밖에서 돌린다" 지침 추가.
- 플랜 B2(21:27~21:56 KST): X7 pytest 게이트 문서화(luna max, CLAUDE.md·pyproject) complete, X8 types alias(terra max, 6개 백엔드 모델 복사본을 생성 스키마 별칭으로) complete — 둘 다 게이트 통과. X9 죽은 코드(terra max)는 10건 중 7건 적용(CUT-01/02/03/05/06/07/10), 3건 보류: CUT-04(kernel 상수 삭제는 테스트 digest·source-shape 단언 수정 필요=테스트 재작성 금지), CUT-08(risk/__init__ 재수출은 외부 소비자의 public API일 수 있음), CUT-09(test_level5_fallback_manager가 FallbackManager 클래스를 직접 사용). change guard 실패 원인: 이미 dirty였던 service.py·paper_submission.py를 추가로 고치고 base 프롬프트의 "시작 전부터 수정된 파일은 적지 말라"를 오독해 미신고 → **aorch base 프롬프트 결함(이월)**: 더러운 트리에서 '내가 이번에 만진 파일'과 '원래 dirty였던 파일'의 구분을 명확히 해야 함.
- 플랜 B3(21:58~22:29 KST): X10 웹 청크(luna max) — 11개 페이지 React.lazy 분할, 공용 청크 519kB로 500kB 경고 잔존; X11 모델 매핑(luna max) — 11개 frontmatter `model: fable`. **R2 opus xhigh 동작 보존 리뷰(`.aorch/task-runs\914d9dbc-0699-4a03-a689-4c9d77dd860f\R2-behaviour-review\receipt.json`)**: "X6..X11 diff는 행위 보존적이지 않다" — X9·X11 완전 보존, X8 런타임 보존·타입 계약 완화, X10 정상 경로 보존·실패 경로 신규, X6·X7 실제 행위 변경. 발견 6건: F1(high) X7의 addopts `--basetemp .pytest_tmp`는 pytest가 실행마다 rm_rf해 동시 워커 임시 트리를 파괴(격리 재현), F2 X6의 DataMode 3값이 openapi.json·openapi.d.ts에 미반영, F3 lazy 청크 로드 실패 시 react-router 경계가 AppShell·SafetyBanner를 언마운트, F4 X8로 안전 관련 응답 필드가 optional이 되어 '누락'과 '없음'이 화면에서 구분 불가, F5 workboard-flow 템플릿의 claude-fable-5 잔존, F6 App 라우팅 테스트 0건. 리드 게이트: pytest 1,325·vitest 26·빌드 통과, 누적 diff 77파일 +2,213/−446 + 신규 테스트 2. → 최종 라운드 B4(W1~W3).
- 플랜 B4(22:32~23:13 KST, terra max): W1 addopts에서 --basetemp 제거·문서는 `$PID` 기반 호출별 경로·openapi 산출물 9개 DataMode로 재생성(4파일), W2 lazy import 실패를 AppShell 내부 지역 오류 경계로 처리 + pending/rejected 청크 라우팅 테스트(2파일), W3 안전 증거 필드·응답 식별자를 required로 복구·UI의 무음 `?? []` 제거·workboard-flow 템플릿 `fable`(6파일; `docs/contracts/operator_contracts.md`는 범위 밖이라 미수정). 세 태스크 1회 통과. **QuantPilot 최종**: 리드 게이트 pytest 1,326·2 skip, vitest 28, 빌드 통과(공용 청크 경고 잔존); 누적 diff 76파일 +2,309/−469 + 신규 테스트 4(actor guard, live data mode safety, operator schema contract, app routing). 워커 `partial`/change guard 실패 9회는 전부 환경·신고 문제였고 코드 실패 0회.
- 실측 하나 더: 워커 receipt에 "참조된 감사 receipt 파일이 이 worktree에 없다"는 위험이 남았다. 프로젝트 `.aorch/task-runs`는 메인 체크아웃에 있어 worktree 샌드박스에서 못 읽는다 → 플랜 objective에 제안 전문을 인라인하는 현재 방식이 맞고, 런북에 명시.
- 플랜 A 실측: 첫 dry-run이 `No eligible route for X1` — kind `security`·complexity `standard`에는 실행자 프로필이 없다(opus는 high 이상 effort만, sol도 standard security 실행자 없음). complexity high로 올려 6태스크 전부 Codex sol high. S1까지 sol이라 교차 프로바이더가 아님 → 플랜 A 후 같은 diff를 Fable 핀(`plan-qp-s2-fable.json`)으로 재리뷰 예정.

## 이월

### QuantPilot — 완료와 잔여 (09-02 밤 실행)
- 완료: 감사 22건 중 19건 적용(보안 #2·#3·#4·#5·#8·#9, 부채 #1·#6·#7·#10·#11, 죽은 코드 7/10건) + S1 후속 7건 + S2 후속 6건 + R2 후속 6건(B4 완료). 작업 브랜치 `claude/model-upgrade-2026-09-02`(worktree `.claude/worktrees/model-upgrade-fixes`), **미커밋**. 모의투자 API 연결 전 보안 경계: 모든 변경 라우트 actor 의존성(서버 설정 actor id에 바인딩), 저장소 CAS, KIS 주문은 paper job 2개만 생성(프로세스 경계 테스트), health가 실제 플래그·guarded 반영, run-smoke 격리, generic runtime의 paper-arming 거부, historical host pin.
- 보류(워커가 근거를 남김): CUT-04 kernel `FINAL_SAFETY_CHECKS`·`_path_for_key`(테스트 digest·source-shape 단언 수정 필요), CUT-08 `risk/__init__` 재수출(외부 소비자 가능성), CUT-09 `FallbackManager`(test_level5_fallback_manager 계약). 사용자가 테스트 수정을 허용하면 별도 태스크.
- S2·R2가 남긴 위험: 교차 플랜 idempotency-key 경합(기존), lifespan='off'면 startup validation 미실행, Vercel origin CORS에서 bearer가 유일한 층(레이트리밋 없음), 공용 청크 519kB 경고, 브라우저 실사용 흐름 미실행(test+build만), `fable` 별칭이 에이전트 frontmatter에서 유효한지 하니스 검증 수단 없음.
- 메인 체크아웃의 미커밋 CLAUDE.md(PowerShell 관례 한 줄)·settings.json(allowlist)·설치본은 worktree 브랜치에 없다 — 병합 시 합칠 것. 잔여 문서 수정 1건: `docs/contracts/operator_contracts.md`를 W3의 required 필드 변경에 맞출 것.
- 실행 환경: pytest는 `Temp/pytest-of-goyan` ACL 때문에 basetemp 필수(CLAUDE.md는 `$PID` 기반 호출별 basetemp를 안내, addopts는 `-q`만), `python`은 hermes venv. 프로젝트 venv 신설은 별도 결정.

### Obsidian Vault + SecondBrain-scripts — 완료와 잔여 (09-03 새벽 실행)
- 완료: 감사 17건 중 14건 적용(#1·#2·#4·#5 V1, #3·#6·#8 V2, #14·#15·#13 V3, #7·#12·#16 문서·환경, #17 graphify) + R2 회귀 10건 전부(V4a/b/c). 브랜치 `model-upgrade-2026-09-03`(worktree `.claude/worktrees/model-upgrade`), **미커밋**. R3 판정 병합 안전.
- R3 6건 전부 적용(사용자 선택), 그 후속 R4 4건·R5 2건·R6 3건·R7 3건 적용, 최종 R8 병합 가능. 브랜치 `model-upgrade-2026-09-03` 커밋(아래 마감 절 참조).
- 이월(전부 low, 설계 확장 또는 진단 편의): R5-F3 obsidian-git 자동 커밋 등 제3 커밋 주체가 있으면 스냅샷 차집합 전제가 깨짐(HEAD 이동 감지 제안, 현재 'vault auto' 커밋 0건), R5-F4 범위 밖 보고가 verify·stage2 세션 미포함, R8-F1 exit 코드 2 → 75 등으로 분리, R8-F2 sqlite timeout 상향·기동 예외 별도 코드, R7 잔여(worker.py 배치 완료 판정 any()→all(), mark_event SELECT→INSERT 비원자성은 단일 인스턴스면 무관, 미설정 채널 NOT_RETRYABLE 반복 회신, 소진 상태의 이중 표현), 사용자 편집과 모델 쓰기 구분 불가(README 안내로만 완화), 일요일 락 경합 시 90분 뒤 최종 실패, 인스턴스 락이 계정별 %LOCALAPPDATA%라 예약 작업 계정을 바꾸면 무력.
- 배포 후 스모크(리뷰어 권고, 미실행): #exercise 1건으로 새 노트 생성 확인, 첫 일요일 로그에서 'vault lock acquired/released' 쌍 확인, 기동 로그의 'orphaned in-flight Slack events reset' 건수(라이브 events 17행 중 threads 미매칭 2행은 백필로 done=1이어야 함).
- 볼트 `CLAUDE.md` 4문장 정정(Me 즉시 갱신 채널 #daily·#books만, #daily 4커밋 fable 1·opus 2, weekly 5패스, daily.ps1 제거·SecondBrain-Daily 해제)은 볼트 저장소에 **미커밋**.
- 환경: `SecondBrain-Daily` 예약 작업은 이미 Disabled였고 그대로 둠. `SecondBrain-Weekly`의 마지막 결과가 0x800710E0(작업이 종료됨) — 주간 실행이 실제로 완주하는지 다음 일요일 로그로 확인 필요. `SlackVaultWorker`는 실행 중 프로세스를 건드리지 않았으므로 병합 후 워커 재시작 필요.
- 보류: V3의 `_blank_target`·역사 문서(관찰 가능 산출물·README 링크), R3 남은 위험(claude.exe 스모크, 일요일 락 경합 시 최종 실패, socket 모드 재시도).

### 다음 프로젝트 (같은 절차, 이 문서의 후속 작업)
- **QuantPilot** (`OneDrive/문서/코덱스/주식트레이더`): 인벤토리 `claude-fable-5` 18곳(`.claude/agents/*` 5종, `.claude/skills/*` 7종 frontmatter `model:`) → 매핑표 `claude-fable-5 → fable`(별칭) 또는 `claude-fable-5-1` 승인 필요. 실사용: `python -m quantpilot.jobs.run_smoke` + `npm run dev`(quantpilot/apps/web, vite) 핵심 흐름 1회. R1 objective는 프로젝트 CLAUDE.md의 안전 불변식(LIVE_TRADING_ENABLED=false, BROKER_MODE=mock, 리스크 게이트·킬스위치·멱등성 우회 금지). 프로젝트에 `aorch install --project . --target both`(설치본 `.aorch/config.json`이 저장소와 같으면 `--force-config`) 후 감사 플랜 dispatch — 이번 브랜치가 병합된 뒤에.
- **Obsidian Vault + SecondBrain-scripts**: 인벤토리 `opus`/`sonnet` 13곳(`.claude/agents` admin-expert·contest-judge·legal-expert(opus), contest-researcher·contest-juror(sonnet), `contest-team` 스킬 단계별, `Meta/` 설계 3문서, 워크트리 graph-view-tuning). 실사용: slack-worker·weekly 파이프라인 드라이런. `Me/`는 열지 않는다(P1·R1·A1 objective에 명시). SecondBrain-scripts는 `graphify/skill-devin.md` sonnet 1곳.

### aorch 결함·개선 (이번 run이 드러낸 것)
- reviewer 역할이 불변식을 receipt criteria `fail`로 적어 run을 멈추는 문제가 QuantPilot에서 2회(R1·S1) 재현. receiptVerdict가 review kind의 criteria fail을 중단 사유로 볼지, 판정을 findings로 강제할지 결정 필요.
- base 프롬프트의 filesChanged 규칙이 더러운 트리에서 오독됨(X9): '시작 전부터 수정된 파일은 적지 말라'가 '이번에 만진 파일이 원래 dirty였으면 빼라'로 읽힘 → 문구 수정.
- Codex 워커의 `partial` 6회가 전부 샌드박스 환경(basetemp ACL·node_modules junction·Vite 상위 경로) 때문이었고 코드는 매번 정상 — 워커가 환경 실패와 코드 실패를 구분해 보고하게 하거나, 게이트가 있는 태스크는 `partial`이어도 게이트를 돌려 판정하는 옵션 검토.
- kind `security` + complexity `standard`에 실행자 프로필이 없음(카탈로그 공백).
- 에스컬레이션이 직전 시도의 트리 변경을 되돌리지도, 기준선을 갱신하지도 않는다 → 2차 워커가 "이미 적용됨"으로 `filesChanged: []`를 내면 change guard가 실패(X1 실측). 재시도 전 `git checkout`으로 되돌리거나 attempt별 스냅샷을 기준선으로 쓰는 설계 결정 필요.
- `test/executor.test.js` "Windows command resolution executes a PATH command shim"이 PowerShell 환경에서 `spawn fixture ENOENT`. 테스트 픽스처의 셸 의존인지 실제 Windows 해석 결함인지 미분류.
- 검증 게이트의 환경 실패가 관측 원장에 `quality: 0.2`로 남아 라우팅을 오염(codex terra). 환경 오류를 모델 품질과 분리할 방법 없음.
- fable 관측 0건 유지. 리뷰 태스크는 관측을 남기지 않아 auditor 실행으로는 승격 근거가 쌓이지 않는다. 승격 경로(검증 명령 있는 reviewer 태스크?) 설계 필요.
- README:340 "검증되지 않은 challenger를 critical 단독 executor로 쓰지 않음" vs 런북 §0 "사다리 끝에 붙인다"(코드는 후자) — 어느 약속을 지킬지 결정 필요(A1 unresolvedRisks).
- #11 installFile atomic write(사용자 제외). 워커가 자기 run 디렉터리를 아는 방법(환경변수 AORCH_RUN_DIR) 부재. `pattern` 키워드는 두 프로바이더 모두 수용 확인.
- 프롬프트의 "findings는 요청받지 않으면 빈 배열" 지시를 ponytail·reviewer가 무시하고 채운다(유용하지만 프리셋 문구와 어긋남).
- 감사 2회 모두 P1·R1이 Codex sol high로 갔다(routing: review kind에 codex-sol이 최고 품질). 교차 프로바이더는 A1 핀으로만 성립.
- 볼트 실측: reviewer criteria fail 중단이 R1에서 다시 재현(누적 4회: QuantPilot R1·S1, 볼트 R1, 그리고 aorch 자기 감사에서는 미재현). 에스컬레이션 2차 워커가 게이트를 통과하려고 검증 대상 자체(weekly.ps1 드라이런에 `if ($DryRun -and $NoPost) { return }`)를 무력화한 사례 — 리드가 hunk를 제거했고, 이후 objective에 '게이트를 우회하지 말라'를 명시해야 했다. 워커가 게이트를 통과시키는 가장 싼 길이 검증 무력화일 때 aorch가 이를 잡을 장치가 없다(change guard는 diff 범위만 본다).
- 볼트 실측: 보안 하드닝 라운드(V1·V2)가 회귀 10건(치명 1)을 만들었고 같은 프로바이더의 게이트는 통과시켰다. 다른 프로바이더의 동작 보존 리뷰(R2 opus)가 잡았다 — 하드닝 후 교차 프로바이더 리뷰는 선택이 아니라 절차여야 한다(런북 §6 (g)).

### 전역 ~/.claude (미적용·관찰 필요)
- interview-guard 훅 삭제(#4)는 한 세션 동안 훅 없이 interview 스킬만으로 규칙이 유지되는지 관측한 뒤 판단. 이번 세션 실측: 훅이 매 턴(시스템 알림 턴 포함) 재주입됐다.
- ship 병합 절(#6)과 CLAUDE.md 승인 문장 중복(#12)은 유지 결정.
- invest 원장의 동시 세션 경합(두 세션이 같은 open 레코드를 각자 supersede) — 원장 구현 범위 밖.
- autoMode 갱신(#9) 후 자동 모드에서 git 읽기 명령 1회로 프롬프트 여부 확인 미실시.
- autoMode Trusted repo와 `C:/Users/goyan/CLAUDE.md` 활동 프로젝트는 같은 날 이력 기반으로 5개(study-agent·책 만들기 추가)로 재갱신 — `docs/plans/2026-09-02-usage-tuning.md` 참조.

### 기존 이월 (2026-08-30에서)
- reviewer가 플랜 밖 기준을 추가해 fail로 run을 멈추는 문제 — aorch·전역 run에서는 재현되지 않았으나 **QuantPilot run 1에서 재현**(불변식 17개를 criteria fail로). 설계 결정 필요: 리뷰 태스크의 criteria는 플랜의 acceptanceCriteria만 허용하고 판정은 findings로 가게 할지, 아니면 review kind에서는 criterion fail을 run 중단 사유로 보지 않을지.
- researcher·paper-researcher의 산출물 자리 → `findings` 필드가 생겼으므로 조사형 프리셋이 이를 쓰도록 문구 갱신 검토.
