# aorch 분해–분배 파이프라인 (접근안 B)

## 목표

사용자가 작업 하나를 지시하면 aorch가 분해 여부를 판정하고, 분해된 각 서브태스크를 역할 에이전트에 자동 배정·라우팅·실행·검증해 사용자 개입 없이 통합 지점까지 끌고 간다.

## 접근

분해 자체는 호스트 모델이 수행하되(추가 모델 비용 0), **출력 형식을 aorch가 스키마로 강제하고 검증**한다. 그래야 "리드가 성실히 따르느냐"에 의존하는 권고형 약점을 벗어난다. 라우터의 기존 `role` 계약(`planner/executor/reviewer`)은 건드리지 않고, 계획에 `agentRole`(worker/reviewer/fixer)을 두어 에이전트 선택 축만 추가한다.

목적함수를 "시간·한도 절약"에서 **"사용자 개입 최소화 + 한도 절약(품질 바닥선 유지)"**로 개정한다. 그 귀결로 다운시프트 기준이 "바닥선을 넘는 가장 싼 모델"에서 "1회 통과 확률이 충분한 모델"로 바뀐다.

## 검증 명령

```bash
npm run check     # node scripts/check-syntax.mjs && node --test  (전체 게이트)
npm test          # node --test
node --test test/<파일>.test.js   # 슬라이스별 집중 검증
```

프로젝트 루트에 `CLAUDE.md`/`AGENTS.md`가 없어 `package.json`의 `scripts`가 유일한 규약 출처다.

## 알려진 위험 (착수 전 인지)

- **관측 부족**: 현재 `.aorch/observations.jsonl`은 9행이고 `priorWeight: 3`이라 증거가 사전분포를 거의 못 민다. 결정 #5(관측 누적 학습)는 도그푸딩 볼륨이 쌓이기 전까지 실효가 없다. 그 기간 동안 라우팅은 config의 선언된 prior가 지배한다 — 이는 버그가 아니라 의도된 중간 상태다.
- **분해기 non-goal 폐기**: `docs/superpowers/specs/2026-07-24-aorch-v1-decompose-delegate-design.md:29` 및 §9가 분해기를 명시적 non-goal로 기록했다. 본 계획이 그 결정을 뒤집는다. 근거는 (a) 호스트 분해 + 스키마 강제라 "분해기를 짓는" 비용을 치르지 않고, (b) RSTD·GDT 등 2026년 선행연구가 코딩 에이전트 분해의 구조를 제시했다는 것.
- **속도 대가**: 분해된 워크플로는 선행연구 기준 평균 35% 느리다. 개정된 목적함수는 벽시계 시간이 아니라 사용자 개입 시간을 최소화하므로 이 손실을 수용한다.

---

### 작업 1: 분해 계획 스키마와 검증 함수

대상 파일: `schemas/task-plan.schema.json`, `src/decompose.js`, `test/decompose.test.js`

계획 문서 형식은 다음으로 고정한다.

```json
{
  "objective": "<사용자 지시 원문>",
  "decomposed": true,
  "tasks": [ { "<기존 task envelope 필드>": "...", "agentRole": "worker" } ]
}
```

> **정정 (실행 중 확인)**: 이 저장소는 런타임 의존성이 0개다(`package.json`의 `dependencies`/`devDependencies` 모두 비어 있음). 따라서 `schemas/task-plan.schema.json`은 검증 라이브러리가 소비하는 파일이 아니라 **`--print-schema`가 호스트 모델에게 내보내는 계약 문서**이고, 실제 검증은 `src/decompose.js`가 손으로 한다. 기존 `schemas/worker-receipt.schema.json`도 같은 패턴이다 — `src/task-runner.js:100`이 읽어서 워커에게 넘길 뿐 로컬 검증에 쓰지 않는다.

