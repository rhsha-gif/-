# 1차 원리 설계 검토 — adaptive-orchestrator v0.6.2

- 검토일: 2026-07-17
- 성격: **버그 헌트가 아니라 설계 검토.** 개별 결함 교정(0.6.0/0.6.1/0.6.2 REVIEW)보다 한 단계 위에서, "이 구조 자체가 옳은가"를 1차 원리로 재검토한다. "문서에 알려진 한계로 적혀 있다"는 사실은 정당화로 인정하지 않는다.
- 방법: 12개 독립 렌즈(아키텍처/복잡성, 학습·통계, 보안 모델, 검증 평면, 프롬프트 컴파일, 게이트 분류, 상태·동시성, 의존성·코드·테스트 품질, 누락 요구, FMEA, 문서 정합성, 확장성·UX) → 117개 원시 발견 → 83개 클러스터로 중복 제거 → 발견별 **반증 우선(refute-first) 적대적 재검증** → 코드·런타임 대조. 재검증된 68건 중 **REFUTE 0건**(CONFIRMED 39, PARTIAL 29). 세션 한도로 15개 클러스터와 완결성 패스는 재검증되지 못했다(§7).
- 기준선: `node --test` 300개 전부 통과(Node 22). 이 검토는 **소스를 수정하지 않는다** — 평가와 재설계 제안이 산출물이다.
- 대조 원칙: 문서가 아니라 코드로 검증한다. 재검증 과정에서 원 발견이 과장된 부분은 아래에 명시적으로 바로잡았다(예: claude CLI 플래그는 실제로 유효하다 — §2.1).

---

## 총평

**줄 단위로는 드물게 훌륭하고, 아키텍처 층위에서는 자기 전제를 뒤집는다.** 세 차례의 적대적 버그 헌트를 거친 코드는 fsync 순서, O_EXCL 락, 원자적 rename, 재검증 receipt/attestation 분리 등에서 상용 수준의 견고함을 보인다. 그러나 이 검토의 결론은 개별 버그가 아니라 **구조적 불일치**다.

1. **강제와 권고가 뒤집혀 있다.** DESIGN.md의 핵심 불변식(host는 bootstrap-only, host는 제품 파일을 수정하지 않음, worker receipt는 증거가 아님, harness 변경은 승인 후에만)은 오직 host LLM이 자발적으로 `aorch exec`를 통과할 때만 성립한다. 정작 설치되는 스킬은 그 host에게 `Write`/`Edit`/`Bash`를 그대로 쥐여 주고, 설치되는 훅에는 이를 막을 `PreToolUse` 강제가 없다. 이 제품이 파는 것은 "LLM을 신뢰하는 대신 메커니즘으로 통제한다"인데, 정작 통제는 그 LLM의 협조에 의존한다.

2. **메커니즘이 문제보다 크다.** 단일 사용자 로컬 CLI라는 실제 문제 규모에 비해, (a) 표본이 쌓일 수 없는 적응형 라우팅/학습 평면, (b) 하드코딩 템플릿과 인과관계가 없는 프롬프트 "공식 출처" 검증 체계(그리고 120일 자폭 타이머), (c) 순수 함수를 다시 계산해 기록하는 record-only 섀도, (d) 릴리스마다 드리프트 버그를 낳아 온 손으로 복제한 병렬 구현이 얹혀 있다. DESIGN.md §14는 "복잡성 예산"을 말하지만, 실제로 지출된 복잡성은 그 예산표에 없다.

3. **세 개의 간판 기능이 간판대로 작동하지 않는다.** 이름에 박힌 "adaptive" 라우팅은 기본 흐름에서 학습 데이터를 **단 한 건도** 생성하지 않고(§3.2), "공식 출처 프롬프트 컴파일러"는 출처를 스냅샷·해시·대조하지 않으며(§3.3), "독립 검증"은 worker가 작성한 파일 위에서 worker가 아는 명령을 재실행한다(§3.4).

방어 가능한 핵심 — 크로스-프로바이더 bounded 실행, worktree 격리 재검증, receipt/attestation 분리, 락 걸린 durable 상태 — 은 전체 ~5.5k LOC의 3분의 1 남짓이다. **권장 방향은 강제를 host 훅으로 내려 실제로 구속되게 만들고, 섀도·프로필 신선도·게이트 NLP·학습 층화를 삭제하거나 근본적으로 단순화하는 것이다.**

---

## 2. 재검증에서 바로잡은 원 발견 (정확성 우선)

설계 검토라도 사실이 틀리면 무가치하다. 적대적 재검증에서 원 발견이 과장·오기된 부분을 먼저 바로잡는다.

