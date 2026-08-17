# 역할 에이전트 정상화와 확장 (접근안 B, 2단계)

## 목표

역할 프리셋이 워커에 실제로 적용되면서 receipt 계약도 지켜지는 상태를 만들고(1단계), 그 검증된 틀 위에 조사·분석·라이선스검토·포니테일 역할을 얹어 오픈소스 차용 파이프라인을 돌린다(2단계).

## 접근

1단계는 **지금 깨져 있는 것을 고치는 일**이다. `--agent`로 프리셋을 넘기면 receipt가 사라지고, 워커는 도구를 아예 못 쓰며, 프리셋이 선언한 턴 예산은 무시된다 — 셋 다 이번 조사에서 실측으로 확인했다. 2단계는 그 위에 역할을 4개 얹는다.

순서를 나눈 이유는 하나다. 이 영역에서 **"선언 통과 ≠ 동작"이 기본값**임을 세 번 확인했다(`--agent` 파싱 통과·출력 죽음, `maxTurns` 선언 무효, `codex exec --search` 거부). 1단계를 도그푸딩으로 검증하기 전에 역할을 4개 늘리면 넷이 같은 방식으로 깨져 있어도 알 수 없다.

## 검증 명령

```bash
npm run check     # node scripts/check-syntax.mjs && node --test  (전체 게이트)
node --test test/<파일>.test.js   # 슬라이스별
```

프로젝트 루트에 `CLAUDE.md`/`AGENTS.md`가 없어 `package.json`의 `scripts`가 유일한 규약 출처다.

## 조사에서 확정된 실측 사실 (구현 근거)

| 사실 | 실측 내용 |
|---|---|
| 프론트매터 `tools:`가 구조화 출력을 죽인다 | 이분: `tools:`만 선언 → NO / `disallowedTools:`만 → YES / `maxTurns:`만 → YES / 본문만 → YES |
| `--agent` 자체는 무해 | 최소 프리셋 + `--agent` → structured_output YES |
| `--agent`와 `--model`은 공존 | `--model haiku`→`claude-haiku-4-5`, `sonnet`→`claude-sonnet-5`. 프리셋 본문도 적용됨 |
| 헤드리스에서 어떤 permission-mode도 도구를 허용하지 않는다 | `auto`·`dontAsk`·`acceptEdits`·`bypassPermissions` 전부 Bash 거부. `--allowed-tools`만 통함 |
| 도구 플래그는 read-only를 보장하지 못한다 | `--disallowed-tools Write Edit` + 프리셋 차단목록에도 셸로 파일 생성 성공 |
| `--max-turns`가 프리셋 `maxTurns`를 이긴다 | 프리셋 2, 플래그 8 → 9턴 실행 |
| 없는 에이전트는 하드 에러 | `exit 1`, `--agent '<name>' not found. Available agents: ...` |
| Windows 셸 도구명은 `PowerShell` | `Bash`만 허용한 목록에서 `PowerShell` 거부 5회 |
| codex 웹 검색은 `exec`에서 `--search` 불가 | `exit 2 unexpected argument`. `--enable web_search`는 **실제 작동 확인**(MIT 정답 + URL 반환) |
| ponytail / ECC 모두 MIT | ponytail: DietrichGebert 2026 / ECC: Affaan Mustafa 2026 |
| ECC 68개 에이전트 전수 | `model:` 68/68, `tools:` 68/68 — 주류 패턴은 우리와 요구가 다름 |

## 안 만드는 것 (명시적 non-goal)

- **모델을 이름에 박은 "일개미" 프리셋**(luna 일개미 / terra 숙련 일개미 / opus 고급 일개미). 그건 역할이 아니라 **등급**이고, 등급은 `aorch route`가 관측을 반영해 이미 판정한다. 프리셋에 모델을 박으면 "역할과 등급이 서로 모르는 두 개의 진실"이 재발하고, 관측이 "이 kind에선 이 티어가 실패한다"고 말해도 프리셋은 계속 같은 모델을 쓴다. 작업 성격(대량·반복·저위험)을 표현할 자리는 task의 `kind`/`complexity`다.
- **ECC 68개 에이전트의 대량 이식.** 훔칠 것은 변환 규칙 검증용 샘플, `agent-evaluator` 개념, 멀티호스트 배포 구조 셋뿐이다(결정 19).
- **실시간 감시 채널.** dispatch는 순차 실행이고 워커는 위임 금지(depth 1)라 구조상 불가능하다. 감시는 단계 뒤 검토 task로 표현한다.