- [x] `schemas/task-plan.schema.json` 작성 — 최상위 `objective`(non-empty string), `decomposed`(boolean), `tasks`(minItems 1) 필수. 각 task의 필수 필드는 `src/task.js`의 `validateTask(input, { forExecution: true })`가 실제로 요구하는 것에 맞춘다: `id`(path-safe), `objective`, `kind`, `risk`, `acceptanceCriteria`(minItems 1). 여기에 `agentRole` 필수, enum `["worker", "reviewer", "fixer"]`. `title`·`write`·`complexity`는 선택(`complexity`는 `risk`에서 파생됨). `role`은 **금지 필드**로 명시한다
- [x] `src/decompose.js`에 `validateTaskPlan(plan)` 작성 — 스키마 위반 시 위반 항목을 담은 `TypeError` throw, 통과 시 정규화된 계획 객체 반환. `src/task.js`의 `validateTask`를 각 task에 재사용
- [x] `validateTaskPlan`이 `tasks[].id` 중복을 거부하도록 추가 (dispatch가 id로 실행 디렉터리를 가르기 때문)
- [x] `src/decompose.js`에 `routingRoleFor(agentRole)` 작성 — `worker`→`executor`, `fixer`→`executor`, `reviewer`→`reviewer`. 미지값은 throw
- [x] `decomposed: false`이면 `tasks` 길이가 정확히 1이어야 한다는 규칙 추가 (분해 안 함 = 단일 작업)
- [x] 검증: `node --test test/decompose.test.js` — 유효 계획 통과, `agentRole` 누락/오타 거부, id 중복 거부, `decomposed:false` + tasks 2개 거부, `routingRoleFor` 3종 매핑 확인

### 작업 2: `aorch decompose` CLI

대상 파일: `src/cli.js`, `test/cli-smoke.test.js`

- [x] `COMMAND_FLAGS`(src/cli.js:40)에 `decompose: [...COMMON_FLAGS, 'plan', 'print-schema']` 추가
- [x] `main()`에 `command === 'decompose'` 분기 추가 — `--print-schema`면 `schemas/task-plan.schema.json` 내용을 stdout에 출력하고 종료
- [x] `--plan <path>` 이면 파일을 읽어 `validateTaskPlan`에 넣고, 통과 시 `{ ok: true, taskCount, agentRoles }` JSON을 출력, 실패 시 위반 내용을 stderr에 쓰고 exit code 1
- [x] `--plan`과 `--print-schema` 둘 다 없으면 사용법을 stderr에 쓰고 exit code 1
- [x] `src/cli.js`의 help 텍스트에 `decompose` 항목 추가
- [x] 검증: `node --test test/cli-smoke.test.js` — `decompose --print-schema`가 유효 JSON을 뱉고, 유효 계획 파일에 exit 0, 깨진 계획 파일에 exit 1

### 작업 3: role→agent 매핑을 config에 선언

대상 파일: `config/aorch.config.json`, `src/config.js`, `test/config.test.js`

- [x] `config/aorch.config.json` 최상위에 `roleAgents` 블록 추가. 각 항목은 `{ "<agentRole>": { "claude": "<agent name>", "codex": "<agent name>" } }` 형태로 `worker`→`aorch-worker`, `reviewer`→`aorch-reviewer`, `fixer`→`aorch-fixer` 선언
- [x] `src/config.js`에 `roleAgents` 검증 추가 — 세 키가 모두 존재하고 **실제로 쓰이는 adapter마다** non-empty string인지.
      *(정정 1: 키를 provider id가 아니라 **adapter**(claude/codex)로 잡았다 — 프리셋이 `integrations/<adapter>/agents/`에 살기 때문. 정정 2: 블록 부재를 검증 실패로 두면 사용자의 기존 `.aorch/config.json` 설치본이 로드 실패한다. 부재 시 shipped 기본값을 쓰고, 선언되면 엄격 검증한다. "dispatch가 추측하지 않는다"는 의도는 dispatch 쪽 fail-closed로 지킨다.)*