### 2.1 claude CLI 플래그는 유효하다 — 문제는 "무효 플래그"가 아니라 "컨테인먼트 비대칭"
초기 가설은 `buildClaudeCommand`의 `--permission-mode auto`가 무효라 write 작업이 spawn에서 실패한다는 것이었다. **런타임 확인 결과 이는 틀렸다.** 설치된 claude CLI(v2.1.x)는 `--permission-mode`에서 `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`을 모두 받고, `--effort`/`--json-schema`/`--no-session-persistence`도 유효하다. 따라서 **무효-플래그 결함이 아니다.** 실제 결함은 §3.4에서 확인되는 컨테인먼트 비대칭이다: write worker는 `--permission-mode auto`(자동 승인, 샌드박스 없음, `--allowedTools` 없음)로 실행되는 반면 Codex worker는 `--sandbox workspace-write`(실제 OS 샌드박스)로 실행된다. 남는 어댑터 리스크는 "무효"가 아니라 "미검증": 플래그가 baked-in 상수이고 `doctor`는 `--version`만 확인하므로(§3.6), 향후 CLI 플래그 변경 시 조용히 깨진다.

### 2.2 라우터는 "정적 표"가 아니라 "품질 항만 정적"이다
"라우터가 정적 선호 표로 퇴화한다"는 표현은 과장이다. 자격 필터링·신뢰 등급·capability 검사·lane 분류·host 선호·섀도는 모두 동적이다. **정확히는, 점수의 품질-증거 항만 사전값(prior)으로 퇴화**하며(§3.2), 그 결과 라우팅 결정은 카탈로그에 손으로 박은 상수에 의해 사실상 고정된다.

### 2.3 120일 신선도 절벽에는 config 노브가 있다 — 그래도 기본값이 자폭한다
"신선도를 되살릴 인가된 경로가 없다"는 틀렸다. `promptCompilation.maxProfileAgeDays`는 검증된 config 노브(1..3650)다. 그러나 **패키지 기본 config는 120이고 6개 프로필 전부 릴리스 당일(2026-07-17) 날짜**이므로, 기본 설치는 손대지 않으면 약 120일 뒤 모든 위임 실행이 fail-closed된다(§3.3에서 런타임으로 재현). 설계 결함의 핵심은 "노브가 없다"가 아니라 "기본 정책이 예정된 함대급 중단을 보장한다"이다.

---

## 3. 근본적 설계 결함 (테마별)

각 테마: **증상 → 코드 근거 → 숨은 가정 → 재설계 → 트레이드오프.**

### 3.1 [높음] 불변식이 자발적 경로에서만 강제된다 (통제/권고의 역전)

**증상.** DESIGN.md 불변식 1·2·10과 §13 fail-closed 목록의 상당수는 `aorch exec` 경로 밖에서 강제되지 않는다. host가 `aorch`를 건너뛰고 직접 파일을 편집하면 아무것도 막지 못한다.

**코드 근거.**
- `integrations/claude/skills/adaptive-orchestrate/SKILL.md`의 `allowed-tools: Agent, Read, Grep, Glob, Bash, Write, Edit` — host에게 직접 편집 권한을 부여한다.
- 설치되는 훅은 `UserPromptSubmit`(게이트)와 `SessionEnd`(회고 유도)뿐이며 둘 다 `PreToolUse` 차단이 아니다. `buildGateContext`(gate.mjs:151)는 **안내 문자열만** 반환한다.
- run 완료: `updateTaskState(status:'complete')`·`finishRun('completed')`(state.js)는 host가 준 상태만 요구하고 attestation을 참조하지 않는다. (attestation은 taskId/runId를 담고 control-plane 승인 소비만 attestation-gated이다 — 나머지 성공 상태는 무검증.)
- 승인 경계: `aorch run --action decide --decision approved`(cli.js:319)는 host가 Bash로 그대로 호출할 수 있는 평범한 CLI다. 사람과 오케스트레이팅 LLM을 구분하는 장치가 없다.

**숨은 가정.** "host LLM이 SKILL.md를 성실히 따른다." 이는 이 제품의 존재 이유(신뢰가 아니라 메커니즘)와 정면으로 충돌한다. README:452가 "훅은 OS 샌드박스가 아니라 workflow guardrail"이라고 스스로 밝히지만, 그렇다면 남는 강제 표면은 "host가 aorch를 부르기로 선택할 때"뿐이다.

**재설계.**
1. **강제를 host 훅으로 내린다.** 설치 통합에 `PreToolUse` 훅을 추가해 (a) `configuredProtectedFiles`에 매칭되는 `Edit`/`Write`를 항상 거부하고, (b) active run이 있고 `AORCH_WORKER != 1`인 동안 `.aorch/` 밖 `Edit`/`Write`를 거부한다. 이렇게 하면 "bootstrap-only host"가 안내가 아니라 실제 제약이 된다.
2. **완료를 증거화한다.** 성공 상태(`updateTaskState` 성공군, `finishRun('completed')`)는 `<stateRoot>/task-runs/<runId>/<taskId>/verifier/*/attestation.json`가 `status:'pass'`이고 taskId가 일치할 때만 허용한다.
3. **승인을 사람에 결속한다.** `decide --decision approved`는 TTY + 대화형 확인 문구를 요구하고(비-TTY면 거부), 승인 이벤트를 exact-path 해시 체인 저널(`.aorch/learning/approvals.jsonl`, protectedFiles 편입)에 기록한다.