---

# 1단계 — 프리셋 메커니즘 정상화

### 작업 1: 워커 도구 허용목록 (미커밋 상태 마감)

대상 파일: `src/providers/claude-cli.js`, `test/providers.test.js`

작업 트리에 이미 구현돼 있고 `npm run check` 통과 상태다. 웹 도구와 PowerShell을 추가해 완성한다.

- [x] `READ_TOOLS`에 `WebSearch`, `WebFetch`, `PowerShell`을 추가한다 — 최종 `['Read', 'Grep', 'Glob', 'Bash', 'PowerShell', 'WebSearch', 'WebFetch']`. 웹은 모든 역할에 허용하기로 한 결정이고, `PowerShell`은 Windows 셸 도구명이 별개라 빠지면 거부 루프가 난다
- [x] `test/providers.test.js`의 허용목록 단언을 새 목록으로 갱신하고, `PowerShell`과 `WebSearch`가 read-only·write 양쪽에 들어가는지 단언한다
- [x] 검증: `node --test test/providers.test.js` — 허용목록 7종, write는 추가로 `Write`·`Edit`, read-only는 `--disallowed-tools Write Edit NotebookEdit`

### 작업 2: 프리셋에서 `tools:` 제거

대상 파일: `integrations/claude/agents/aorch-worker.md`, `aorch-reviewer.md`, `aorch-fixer.md`, `aorch-scout.md`, `test/install.test.js`

- [x] `aorch-worker.md`·`aorch-fixer.md`: `tools:` 줄을 제거하고 `disallowedTools: Agent`를 유지한다
- [x] `aorch-reviewer.md`: `tools:` 줄을 제거하고 `disallowedTools: Write, Edit, NotebookEdit, Agent`로 확장한다(현재는 `Write, Edit, Agent`)
- [x] `aorch-scout.md`: `tools:` 줄을 제거하고 `disallowedTools: Write, Edit, NotebookEdit, Agent`로 확장한다. `model: haiku`·`effort: low`는 **유지**한다 — scout는 위임 워커가 아니라 리드 도구다
- [x] 각 파일 frontmatter 아래에 한 줄 주석을 남긴다: 왜 `tools:`를 쓰지 않는지(허용목록이 구조화 출력 도구를 목록에서 제외해 receipt가 사라진다)
- [x] `test/install.test.js`에 단언 추가: 설치된 4개 프리셋 어디에도 `^tools:`가 없고, worker·fixer·reviewer·scout 전부 `^disallowedTools:`를 갖는다
- [x] 검증: `node --test test/install.test.js` — 위 단언 통과, 기존 "worker/reviewer/fixer는 model 없음, scout는 있음" 단언도 유지

### 작업 3: 프리셋 존재 검증과 turn 예산 배선

대상 파일: `src/role-agent.js`, `src/task-runner.js`, `test/dispatch.test.js`

- [x] `src/role-agent.js`에 `readClaudePreset({ name, cwd })` 추가 — `<cwd>/.claude/agents/<name>.md`를 우선 읽고 없으면 패키지의 `integrations/claude/agents/<name>.md`를 읽는다(codex 경로와 동일한 우선순위). 둘 다 없으면 `Claude agent preset <name>.md not found for agentRole <role>; run \`aorch install\`` 메시지로 throw
- [x] 같은 파일에 `parseFrontmatterNumber(text, key)` 추가 — `^maxTurns:\s*(\d+)$`만 뽑는 최소 구현. YAML 파서를 의존성으로 들이지 않는다(런타임 의존성 0 유지)
- [x] `resolveRoleAgent`의 claude 분기가 `{ agent, maxTurns }`를 반환하도록 확장한다. `maxTurns`는 프리셋에 없으면 `undefined`
- [x] `src/task-runner.js`가 `rolePreset.maxTurns`를 `buildClaudeCommand`의 `maxTurns`로 넘긴다. 우선순위는 `task.maxTurns ?? rolePreset.maxTurns ?? 80` — 태스크가 명시하면 그게 이기고, 아니면 역할별 예산이, 둘 다 없으면 기본값
- [x] 검증: `node --test test/dispatch.test.js` — 존재하는 프리셋에서 `maxTurns`가 파싱되고, 없는 이름이면 `run \`aorch install\`` 문구를 담아 throw하며, `task.maxTurns`가 프리셋 값을 덮어쓰는지

### 작업 4: codex 웹 검색 배선

대상 파일: `src/providers/codex-cli.js`, `test/providers.test.js`

