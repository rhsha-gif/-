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

## 사용자 선택

2026-09-02 AskUserQuestion 4묶음. **#11(installFile atomic write)만 제외하고 17건 수정 승인.** 적용은 `plan-model-upgrade-apply.json` 형식으로 파일 영역별 worker 태스크 7개(X1 런북·스킬 절·Codex 사본, X2 receipt 스키마, X3 dispatch runId·미지 키, X4 분류기 review, X5 사다리 핀, X6 run-loop 가드, X7 config·락·finish), 각 `npm run check` 검증 게이트. 매핑표 0행이라 M1 없음. 플랜: `.aorch/evidence/2026-09-02/plan-aorch-apply.json`.

**전역**: 12건 중 9건 승인 — #1 dependency-audit 자동 호출, #2 project-health-check 자동 커밋 제거, #3 push allow→ask, #5 훅 타입 검증, #7 죽은 코드 호출 경로 조건, #8 invest 예외 문구 통일, #9 autoMode Trusted repo 갱신(활동 프로젝트 3곳, 볼트는 원격 없음), #10 시크릿 보고 값 인용 금지, #11 resume-work→execute-plan 흡수. 유지: #4 interview-guard 훅(존재 이유 미배제), #6 ship 병합 절, #12 CLAUDE.md 중복 문장.

## 이월

### 다음 프로젝트 (같은 절차, 이 문서의 후속 작업)
- **QuantPilot** (`OneDrive/문서/코덱스/주식트레이더`): 인벤토리 `claude-fable-5` 18곳(`.claude/agents/*` 5종, `.claude/skills/*` 7종 frontmatter `model:`) → 매핑표 `claude-fable-5 → fable`(별칭) 또는 `claude-fable-5-1` 승인 필요. 실사용: `python -m quantpilot.jobs.run_smoke` + `npm run dev`(quantpilot/apps/web, vite) 핵심 흐름 1회. R1 objective는 프로젝트 CLAUDE.md의 안전 불변식(LIVE_TRADING_ENABLED=false, BROKER_MODE=mock, 리스크 게이트·킬스위치·멱등성 우회 금지). 프로젝트에 `aorch install --project . --target both`(설치본 `.aorch/config.json`이 저장소와 같으면 `--force-config`) 후 감사 플랜 dispatch — 이번 브랜치가 병합된 뒤에.
- **Obsidian Vault + SecondBrain-scripts**: 인벤토리 `opus`/`sonnet` 13곳(`.claude/agents` admin-expert·contest-judge·legal-expert(opus), contest-researcher·contest-juror(sonnet), `contest-team` 스킬 단계별, `Meta/` 설계 3문서, 워크트리 graph-view-tuning). 실사용: slack-worker·weekly 파이프라인 드라이런. `Me/`는 열지 않는다(P1·R1·A1 objective에 명시). SecondBrain-scripts는 `graphify/skill-devin.md` sonnet 1곳.

### aorch 결함·개선 (이번 run이 드러낸 것)
- 에스컬레이션이 직전 시도의 트리 변경을 되돌리지도, 기준선을 갱신하지도 않는다 → 2차 워커가 "이미 적용됨"으로 `filesChanged: []`를 내면 change guard가 실패(X1 실측). 재시도 전 `git checkout`으로 되돌리거나 attempt별 스냅샷을 기준선으로 쓰는 설계 결정 필요.
- `test/executor.test.js` "Windows command resolution executes a PATH command shim"이 PowerShell 환경에서 `spawn fixture ENOENT`. 테스트 픽스처의 셸 의존인지 실제 Windows 해석 결함인지 미분류.
- 검증 게이트의 환경 실패가 관측 원장에 `quality: 0.2`로 남아 라우팅을 오염(codex terra). 환경 오류를 모델 품질과 분리할 방법 없음.
- fable 관측 0건 유지. 리뷰 태스크는 관측을 남기지 않아 auditor 실행으로는 승격 근거가 쌓이지 않는다. 승격 경로(검증 명령 있는 reviewer 태스크?) 설계 필요.
- README:340 "검증되지 않은 challenger를 critical 단독 executor로 쓰지 않음" vs 런북 §0 "사다리 끝에 붙인다"(코드는 후자) — 어느 약속을 지킬지 결정 필요(A1 unresolvedRisks).
- #11 installFile atomic write(사용자 제외). 워커가 자기 run 디렉터리를 아는 방법(환경변수 AORCH_RUN_DIR) 부재. `pattern` 키워드는 두 프로바이더 모두 수용 확인.
- 프롬프트의 "findings는 요청받지 않으면 빈 배열" 지시를 ponytail·reviewer가 무시하고 채운다(유용하지만 프리셋 문구와 어긋남).
- 감사 2회 모두 P1·R1이 Codex sol high로 갔다(routing: review kind에 codex-sol이 최고 품질). 교차 프로바이더는 A1 핀으로만 성립.

### 전역 ~/.claude (미적용·관찰 필요)
- interview-guard 훅 삭제(#4)는 한 세션 동안 훅 없이 interview 스킬만으로 규칙이 유지되는지 관측한 뒤 판단. 이번 세션 실측: 훅이 매 턴(시스템 알림 턴 포함) 재주입됐다.
- ship 병합 절(#6)과 CLAUDE.md 승인 문장 중복(#12)은 유지 결정.
- invest 원장의 동시 세션 경합(두 세션이 같은 open 레코드를 각자 supersede) — 원장 구현 범위 밖.
- autoMode 갱신(#9) 후 자동 모드에서 git 읽기 명령 1회로 프롬프트 여부 확인 미실시.
- autoMode Trusted repo와 `C:/Users/goyan/CLAUDE.md` 활동 프로젝트는 같은 날 이력 기반으로 5개(study-agent·책 만들기 추가)로 재갱신 — `docs/plans/2026-09-02-usage-tuning.md` 참조.

### 기존 이월 (2026-08-30에서)
- reviewer가 플랜 밖 기준을 추가해 fail로 run을 멈추는 문제 — 이번 run에서는 재현되지 않음.
- researcher·paper-researcher의 산출물 자리 → `findings` 필드가 생겼으므로 조사형 프리셋이 이를 쓰도록 문구 갱신 검토.