**트레이드오프.** PreToolUse 훅은 host별 훅 스키마에 의존하고(Claude/Codex가 다름) 유지보수 표면을 늘린다. 완료-증거화는 attestation 없이 끝내는 정당한 저위험 흐름(단순 read-only)을 막을 수 있어 예외 경로가 필요하다. TTY 승인은 CI/헤드리스 자동화를 깨므로 명시적 `--ci-approval-token` 우회가 필요하다. 그럼에도 이 셋이 없으면 "메커니즘 기반 통제"라는 서사 자체가 성립하지 않는다.

### 3.2 [높음] 학습 루프에 데이터 입구가 없다 (간판 "adaptive"가 무동작)

**증상.** 라우터의 유일한 증거 입력은 `.aorch/observations.jsonl`인데, 코드 전체에서 이 파일에 쓰는 경로는 **수동 CLI `aorch record`(cli.js:507→observations.js:appendObservation) 하나뿐**이다. attestation·reviewer 출력·run 결과·회고를 관측으로 변환하는 자동 경로가 없다.

**코드 근거.**
- `observations.js:appendObservation`는 `reviewed:true`를 무조건 각인하고 명시적 `reviewed:false`만 거부한다. "독립 검토됨"은 검증 불가한 self-assertion이며, attestation/review 아티팩트로의 링크(runId/attestation 참조 필드)가 없다.
- 기본 lane 예산(`lane.js` DEFAULT_POLICY)은 `single-worker`·`bundled`에서 `maxLlmReviewers:0`. reviewer가 없으므로 검토될 것이 없다.
- 점수 산정(performance-store.js:186-192): `priorWeight=3`, 반감기 30일. 셀 = provider×profile×model×revision×effort×kind×role×risk×complexity(sameBaseRoute:78-88) + signature 호환. 단일 사용자 표본율 대비 셀 카디널리티가 수천이라, 대부분 셀은 결정을 바꿀 증거를 축적할 수 없다. `modelRevision` 리셋 시 증거는 폐기된다.
- **런타임 재현:** sonnet-high(사전값 0.915)를 완벽 관측(q=1.0, 동일 셀)으로 밀어도 conservative는 n=1→.9163, n=5→.9581, n=10→.9722. 경쟁자 sol-high(구현 사전값 0.975)를 tolerance 0.01 안으로 따라잡으려면 **완벽 관측 ~7–10건**이 필요하고, 현실적 q≈0.85–0.9면 평균이 0.92 밑에 점근해 **영원히 추월 불가**하다. 게다가 incumbent의 사전값은 자기 셀에 관측이 없으면 감쇠하지 않는다.
- 섀도 라우팅(router.js:246)은 outcome이 없는 counterfactual을 기록만 하며 소비자가 없다 — 순수 함수를 다시 계산해 적어 두는 죽은 메커니즘.

**숨은 가정.** "단일 사용자가 좁은 셀에 수십 건의 독립 검토 관측을 몇 주 안에 쌓는다." 표본율·카디널리티·반감기가 이를 구조적으로 불가능하게 한다.

**재설계 (두 갈래, 택1).**
- **(A) 루프를 실제로 닫는다.** `aorch exec` 종료 시 attestation에서 관측을 **자동** 생성해 `source:"attestation"`, runId·attestationPath 링크와 함께 append한다(pass→receipt-confidence 상한 ~0.85, inconclusive→건너뜀, fail/claim-mismatch→저품질). 셀 희소성은 **계층적 풀링/베이지안 축소**로 완화한다(kind×role 수준에서 부분 풀링 후 셀로 축소). 탐색 부재(LCB만으로는 실패한 incumbent만 축출, 더 나은 대안 발견 불가)는 저위험 read-only 작업에 한해 소수 표본 read-only 리뷰 캠페인으로 보완한다.
- **(B) 학습을 삭제한다.** 데이터 소스가 생기기 전까지 ~700 LOC의 학습 장치·섀도·관측 저장을 제거하고, 제품이 실제로 오늘 구현하고 있는 **정적 사전값 라우터**로 정직하게 축소한다. 카탈로그 품질값은 "학습된 값"이 아니라 "튜닝 가능한 정책 상수"로 명명한다.

**트레이드오프.** (A)는 진짜 폐루프 학습을 주지만 attestation→품질 매핑의 신뢰성, 계층 모델의 사전 지정, 탐색-활용 균형을 새로 설계해야 한다(상당한 복잡성). (B)는 정직하고 단순하지만 "adaptive"라는 마케팅 서사와 도메인 이름을 포기해야 한다. **어느 쪽이든 지금처럼 "학습 장치는 있으나 데이터가 없는" 상태는 유지할 수 없다.** 권장: 데이터 소스가 없는 현 시점에는 (B)로 축소하고, (A)의 자동 관측 생성을 첫 증분으로 얹는다.