- [x] `buildCodexCommand`의 args에 `--enable`, `web_search`를 추가한다. `codex exec --search`는 거부되지만 `--enable web_search`는 실제로 검색을 수행하는 것이 실측으로 확인됐다
- [x] 그 근거를 한 줄 주석으로 남긴다 — 다음 사람이 `--search`로 "고치려는" 것을 막기 위해
- [x] 검증: `node --test test/providers.test.js` — codex args에 `--enable web_search`가 있고 `--search`는 없다

### 작업 5: 틀린 문서 정정

대상 파일: `integrations/claude/skills/adaptive-orchestrate/SKILL.md`, `integrations/codex/skills/adaptive-orchestrate/SKILL.md`, `CHANGELOG.md`, `test/install.test.js`

커밋 `cbaeba4`가 *"Claude는 `--agent`로 지정되어 도구 제한까지 적용된다 / reviewer가 진짜로 편집하지 못한다"*고 단언했는데 실측이 반박했다. 셸이 있으면 편집 도구를 막아도 파일을 만든다.

- [x] 두 SKILL.md의 Claude/Codex 비대칭 문단을 정정한다 — 프리셋은 **행동**을 싣고, 도구 제한은 **CLI 허용목록**이 걸며, read-only의 실질 보장은 **change guard의 사후 트리 대조**라는 것으로. "reviewer가 진짜로 쓰지 못한다"는 표현을 지운다
- [x] `CHANGELOG.md`의 대응 문장도 같은 내용으로 정정한다(항목을 지우지 말고 정정 사실을 남긴다)
- [x] `test/install.test.js`에 단언 추가: 설치된 SKILL.md에 `reviewer genuinely cannot write` 류 문구가 **없다**
- [x] 검증: `node --test test/install.test.js` 통과, 그리고 `grep -rn "genuinely cannot" integrations/` 가 0건

### 작업 6: 1단계 도그푸딩 (게이트)

대상 파일: 없음 (실행 검증)

**2단계 착수 조건이다. 여기서 receipt가 안 나오면 2단계는 시작하지 않는다.**

- [x] `npm run check` 전체 통과
- [x] `node src/cli.js install --target both`로 로컬 설치본을 갱신한다
- [x] 읽기 전용 task 1개짜리 계획으로 `aorch dispatch --plan <file>`을 실행한다(agentRole `worker`)
- [x] 실행 결과의 `receipt.json`이 **워커 receipt**인지 확인한다 — `status`·`filesChanged`·`filesInspected`·`commands`·`criteria` 필드가 존재해야 한다. `is_error`·`session_id`·`usage`가 최상위에 있으면 CLI 봉투가 저장된 것이고 실패다
- [x] `.aorch/observations.jsonl` 행 수가 1 증가하는지 확인한다
- [x] 쓰기 task 1개(격리된 worktree)로 같은 확인을 반복하고, `changeGuard.passed`와 `claimedFiles`/`actualFiles` 일치를 확인한다
- [x] 결과를 이 문서의 "1단계 도그푸딩 결과" 절에 기록한다(성공/실패와 증거 경로)

### 작업 7: 타 프로젝트 설치본 갱신

대상 파일: 없음 (배포)

- [x] 작업 6이 통과한 뒤에만 실행한다
- [x] `node src/cli.js update` 로 레지스트리의 3개 프로젝트(`책 만들기`, `주식트레이더`, `study-agent`)를 갱신한다
- [x] 검증: `node src/cli.js update --check` 가 `stale: 0`을 보고한다 — 실행 결과 `refreshed: 3, stale: 0, failed: 0`

---

# 2단계 — 역할 확장과 드림팀

### 작업 8: `agentRole` 4개 신설

대상 파일: `src/decompose.js`, `schemas/task-plan.schema.json`, `config/aorch.config.json`, `src/config.js`, `test/decompose.test.js`, `test/config.test.js`

- [x] `src/decompose.js`의 `AGENT_ROLES`를 7개로 확장한다: `worker→executor`, `fixer→executor`, `reviewer→reviewer`, `researcher→executor`, `analyst→executor`, `license-reviewer→reviewer`, `ponytail→reviewer`. ponytail이 reviewer 파생인 이유는 판정 역할이기 때문이고, 실제 수정은 뒤따르는 fixer task가 한다(결정 11)
- [x] `schemas/task-plan.schema.json`의 `agentRole` enum을 같은 7개로 갱신하고, 각 값의 용도를 `description`에 한 줄씩 적는다
- [x] `src/config.js`의 `AGENT_ROLE_KEYS`와 `DEFAULT_ROLE_AGENTS`를 7개로 확장한다 — 신규 4개의 기본 에이전트명은 `aorch-researcher`, `aorch-analyst`, `aorch-license-reviewer`, `aorch-ponytail`
- [x] `config/aorch.config.json`의 `roleAgents` 블록에 4개를 추가한다(claude·codex 양쪽)
- [x] 검증: `node --test test/decompose.test.js test/config.test.js` — 7개 매핑 확인, enum 밖 값 거부, roleAgents 부분 선언 거부