- [x] `src/config.js`가 `roleAgents`를 정규화된 config에 실어 보내도록 반환값에 포함
- [x] 검증: `node --test test/config.test.js` — 정상 블록 통과, 키 누락 거부, 빈 문자열 거부, 블록 자체 부재 거부

### 작업 4: fixer 에이전트 추가와 모델 하드코딩 제거

대상 파일: `integrations/claude/agents/aorch-fixer.md`, `integrations/codex/agents/aorch-fixer.toml`, `integrations/claude/agents/aorch-worker.md`, `integrations/claude/agents/aorch-reviewer.md`, `integrations/codex/agents/aorch-worker.toml`, `integrations/codex/agents/aorch-reviewer.toml`, `test/install.test.js`

- [x] `integrations/claude/agents/aorch-fixer.md` 신규 작성 — frontmatter `name: aorch-fixer`, `description`, `tools: Read, Grep, Glob, Bash, Write, Edit`, `disallowedTools: Agent`. 본문은 "실패한 검증 출력과 기존 diff를 입력으로 받아 최소 수정만 한다. 원인을 먼저 진술하고, 검증을 재실행하며, 새 기능을 추가하지 않는다."
- [x] `integrations/codex/agents/aorch-fixer.toml` 신규 작성 — 기존 `aorch-worker.toml` 구조를 따르되 fixer 지시문 적용
- [x] `aorch-worker`/`aorch-reviewer`/`aorch-fixer` 6개 파일 전부에서 `model:`·`effort:` 줄 제거 — 모델은 dispatch가 스폰 시 주입한다
- [x] `integrations/claude/agents/aorch-scout.md`와 codex 대응본은 **변경하지 않는다** — scout는 위임 워커가 아니라 리드 도구로 잔류한다(결정 #7). 모델 고정도 유지
- [x] 검증: `node --test test/install.test.js` — 설치가 fixer 2종을 포함한 에이전트 파일 전부를 배치하고, worker/reviewer/fixer 파일에 `model:` 줄이 없으며, scout 파일에는 남아 있는지 확인

### 작업 5: `src/dispatch.js`와 `aorch dispatch` CLI

대상 파일: `src/dispatch.js`, `src/role-agent.js`(신규 — 역할 프리셋 해석을 task-runner에서 분리), `src/cli.js`, `src/providers/claude-cli.js`, `src/providers/codex-cli.js`, `src/task-runner.js`, `test/dispatch.test.js`, `test/providers.test.js`

> **범위 확장 (실행 중 발견)**: 계획 초안은 "route + roleAgents를 합쳐 실행 사양을 만든다"고만 적었으나, 실제로는 어댑터를 고쳐야 에이전트가 워커에 전달된다. 실측:
> - `claude 2.1.233`은 `--agent <agent>`를 지원하고, 프리셋의 `tools`/`disallowedTools` 같은 **하드 제약까지 적용**된다.
> - `codex exec`에는 에이전트 선택 옵션이 **없다**. `-p/--profile`은 `$CODEX_HOME/<name>.config.toml`을 얹는 것이라 `.codex/agents/*.toml`과 다른 메커니즘이다.
> - `src/providers/codex-cli.js`는 `.codex/agents/*.toml`을 아예 참조하지 않는다 — 설치되지만 exec 경로에서 쓰이지 않는 파일이었다.
>
> **결정**: claude는 `--agent`로 지정하고, codex는 프리셋 toml의 `developer_instructions`를 프롬프트에 주입한다. codex 쪽 도구 제한은 `sandbox_mode`까지만 가능하다는 한계를 수용한다.

- [x] `src/dispatch.js`에 `dispatchPlan({ plan, config, observations, cwd, dryRun })` 작성 — `validateTaskPlan` 통과 후 `tasks`를 선언 순서대로 순회
- [x] 각 task에 대해 `routingRoleFor(task.agentRole)`로 `role`을 채운 뒤 `selectRoute`에 넘긴다. 계획이 `role`을 직접 담고 있으면 거부한다(파생값을 손으로 덮어쓰지 못하게)
- [x] 선택된 route와 `config.roleAgents[task.agentRole][route.provider]`를 합쳐 실행 사양을 만든다. 매핑에 없는 provider면 그 task를 실패로 기록하고 계속 진행하지 않는다(fail closed)
- [x] `dryRun`이면 실행 없이 `[{ taskId, agentRole, agent, provider, model, effort }]`를 반환한다
- [x] `dryRun`이 아니면 각 task를 **`executeWithVerification`(`src/run-loop.js:50`)** 경로로 실행하고, 한 task가 실패하면 **뒤 task를 실행하지 않고** 지금까지의 결과와 실패 증거를 함께 반환한다
      *(정정: 계획 초안은 진입점을 `runTask`로 적었으나 그런 export는 없다. `src/task-runner.js`가 export하는 것은 `executeTask`이고, `src/cli.js`의 exec 분기가 실제로 호출하는 것은 그것을 감싼 `executeWithVerification`이다.)*
- [x] `src/cli.js`의 exec 분기가 쓰는 헬퍼 `applyActiveLimits`·`readObservations`·`resolveObservationPath`를 dispatch도 동일하게 재사용한다 — 한도 반영과 관측 경로 해석이 exec와 갈라지면 안 된다
- [x] `src/performance-store.js`는 **변경하지 않는다.** `agentRole`은 라우팅 입력일 뿐 성과 층화 키가 아니다(결정 #9). 관측에 기록되는 `role`은 파생된 `executor`/`reviewer`로 남고, 매칭 차원은 provider×model×effort×kind 4개를 유지한다
- [x] `COMMAND_FLAGS`에 `dispatch: [...COMMON_FLAGS, 'plan', 'observations', 'timeout-ms', 'dry-run']` 추가하고 `main()`에 분기 추가. help 텍스트에도 추가
- [x] `src/providers/claude-cli.js`의 `buildClaudeCommand`에 선택적 `agent` 인자를 추가하고, 주어지면 `--agent <name>`을 args에 넣는다. 없으면 현행과 동일한 args를 낸다(기존 호출자 무손상)
- [x] `src/providers/codex-cli.js`의 `buildCodexCommand`에 선택적 `agentInstructions` 인자를 추가하고, 주어지면 프롬프트 앞에 붙인다. 없으면 현행과 동일
- [x] `src/task-runner.js`의 `executeTask`가 `task.agentRole`과 `config.roleAgents`에서 (a) claude면 에이전트 이름, (b) codex면 프리셋 toml의 `developer_instructions`를 해석해 어댑터에 넘긴다. `agentRole`이 없는 task는 현행 동작 유지
- [x] codex 프리셋 toml 파싱은 `developer_instructions = """..."""` 블록만 추출하는 최소 구현으로 한다 — TOML 파서를 의존성으로 들이지 않는다(런타임 의존성 0 유지)
- [x] 검증: `node --test test/dispatch.test.js` — dry-run이 agentRole별로 다른 에이전트명을 내는지, 계획이 `role`을 직접 담으면 거부하는지, 매핑 없는 adapter에서 fail closed 하는지, 앞 task 실패 시 뒤 task가 실행되지 않는지
- [x] 검증: `node --test test/providers.test.js` — `agent` 없이 부르면 args가 기존과 동일하고, 주면 `--agent`가 붙는지. codex는 지시문 주입 유무가 프롬프트에 반영되는지

### 작업 6: 관측을 classify 경로에 연결

대상 파일: `src/cli.js`, `test/downshift-matrix.test.js`

`src/cli.js:258`의 classify는 `selectRoute({ ..., observations: [] })`로 관측을 하드코딩 비운다. 서브에이전트 게이트가 학습된 성과를 절대 쓰지 못하는 원인이다. 결정 #5(관측 누적 학습)의 전제 조건이다.

- [x] classify 분기에서 `route`/`exec`가 쓰는 것과 같은 방식으로 관측을 로드해 `selectRoute`에 전달하도록 수정
- [x] 관측 로드 실패는 fail-open으로 빈 배열 처리하고 stderr에 한 줄 경고 — classify는 서브에이전트 게이트를 떠받치므로 절대 차단하면 안 된다(기존 게이트 fail-open 원칙 유지)
- [x] 관측 파일이 클 때를 대비해 classify는 기존 quota 캐시와 같이 캐시 전용 경로만 쓰고 갱신 프로브를 돌리지 않는다
- [x] 검증: `node --test test/downshift-matrix.test.js` — 관측 0건일 때 기존 매트릭스(문서화된 6개 경계)가 그대로 유지되는지. 그리고 특정 kind에 실패 관측을 주입하면 그 kind의 route가 상위 모델로 이동하는 테스트를 신규 추가

### 작업 7: 다운시프트 기준을 1회 통과 확률로 전환

대상 파일: `config/aorch.config.json`, `src/difficulty.js`, `test/difficulty.test.js`, `test/downshift-matrix.test.js`

> **범위 축소 (실행 중 실측)**: 이 작업의 값 조정 항목 두 개를 보류한다. 근거:
> 1. **우선순위 플립 생략**: `standard`를 quality-first로 뒤집으면 implementation·testing이 관측과 무관하게 haiku→sonnet으로 무조건 올라간다(실측). 그러면 작업 6에서 만든 관측 메커니즘이 무의미해지고, 개정된 목적함수에 남아 있는 "구독 한도 절약"과 충돌한다. 결정의 문자("실패 이력 있는 kind는 처음부터 상위로")는 관측 배선이 이미 구현한다.
> 2. **prior 하향 보류**: `.aorch/observations.jsonl`의 실패 9건 중 **8건이 전부 단일 작업 `T-korean-signals`**(3회 반복 실행)이고, haiku부터 opus·sol/xhigh까지 사다리 전체가 같은 작업에서 실패했다. 이는 모델 무능이 아니라 그 작업 또는 그 `verificationCommands`의 결함을 가리킨다. 여기서 prior를 내리면 "opus는 구현을 못 한다"는 틀린 사실을 config에 박게 된다. **선결 조건: `T-korean-signals` 부검.**
>
> 남는 것은 의미 재정의(문서화)뿐이고, 실제 값 이동은 관측이 쌓이면 작업 6의 배선이 자동으로 수행한다.

- [x] `config/aorch.config.json`의 각 프로필 `quality.<kind>` 값의 의미를 "품질 바닥선 대비 점수"에서 **"해당 kind를 1회 시도로 통과시킬 확률"**로 재정의하고, 그 정의를 config 안의 `qualitySemantics` 필드로 명시
- [~] ~~실측 근거를 반영해 값을 조정한다~~ → **보류**. `T-korean-signals` 부검 후 별도 판단(위 근거 2)
- [~] ~~`PRIORITIES_BY_COMPLEXITY`의 `standard`를 quality-first로 변경~~ → **생략**. 관측 배선이 같은 목적을 이력 기반으로 달성(위 근거 1)
- [x] `FLOOR_BY_COMPLEXITY`의 세 값(0.72 / 0.80 / 0.88)은 **변경하지 않는다.** 통과확률 의미에서도 바닥선으로 타당하고, 이번 변경의 효과를 격리하려면 한 번에 한 축만 움직여야 한다. 값 조정은 관측이 쌓인 뒤 별도 판단한다 — 그 이유를 `src/difficulty.js` 주석에 한 줄 남긴다
- [x] 검증: `node --test test/difficulty.test.js && node --test test/downshift-matrix.test.js` — 문서화된 경계 표가 새 기준에서 어떻게 바뀌는지 테스트에 반영하고, "Implement the config parser"가 더 이상 haiku로 내려가지 않는 것을 회귀로 고정

### 작업 8: 루트 스킬을 분해–분배 흐름으로 개정

대상 파일: `integrations/claude/skills/adaptive-orchestrate/SKILL.md`, `integrations/codex/skills/adaptive-orchestrate/SKILL.md`, `test/install.test.js`

- [x] 두 SKILL.md의 "Task decomposition and routing" 절을 개정 — 5~6단계(개별 엔벨로프 작성 후 `aorch route`/`aorch exec` 반복)를 다음으로 대체: (a) 분해 결과를 `aorch decompose --print-schema`가 정의한 계획 형식으로 한 파일에 쓴다, (b) `aorch decompose --plan <file>`로 검증한다, (c) `aorch dispatch --plan <file>`로 실행한다
- [x] 각 서브태스크에 `agentRole`을 반드시 붙이라는 지시 추가. 정찰·조사는 위임하지 말고 리드가 직접 수행하라는 지시를 명시(결정 #7)
- [x] `role` 필드를 손으로 쓰지 말라는 지시 추가 — `agentRole`에서 파생된다
- [x] 단일 작업이 명백할 때는 `decomposed: false` + tasks 1개로 쓰라는 지시 추가 (불필요한 분해 억제)
- [x] 검증: `node --test test/install.test.js` — 설치된 스킬 본문에 `aorch dispatch`와 `agentRole`이 포함되고, 옛 지시(개별 엔벨로프 반복 호출)가 남아 있지 않은지 문자열 단언

### 작업 9: 목적함수 개정을 문서에 반영

대상 파일: `README.md`, `docs/DESIGN.md`, `CHANGELOG.md`

- [x] `README.md` 첫 문단의 "목적함수는 시간·구독 한도 절약"을 **"목적함수는 사용자 개입 최소화와 구독 한도 절약(품질 바닥선 유지)"**로 개정
- [x] `README.md`의 "작업을 대신 분해하지 않습니다" 문장을 개정 — 분해는 호스트 모델이 수행하되 aorch가 형식을 강제하고 분배까지 책임진다는 현재 구조로 다시 쓴다
- [x] `README.md`의 다운시프트 경계 표를 작업 7 이후의 실제 값으로 갱신한다
- [x] `docs/DESIGN.md`의 분해 관련 서술(7행, 53행, 76행)을 새 구조로 갱신
- [x] `docs/superpowers/specs/2026-07-24-aorch-v1-decompose-delegate-design.md` §9에 폐기 표시를 한 줄 추가 — "분해기 non-goal은 2026-08-16 계획에서 폐기됨(호스트 분해 + 스키마 강제 방식). 원 근거와 폐기 근거는 `docs/plans/2026-08-16-decompose-dispatch-pipeline.md` 참조." 원문은 지우지 않는다
- [x] `CHANGELOG.md`에 이번 변경 항목 추가
- [x] `package.json`의 `files`에 `docs/DESIGN.md`만 있고 `docs/plans/`는 없다 — 배포물에 계획 문서를 넣지 않는 현행 유지이므로 변경하지 않는다
- [x] 검증: `npm run check` 전체 통과. 그리고 `grep -n "시간·구독 한도" README.md`가 0건인지 확인

---

## 완료 조건

- [x] `npm run check` 전체 통과 — 258 테스트, 257 pass / 0 fail / 1 skip(symlink 권한, 기존 환경 제약)
- [x] `aorch decompose --print-schema | node -e "JSON.parse(require('fs').readFileSync(0))"`가 오류 없이 끝난다
- [x] 서브태스크 2개짜리 계획 파일로 `aorch dispatch --plan <file> --dry-run`을 실행하면 두 task가 서로 다른 에이전트로 배정된 결과가 출력된다
- [ ] 도그푸딩 1회: 실제 작업 하나를 이 파이프라인으로 끝까지 통과시키고 `.aorch/observations.jsonl`에 새 관측이 기록되는 것을 확인한다