### 3.3 [높음] "공식 출처 프롬프트 컴파일러"는 메타데이터 극장 + 120일 자폭 타이머

**증상.** 불변식은 "위임 프롬프트는 provider 소유 공식 출처에서 컴파일된다"이지만, 프로필은 인용 URL과 self-declared 날짜가 붙은 **손으로 쓴 JSON**이고, 실제 프롬프트 텍스트는 `prompt-compiler.js`에 하드코딩돼 단일 3값 `rules.detail`로만 분기한다. 인용 문서를 스냅샷·해시·대조하는 코드는 없다.

**코드 근거.**
- `resolvePromptProfile`(prompt-profiles.js:189)는 `assertPromptProfileFresh`로 `oldest verifiedAt > 120일`이면 throw. 6개 프로필 모두 `verifiedAt:2026-07-17`. **런타임 재현:** `now=2026-11-20`에서 `anthropic-claude-sonnet-v1: stale at 126 days` throw → `officialSourcesOnly`(config.js:215, 동결 true)라 claude/codex 모델은 프로필 없이 실행 불가(task-runner.js:255) → `aorch exec`/`prompt`/`doctor` 전부 fail-closed.
- `modelMatches`(prompt-profiles.js:184)는 마케팅명 부분 문자열 매칭(`haiku`/`sonnet`/`opus`, `gpt-5.6-luna/terra/sol`). 신모델은 프로필 부재로 fail-closed되고, promptProfileIds 핀으로도 provider 불일치를 넘어설 수 없다.
- 프로필 `rules`의 대다수 플래그(`includeMotivation`, `preserveImplementationFreedom`, `avoidOverengineering`, `singleObjective`, `avoidTestSpecificSolutions` …)는 컴파일러가 읽지 않는다(compileClaude/compileOpenAI는 `rules.detail`·strategy만, `requiredSections`는 lint만). 즉 "프로필 semantics"의 상당 부분이 미구현 장식이다.

**숨은 가정.** "손으로 적은 날짜가 곧 공식 출처와의 동기화를 뜻한다." 신선도 기계는 사실상 **릴리스 메타데이터에 붙은 데드맨 타이머**일 뿐 아무것도 검증하지 않는다.

**재설계.**
1. **자폭 제거.** 신선도 실패는 실행 차단이 아니라 **경고 + 저하**로 바꾼다: 프로필이 stale하면 provider별 `default`(modelFamilies `['*']`) 보수 프로필로 강등하고 `doctor`에 경고를 남긴다. 오프라인 도구가 날짜 때문에 벽돌이 되어선 안 된다.
2. **마케팅명 제거.** provider별 전략 티어(concise/balanced/deep) + 명시적 오버라이드 체인으로 대체. 미지 모델은 fail-closed가 아니라 balanced로 저하.
3. **"공식 출처"를 실제화하거나 이름을 낮춘다.** 진짜 하려면 인용 문서를 설치 시 스냅샷·해시해 attestation에 결속한다. 그럴 의사가 없으면 "official-source compiler"라는 명명을 "provider-aware prompt template"로 낮춰 과대 서사를 제거한다.

**트레이드오프.** 저하 전략은 "공식 출처만" 불변식을 약화한다(정직성 vs 순수성 교환) — 그러나 현재의 순수성은 실행 불가로 귀결되므로 순가치가 음수다. 진짜 스냅샷/해시는 네트워크·저장·법적(문서 재배포) 문제를 부른다. 최소 안전 조치는 §2.3의 자폭 제거 + 이름 낮추기다.

### 3.4 [높음] 검증 평면의 결합·격리 공백 (증거의 인식론이 새어 있음)

**증상.** "receipt는 claim, attestation은 evidence"는 개념적으로 옳지만, attestation이 실제로 아무것도 결속하지 않고, 검사가 worker가 만든 기질 위에서 돌며, gitignore 사각지대가 강제 전체를 무력화한다.