### 작업 9: 신규 프리셋 4종 작성

대상 파일: `integrations/claude/agents/aorch-researcher.md`, `aorch-analyst.md`, `aorch-license-reviewer.md`, `aorch-ponytail.md` 및 `integrations/codex/agents/` 대응 4종, `NOTICE`, `test/install.test.js`

모든 신규 프리셋은 `tools:`를 쓰지 않고 `disallowedTools:`만 쓴다(작업 2와 동일 규칙).

- [x] `aorch-researcher` — 웹에서 후보를 찾고 **URL·라이선스·최근 커밋일·스타수를 증거로 남긴다**. 판단이 아니라 수집이 임무이며 추천 순위를 매기지 않는다. 차단: `Write, Edit, NotebookEdit, Agent`
- [x] `aorch-analyst` — 지목된 저장소를 읽고 **훔칠 수 있는 것과 없는 것을 구조 단위로 가른다**. 각 항목에 파일 경로와 의존성을 붙이고, 우리 구조와 충돌하는 지점을 명시한다. 차단: `Write, Edit, NotebookEdit, Agent`
- [x] `aorch-license-reviewer` — 라이선스 원문을 확인하고 **차용 형태별로 의무를 판정한다**(그대로 복사 / 수정 후 복사 / 아이디어만). 고지 의무가 있으면 어디에 무엇을 써야 하는지 문장으로 제시한다. 불확실하면 "불확실"로 답하고 추정하지 않는다. 차단: `Write, Edit, NotebookEdit, Agent`
- [x] `aorch-ponytail` — 계획이나 diff를 받아 **"이건 안 써도 된다"를 먼저 찾는다**. 삭제·미작성 제안을 우선하고, 남겨야 할 것에는 이유를 붙인다. 코드를 직접 고치지 않고 판정만 낸다. 차단: `Write, Edit, NotebookEdit, Agent`
- [x] `aorch-ponytail` 두 파일 상단에 출처 주석을 넣는다: `Adapted from ponytail (https://github.com/DietrichGebert/ponytail), MIT License, Copyright (c) 2026 DietrichGebert.`
- [x] 저장소 루트에 `NOTICE` 파일을 만들어 ponytail의 MIT 전문과 저작권 고지를 싣는다
- [x] `package.json`의 `files` 배열에 `"NOTICE"`를 추가한다 — 배포물에 고지가 빠지면 MIT 의무 위반이다
- [x] `test/install.test.js`에 단언 추가: 신규 4종이 claude·codex 양쪽에 설치되고, `tools:`가 없고, `aorch-ponytail`에 `MIT` 및 `DietrichGebert` 문자열이 있다
- [x] 검증: `node --test test/install.test.js` 및 `npm run check`

### 작업 10: 드림팀 계획 템플릿

> **실행 중 조정**: T2(코드분석)를 `complexity: standard`로 두니 라우터가 `claude-haiku/medium`을 골랐다. 낯선 저장소에서 의존성을 추적하고 설계 충돌을 짚는 일은 이 계획에서 가장 어려운 추론이고 이후 단계가 전부 그 산출 위에 서므로 `high`로 올렸다 — 결과 `codex-terra/xhigh`. 라우터를 원하는 모델이 나올 때까지 조정한 것이 아니라, 분류가 실제 난이도를 과소평가했던 것을 고친 것이다.

대상 파일: `examples/plan-oss-adoption.json`, `integrations/claude/skills/adaptive-orchestrate/SKILL.md`, `integrations/codex/skills/adaptive-orchestrate/SKILL.md`