**코드 근거 (모두 재검증 통과).**
- **내용 미결속:** pass attestation(verifier.js:414-427)은 변경 **경로**·taskHash·claimHash·검사 출력 해시만 담고 base commit/tree/diff 해시가 없다. 검증 대상은 live workspace에서 `git diff --binary HEAD` + live 파일 복사로 재구성되며 fingerprint된 afterState와 대조되지 않는다 → "pass"는 무엇이 통과했는지 고정하지도, 이후 변경을 탐지하지도 못한다. worker가 심은 지연 프로세스로 TOCTOU 창을 임의로 넓힐 수 있다.
- **gitignore 사각지대:** 모든 scope/claim 강제가 `git status --porcelain -z --untracked-files=all`(verifier.js:116, `--ignored` 없음)에 의존한다. gitignore된 파일은 목록에 없으므로, worker가 `.aorch/learning/retrospectives`의 승인을 위조하거나 same-workspace 검증 툴체인을 오염시켜도 보이지 않는다. protected-file 검사도 exact-path fingerprint(config.json, observations.jsonl, lessons.json + 설정된 protectedFiles)에만 의존해 우회된다.
- **테스트 게이밍:** worker-visible `verificationCommands`와 "hidden" `verifierCommands` 모두 worker가 수정한 파일이 든 재구성 workspace에서 `/bin/sh`로 실행된다(verifier.js:404-408). allowedScope에 테스트 파일·package.json·헬퍼가 포함되는 "구현+테스트" 작업은 흔하며, "hidden"은 프롬프트에만 숨겨졌을 뿐(prompt-lint는 프롬프트로의 누설만 검사) 디스크의 task 봉투 JSON에 있어 worker가 읽을 수 있다.
- **미격리 실행:** 검사는 오케스트레이터의 전체 비밀 env와 공유 `.git` common dir로 실행된다. `git-worktree` replay는 ignored 의존물(node_modules)을 제외하므로 전형적 `npm test`/`pytest`가 아예 돌지 않는다 — 15분/30분 예산 안에서 비현실적(문서화 안 됨).
- **컨테인먼트 비대칭:** §2.1대로 write claude worker는 샌드박스·allowlist 없음.
- **공허한 pass:** write 작업이 실행 검사 0건으로 pass를 받을 수 있다(변경 증거만으로). runChecks는 첫 실패에서 멈춘다(부분 증거).

**숨은 가정.** "worker가 만진 파일 위에서 worker가 아는 명령을 재실행해도 독립 증거가 된다", "gitignore된 상태는 강제 대상이 아니다."

**재설계 (최소 건전 증거 모델).**
1. afterState를 **git tree 객체로 스냅샷**하고 attestation에 `treeOid + baseHead + per-file fingerprint`를 기록 → pass가 특정 내용에 결속되고 이후 변경이 탐지된다.
2. 그 tree에서 **독립 저장소로 검증 workspace를 물질화**하고, env allowlist + 선택적 hermetic prepare 단계(의존물 설치)를 둔다.
3. hidden check는 `{ command, requiresUnchanged:[globs] }` 형태로 확장해, `actualChangedFiles`가 `requiresUnchanged`와 교집합이면 fail → 테스트 게이밍 차단.
4. write 작업 pass는 **실행 검사 최소 1건**(또는 명시적 `changeEvidenceOnly` 마커)을 요구.
5. 승인·attestation 인덱스를 exact-path 해시 체인 저널로 이전(gitignore 사각지대 제거).
6. "deterministic verifier" 문구를 폐기한다 — 임의 셸 명령은 결정적이지 않으며 그 주장을 할 필요도 없다.

**트레이드오프.** tree 스냅샷·hermetic prepare는 검증 지연·디스크를 늘리고, requiresUnchanged는 host가 봉투를 더 정교하게 써야 한다. env allowlist는 정당한 도구가 필요로 하는 환경을 끊을 수 있어 화이트리스트 유지보수가 생긴다. 그럼에도 현재는 "독립 검증"이 게임 가능하므로 불변식 5가 사실상 미달이다.

### 3.5 [높음] 게이트 분류기: 잘못된 레이어의 정규식

**증상.** 게이트는 키워드 정규식으로 프롬프트를 분류하지만, 그 판정은 **prose(additionalContext)로 한 번 방출되고 어떤 aorch 컴포넌트도 소비하지 않는다**. 강제력이 없고, 배선 실패(훅 누락·파싱 오류·타임아웃·env 플래그)는 전부 fail-open이다. 게다가 한국어 리콜이 영어보다 크게 낮고 모든 미스가 가장 관대한 클래스로 떨어진다.

**코드 근거.**
- 무매치 기본값은 read-only/failPolicy 'open'(classifyPrompt 마지막 분기). 한국어 고빈도 개발/파괴 동사(개발/작성/짜/지워/릴리즈/올려/반영 등) 다수가 목록에 없어 fail-open으로 분류된다(런타임 확인).
- 0.6.2의 절-범위 부정 수정은 **접속사 순서에 깨진다.** 영어 strip 정규식은 다음 `[.!?,;]`까지 소비하는데 `but`/`and`는 경계가 아니라, 부정이 명령 앞에 오거나 접속사로 이어지면 고위험 요청이 read-only로 강등된다. 한국어의 표준 `말고` 구문에는 구조적으로 죽어 있다.
- 영어 bare noun(`push`/`merge`/`deploy`)이 평범한 질문에서도 high-risk/critical로 과발화(EXTERNAL_ACTION_PATTERNS).

**숨은 가정.** "유지보수 가능한 정규식으로 다국어 의도를 안전하게 분류할 수 있다." 정밀도(과발화)와 리콜(과소발화)이 동시에 한계에 부딪히므로 성립하지 않는다.

**재설계.** 레이어를 다시 나눈다: (1) 정규식 게이트를 **에스컬레이션 바닥(floor)**으로 강등 — 높은 리콜로 튜닝하고 오직 **상향만** 허용(오탐이 무해해진다). (2) bootstrap 계약을 확장해 **host가 구조화된 self-classification**(risk/write/external)을 방출하게 하고, host 판정은 바닥 아래로 내려갈 수 없게 한다. 프런티어 LLM인 host는 한국어 부정 범위·구어체 배포 동사를 어떤 정규식보다 잘 분류한다. (3) 게이트의 실제 가치는 판정이 아니라 **봉투 불변식 강제**로 옮긴다(§3.1의 PreToolUse).

**트레이드오프.** host self-classification은 host를 부분적으로 신뢰하지만, "바닥 위" 제약이 최악을 막고 §3.1의 훅이 강제를 담당하면 신뢰 표면이 제한된다. 정규식을 남기면 이중 유지보수가 남지만 floor로 축소되면 정밀도 요구가 사라져 부담이 준다.

### 3.6 [중간→높음] 복잡성 예산 초과와 이중 유지보수

**증상.** 단일 사용자 도구에 안 맞는 무거운 메커니즘(신뢰 등급, control-plane 승인, 해시 체인)이 있고, 손으로 복제한 병렬 구현이 릴리스마다 드리프트 버그를 낳는다.

**코드 근거.**
- `integrations/shared/journal.mjs`(~205줄)는 `file-store.js`의 락/저널 로직을 손으로 복제한 병렬 구현이다 — 0.6.2의 stale-lock 수정을 "패키지와 설치본 양쪽"에 각각 적용해야 했다.
- `schemas/*.json` vs 손으로 쓴 validator, 미러링된 상수(DEFAULT_COMPLEXITY_BY_RISK가 router.js·performance-store.js 양쪽) 등 lockstep 편집 대상이 다수.
- 성능: 모든 append가 저널 전체를 재파싱·재해시(file-store.js:309), 모든 selectRoute가 모든 관측을 재정규화(O(routes×obs)), 그리고 observations/trace/runs/task-runs에 **보존·압축이 전혀 없다**(lessons만 prune). → 장기 사용 시 append 지연과 5초 락 타임아웃 위험.
- 설치되는 native subagent 정의(aorch-scout/worker/reviewer)는 라우터를 우회하는 죽은 아티팩트다.

**재설계.** (1) 설치 시 `.aorch/hooks/*.mjs`가 `file-store.js`를 기계적으로 vendoring(한 소스, 설치마다 갱신, 버전 매니페스트 기록)하도록 해 손복제를 제거. (2) validator를 `schemas/*.json`에서 빌드 타임 생성(드리프트 클래스 자체 제거) 또는 최소 계약 테스트로 고정. (3) `<journal>.meta.json` 사이드카(count·lastChecksum·byteLength)로 O(1) append. (4) host-측 `aorch compact`(retention). (5) 데이터 소스 확보 전까지 섀도·신뢰 등급 층화를 삭제하거나 문서화된 위협 모델에 결속. (6) 죽은 subagent 정의 제거.

**트레이드오프.** vendoring은 설치 산출물 크기를 늘리고, 스키마 코드젠은 빌드 파이프라인을 추가한다("의존성 없음" 정책과 긴장). 그러나 현재의 이중 유지보수는 이미 반복적 드리프트 버그로 실비용이 확인됐다.

---

## 4. 서브시스템별 확인된 결함 (요약표)

재검증 판정 포함. C=CONFIRMED, P=PARTIAL. 심각도는 재검증 후 보정치.