- [x] `examples/plan-oss-adoption.json`을 작성한다 — 5개 task를 선언 순서대로: ① `researcher` 후보 조사(`kind: research`, `complexity: standard`) ② `analyst` 구조 분석(`kind: exploration`, `complexity: standard`) ③ `reviewer` sol 검토(②의 결과 감시) ④ `license-reviewer` 라이선스 판정(`kind: risk-analysis`) ⑤ `ponytail` 축소 판정. 전부 `write: false`
- [x] 조사 task의 `complexity`를 `standard`로 두는 이유를 파일 안 주석 대신 계획 템플릿의 `objective` 문장에 녹인다 — `low`로 두면 codex 쪽에 갈 route가 없다(luna는 kind 미지원, terra는 low 미커버)
- [x] 감시 task(③)의 `objective`에 "②의 산출을 독립적으로 반박하라"를 명시하고 `allowedProviders`를 `["openai"]`로 제한해 sol 계열이 맡도록 한다
- [x] 두 SKILL.md에 한 문단 추가 — 오픈소스 차용 요청이 들어오면 이 템플릿을 복사해 쓰라는 지시와 파일 경로
- [x] 검증: `node src/cli.js decompose --plan examples/plan-oss-adoption.json` 이 `ok: true`, `taskCount: 5`를 출력하고, `node src/cli.js dispatch --plan examples/plan-oss-adoption.json --dry-run` 이 5개 task에 서로 다른 에이전트를 배정하며 ③이 openai로 가는 것을 확인

### 작업 11: ECC 실전 1회

대상 파일: `docs/handoff/2026-08-17-ecc-adoption.md` (신규)

- [ ] `C:/Users/goyan/Downloads/ECC-main.zip`을 세션 스크래치패드(`$TEMP/claude/.../scratchpad/ecc/`)에 푼다. **저장소 안에 넣지 않는다** — 4,745 파일이 change guard의 트리 대조를 오염시킨다
- [ ] `examples/plan-oss-adoption.json`을 복사해 대상 경로를 그 스크래치패드로 채운 계획을 만들고 `aorch dispatch --plan <file>`을 실행한다. 워커의 `allowedScope`에 스크래치패드 경로를, `forbiddenScope`에 `src/**`·`integrations/**`를 넣어 조사 대상과 우리 코드를 분리한다
- [ ] 산출을 `docs/handoff/2026-08-17-ecc-adoption.md`에 정리한다 — 훔칠 것 목록(파일 경로 포함), 라이선스 판정, ponytail의 축소 제안, 그리고 **드림팀 자체의 실측 평가**(어느 단계가 값을 냈고 어느 단계가 낭비였나)
- [ ] 결정 19의 세 항목이 답을 얻었는지 확인한다: 변환 규칙 검증용 샘플 / `agent-evaluator` 도입 여부 / 멀티호스트 배포 구조 차용 여부
- [ ] 검증: 위 문서가 존재하고 세 항목 각각에 결론 문장이 있으며, `.aorch/observations.jsonl`에 이번 실행의 관측이 기록됨

---

## 완료 조건

- [ ] `npm run check` 전체 통과
- [ ] 1단계 도그푸딩(작업 6)에서 **워커 receipt 필드가 실제로 존재**함을 확인
- [ ] `aorch dispatch --plan examples/plan-oss-adoption.json --dry-run` 이 5개 task에 5개 역할을 배정
- [ ] `NOTICE` 파일 존재 및 `package.json` `files`에 포함
- [ ] ECC 실전 산출 문서가 결정 19의 세 항목에 답함

## 1단계 도그푸딩 결과

**통과 (2026-08-17).** 이 프로젝트에서 Claude 워커가 제대로 된 receipt를 낸 첫 사례다.

**읽기 전용** — `T-gate-readonly` (exploration/low → claude-haiku), `.aorch/task-runs/876bb695-.../T-gate-readonly`
```
receipt 판정  : 워커 receipt (CLI 봉투 아님)
status        : complete       filesChanged : []
filesInspected: ["src/cli.js"] commands     : 1건
criteria      : pass,pass,pass confidence   : 0.98
```
관측 12행 → 13행.

**쓰기** — `T-gate-write` (documentation/low), 격리 worktree `.claude/worktrees/gate-write`에서 실행 후 정리
```
receipt 판정 : 워커 receipt          status: complete, confidence 0.99
change guard : applicable=true, passed=true, reason=null
actualFiles  : ["docs/gate-probe.md"]
claimedFiles : ["docs/gate-probe.md"]
unclaimed [] / overclaimed [] / outOfScope []
```
**change guard가 처음으로 실제 claim과 실제 변경을 대조했다.** 이전에는 receipt가 CLI 봉투라 `filesChanged`가 `undefined`였고 대조가 공회전했다.

전체 게이트: `npm run check` → 264 테스트, 263 pass / 0 fail / 1 skip(symlink 권한, 기존 환경 제약).