| # | 심각도 | 판정 | 렌즈 | 결함 (증거) |
|---|---|---|---|---|
| 1 | 높음 | C | arch | 핵심 불변식이 자발적 `aorch exec` 경로에서만 강제 (SKILL.md가 host에 Write/Edit 부여, PreToolUse 없음) |
| 2 | 높음 | C | arch | run 성공 상태가 host 자기보고만 요구, attestation 미결속 (state.js) |
| 3 | 높음 | C | docs | control-plane "사용자 승인"을 제약 대상 LLM이 스스로 호출 가능 (`run --action decide`) |
| 4 | 높음 | C | learn | 기본 흐름이 reviewed 관측을 0건 생성 — 학습 루프 데이터 입구 없음 |
| 5 | 높음 | C | verify | gitignore된 `.aorch`가 worker 쓰기 가능·git-status에 비가시 → 승인 위조·툴체인 오염 |
| 6 | 높음 | C | verify | 검사가 worker가 만든 파일 위에서 실행; hidden 명령이 실제로 숨겨지지도·보호되지도 않음 |
| 7 | 높음 | C | sec | worker 컨테인먼트 비대칭 (claude write=auto·샌드박스 없음 vs codex=OS 샌드박스) |
| 8 | 높음 | C | prompt | 마케팅명 부분매칭 → 신모델 fail-closed, 핀으로도 극복 불가 |
| 9 | 높음 | C | prompt | sections 컴파일러가 task 필드를 이스케이프 없이 주입 → 섹션 헤더 위조 |
| 10 | 높음 | C | prompt | nested-delegation 불변식이 잘못된 레이어의 영어 정규식 (양방향 우회) |
| 11 | 높음 | C | gate | 0.6.2 부정 수정이 접속사 순서에 깨지고 한국어 `말고`에 무동작 |
| 12 | 높음 | C | gate | 한국어 리콜이 영어보다 크게 낮고 미스는 전부 fail-open |
| 13 | 높음 | C | gate | 정규식을 판정-of-record로 둔 레이어 분할이 잘못됨 (host가 self-classify해야) |
| 14 | 높음 | C | state | 상태 무한 증가 + append당 O(N) 재읽기 + selectRoute당 O(N×routes), 보존 없음 |
| 15 | 높음 | P | verify | attestation pass가 내용에 미결속 (base/tree/diff 해시 없음, live-diff TOCTOU) |
| 16 | 높음 | P | learn | 셀 카디널리티 대 표본율 — 대부분 셀이 결정적 증거 축적 불가 (1–2 핫셀만 일부) |
| 17 | 높음 | P | prompt | "공식 출처 컴파일"은 스냅샷/해시/대조 없는 메타데이터 검증 |
| 18 | 높음 | P | fail | 120일 신선도 절벽이 위임 실행 전체를 fail-closed (기본값이 예정된 중단 보장) |
| 19 | 높음 | P | gate | 게이트 판정이 어떤 컴포넌트도 소비 안 함; 배선 실패 전부 fail-open |
| 20 | 높음 | P | test | claude/codex 어댑터 E2E 커버리지 0; 유일한 E2E가 공식 컴파일을 건너뜀 |
| 21 | 중간 | C | prompt | hidden 명령 누설 검사가 raw 문자열을 escape된 프롬프트와 대조 (매칭 실패) |
| 22 | 중간 | C | sec | 리댁션이 non-HTTP 자격증명 URL·prefixless 시크릿을 놓침 |
| 23 | 중간 | C | verify | per-check 출력 해시를 리댁션 전에 계산 → 저장 로그와 해시 불일치 |
| 24 | 중간 | C | learn | 학습 데이터 mid-run 기록이 protected-file 거버넌스를 트립 → 동시 작업 실패 |
| 25 | 중간 | C | learn | `aorch record`가 카탈로그와 대조 안 함 → 매칭 불가 증거가 조용히 사장 |
| 26 | 중간 | C | state | 커스텀 stateDir 하에서 observations 경로 split-brain (보호·doctor 양쪽 회피) |
| 27 | 중간 | C | state | version 필드가 write-only (읽기 검증·마이그레이션 없음) |
| 28 | 중간 | C | miss | 모델 entitlement 미탐 → 첫 실패가 mid-run 불투명 worker 오류로 표면화 |
| 29 | 중간 | C | miss | write 격리 worktree를 host에 요구만 하고 도구가 만들어 주지 않음 |
| 30 | 중간 | C | miss | 업그레이드/제거/상태 마이그레이션 스토리 없음; 설치 산출물 조용히 드리프트 |
| 31 | 중간 | C | docs | protectedFiles 기본 목록이 journal.mjs·agent 정의 등 설치 표면 누락 |
| 32 | 중간 | C | arch | 설치되는 native subagent가 라우터를 우회하는 죽은 아티팩트 |
| 33 | 중간 | C | arch | DESIGN §14 "복잡성 예산"이 실제 지출 복잡성을 설명하지 못함 |
| 34 | 중간 | C | ext | host-LLM 봉투 계약 부정확 (스키마 드리프트, 미지 필드 무시, 매니페스트 스키마 없음) |
| 35 | 중간 | C | quality | glob 구현 2벌 분기; 무효 scope 패턴이 worker 실행 후에야 실패 |
| 36 | 중간 | C | quality | 손수 CLI 파싱 대신 node:util.parseArgs 권장 |
| 37 | 중간 | C | quality | executeTask 360줄 모놀리스; verifier가 attestation 리터럴을 4번 구축 |
| 38 | 중간 | C | quality | win32 경로가 미검증 출하; 패키지가 플랫폼 지원을 선언 안 함 |
| 39 | 중간 | P | verify | 검증 미격리 (전체 비밀 env, 공유 .git common dir) |
| 40 | 중간 | P | verify | git-worktree replay가 ignored 빌드 산출물 제외 → 전형적 검사 불가 |
| 41 | 중간 | P | verify | write 작업이 실행 검사 0건으로 pass (공허한 통과) |
| 42 | 중간 | P | learn | 관측 "독립 검토"가 참조 없는 self-asserted 불리언 |
| 43 | 중간 | P | learn | 불확실성 페널티가 비정합 (필요한 곳에 너무 작고, rich-get-richer) |
| 44 | 중간 | P | learn | record-only 섀도가 소비자 없는 재계산 가능 순수 함수 |
| 45 | 중간 | P | state | 단일 mid-journal 손상 바이트가 observations를 영구 fail-closed |
| 46 | 중간 | P | state | active-run.json이 권고일 뿐 (exec에 상호배제 없음) |
| 47 | 중간 | P | miss | 비용/토큰 회계 없음; 'tokens' 메트릭이 정적 인덱스만 최적화 |
| 48 | 중간 | P | miss | resume/외부 cancel/라이브 검사 없음; 크래시된 run이 락을 물고 있음 |
| 49 | 중간 | P | ext | "신규 provider/model은 설정 항목일 뿐"은 거짓 (어댑터·게이트·프로필에 스며듦) |

저심각(low) 확인 항목(요지): 락 없는 저널 리더·크래시 누수 temp·Windows rename(state); revision-keyed 드리프트 보호가 기본 카탈로그에서 no-op(learn); `npm run check`에 커버리지 게이트 없음(test); 릴리스 위생 잔재(dead export, stale package-lock).

---

## 5. 재설계 종합 (목표 아키텍처)

반복 정제 결과, "최소 건전 코어 + 실제로 구속되는 강제"로 수렴한다.

**5.1 강제를 host 경계로 내린다 (§3.1·§3.5).** 얇은 게이트는 에스컬레이션 바닥으로, 실제 통제는 `PreToolUse` 훅(protected-file 거부, run 중 비-worker write 거부)과 증거화된 완료로. 이것이 "메커니즘 기반 통제" 서사를 처음으로 참으로 만든다.

**5.2 검증을 진짜 독립적으로 (§3.4).** tree-oid 결속 attestation + hermetic 검증 workspace + requiresUnchanged + 최소 1개 실행 검사 + exact-path 해시 체인 승인 저널. gitignore 사각지대를 닫는 것이 승인·라우팅 증거 위조를 동시에 막는 단일 지렛대다.

**5.3 간판 기능을 정직하게 (§3.2·§3.3).** 학습은 (B)로 축소 후 attestation 자동 관측을 첫 증분으로. 프롬프트는 자폭 제거 + provider별 전략 티어 + 이름 낮추기. 섀도 삭제.

**5.4 복잡성 예산 재정렬 (§3.6).** 손복제 vendoring, 스키마→validator 코드젠(또는 계약 테스트), retention/compaction, 죽은 subagent 제거. 남기는 신뢰 등급·control-plane은 **문서화된 위협 모델**에 결속하거나 삭제.

**5.5 운영/이식성 (§4).** entitlement canary(§3.6의 doctor 확장), worktree 자동 provisioning, resume/cancel/compact 명령, 상태 version 읽기 검증 + 마이그레이션, win32 지원을 선언하거나 스코프아웃, 비용/토큰 회계(provider usage 파싱).

**최소 건전 코어(유지):** 크로스-프로바이더 bounded 실행, worktree 격리 재검증, receipt/attestation 분리, 락 걸린 durable 상태. 이 3분의 1이 제품의 실질 가치다.

---

## 6. 우선순위 로드맵

1. **정직성·안전 (즉시):** 120일 자폭 제거(§2.3), 완료의 attestation 결속(§3.1.2), gitignore 사각지대 폐쇄(§3.4.5), claude write worker allowlist/샌드박스(§2.1).
2. **간판 기능 정렬 (단기):** 학습 (B) 축소 + attestation 자동 관측, 섀도 삭제, 게이트 floor화 + host self-classify.
3. **강제 하강 (중기):** PreToolUse 훅, exact-path 승인 저널, requiresUnchanged, hermetic 검증.
4. **복잡성 상환 (지속):** 손복제 vendoring, 스키마 코드젠, retention, win32 결정, 비용 회계, 영어 문서.

---

## 7. 검토 방법론과 한계

- **검증된 것:** 83개 클러스터 중 68개가 반증-우선 재검증을 통과했고 **REFUTE 0건**(CONFIRMED 39, PARTIAL 29). PARTIAL은 핵심 주장이 서되 인용·프레이밍 교정이 필요한 경우로, 위 본문에 교정을 반영했다.
- **재검증 못 한 것(세션 한도로 15개 클러스터 + 완결성 패스):** 주로 FMEA·문서 정합성·확장성 렌즈의 개별 항목 — captureWorkspaceState 전체 버퍼링(§4의 성능 계열과 정합), kill-9 고아 worker 재조정 부재, 비-ASCII receipt 청크 디코딩, LFS/서브모듈 워크트리 재구성, Luna 프로필의 context/forbiddenScope 폐기, discovery merge가 비활성 capability를 강제 활성화, Codex SessionEnd 훅 부재, 영어 문서 부재 등. 이들은 **재검증 대기** 상태로, 신뢰도는 CONFIRMED 항목보다 낮게 취급해야 한다.
- **런타임으로 직접 재현한 것:** 학습 관성(estimateRouteQuality 실측), 120일 프로필 벽돌화(resolvePromptProfile throw), claude CLI 플래그 유효성(§2.1) — 이 셋은 코드 정독이 아니라 실행으로 확인했다.
- **범위:** 이 문서는 평가·재설계 제안이며 소스를 수정하지 않았다. 300개 테스트는 검토 시작·종료 시 모두 통과 상태였다.
