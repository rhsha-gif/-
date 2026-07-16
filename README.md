# Adaptive Orchestrator

Adaptive Orchestrator는 Claude Code 또는 Codex CLI에서 사용자의 실질적인 요청보다 먼저 작동하는 소형 제어 런타임입니다. 요청을 필요 이상으로 쪼개지 않으면서 독립 검증 가능한 작업으로 분해하고, 각 작업에 가장 적합한 조합을 선택합니다.

```text
provider
+ model
+ reasoning effort
+ skill / plugin / hook
+ permission / scope / isolation
+ verification / review
```

핵심 흐름은 다음과 같습니다.

```text
사용자 프롬프트
→ 얇은 UserPromptSubmit 정책 게이트
→ adaptive-orchestrate root skill
→ 의미 있는 작업 분해
→ 위험 정책과 capability 신뢰등급 적용
→ provider/model/effort/capability 선택
→ bounded worker 실행
→ 독립 verifier attestation
→ 필요한 독립 review
→ 결과 통합
→ 세션 회고와 승인형 개선 제안
```

## 제작 우선순위와 런타임 정책

TRIP, LazyCodex, autoresearch, SyMerge 등 참고 자료를 선별해 이 소스를 제작할 때의 우선순위는 다음과 같습니다.

```text
소스 결과물의 품질 >> 토큰 효율 > 제작 시간
```

이것은 **런타임 라우터가 모든 작업에 적용하는 하나의 전역 목적함수**가 아닙니다. 런타임은 각 작업의 성공 조건, 난이도, 실패 위험, capability 호환성, 최근 독립 검토 성과, 사용자가 명시한 예산·시간 제약을 먼저 고려합니다.

기본 선택 순서는 `quality → tokens → latency`이지만 task envelope에서 바꿀 수 있습니다. 품질 외 지표를 먼저 둘 때는 `minimumQuality`를 명시해야 합니다.

## v0.3.0에서 강화된 제어 경계

### 얇은 root gate

`UserPromptSubmit` hook은 모델 라우팅, inventory 검색, lessons 검색, 작업 분해를 하지 않습니다. 요청을 `read-only`, `development`, `high-risk`로 보수적으로 분류하고 최소 정책만 주입합니다. 보안·DB·금융 같은 주제를 설명하거나 분석해 달라는 read-only 요청은 mutation 요청으로 오인하지 않습니다. 무거운 오케스트레이션은 hook 바깥의 root skill이 수행합니다.

### risk-first 라우팅

라우터는 모델 점수부터 비교하지 않습니다. 먼저 risk에 따라 허용되는 provider 신뢰등급, adapter maturity, capability 신뢰등급, verification isolation을 제한하고, 그 안에서 model과 effort를 선택합니다.

### worker claim과 verifier evidence 분리

worker receipt는 완료 증명이 아니라 주장입니다. `aorch exec` 또는 `aorch verify`가 별도 verifier를 실행해 명령을 재실행하고, 실제 Git 변경과 scope를 비교하고, SHA-256 attestation을 발급해야 완료 근거가 됩니다. worker에게 공개하지 않는 `verifierCommands`도 사용할 수 있습니다.

### 확장 공급망 신뢰등급

provider와 capability에는 다음 등급을 둡니다.

```text
trusted
reviewed
untrusted
```

provider adapter에는 `stable` 또는 `experimental` maturity를 지정합니다. critical 실행은 trusted/stable 경로만 허용합니다. untrusted provider와 capability는 low-risk read-only 작업에서 각각 명시적으로 허용한 경우에만 선택할 수 있습니다.

### 복구 가능한 file-first state

데이터베이스나 daemon을 추가하지 않고 다음을 구현했습니다.

- atomic write: 임시 파일 → fsync → rename
- per-file lock과 live-PID-aware stale-lock 회수
- checksum과 sequence가 포함된 append-only JSONL
- partial JSONL tail 복구
- 잘못된 `active-run.json` pointer 탐지와 정리
- `aorch doctor --repair`

### advisory lessons와 증거 기반 progress

운영 lesson은 policy가 아닙니다. scope tag, evidence, confidence, expiry, source run이 있는 advisory record로만 저장됩니다. root hook은 lessons를 읽지 않으며, root skill이 blocking path 밖에서 관련 lesson만 조회합니다.

진행률은 estimated percentage와 함께 phase, confidence, blocker, evidence count, last evidence time을 표시합니다. percentage는 완료 증거가 아닙니다.

## 포함 범위

1. Claude Code와 Codex의 `UserPromptSubmit` thin gate
2. root `adaptive-orchestrate` skill
3. task-specific provider/model/effort router
4. 설치된 skill/plugin/hook exact-ID inventory
5. 시간 감쇠가 적용된 모델 성과 관측
6. 설정만으로 추가 가능한 모델과 generic provider
7. provider/capability trust policy
8. bounded worker와 strict receipt
9. 독립 verifier attestation과 hidden checks
10. durable run state와 evidence-aware progress
11. 종료 후 retrospective, 사용자 feedback, 승인형 improvement proposal
12. TTL과 evidence를 가진 advisory operational lessons
13. file-state health check와 repair

의도적으로 제외한 기능:

- 상시 daemon
- 외부 데이터베이스나 벡터 DB
- 웹 dashboard
- worker 내부 재귀 오케스트레이션
- 운영 중 control-plane 자기수정
- 동적 plugin 자동 설치
- 사용자 승인 없는 hook·skill·plugin·prompt·정책 변경
- 자동 push, merge, release, deployment
- 대규모 강화학습 라우터

## 요구사항

- Node.js 20 이상
- Claude Code CLI 또는 Codex CLI
- Git 저장소: read-only 작업에는 선택 사항이지만 write 작업의 변경 증명과 Git-worktree verifier에는 필수

각 provider CLI는 사전에 로그인되어 있어야 합니다. 이 패키지는 API key를 저장하거나 전달하지 않습니다. `aorch doctor`는 실행 파일과 로컬 catalog/state를 검사하지만, 계정별 모델 entitlement를 원격 호출 없이 검증했다고 주장하지 않습니다.

## 설치

소스에서 설치:

```bash
npm install
npm link
```

대상 프로젝트에 두 CLI 통합 설치:

```bash
aorch install --target both --project /path/to/project
```

한쪽만 설치:

```bash
aorch install --target claude --project /path/to/project
aorch install --target codex --project /path/to/project
```

설치 구조:

```text
project/
├─ .aorch/
│  ├─ config.json
│  └─ hooks/
│     ├─ gate.mjs
│     ├─ journal.mjs
│     ├─ user-prompt-submit.mjs
│     └─ session-review.mjs
├─ .claude/
│  ├─ settings.json
│  ├─ skills/
│  │  ├─ adaptive-orchestrate/SKILL.md
│  │  └─ post-run-reflection/SKILL.md
│  └─ agents/
├─ .agents/
│  └─ skills/
│     ├─ adaptive-orchestrate/SKILL.md
│     └─ post-run-reflection/SKILL.md
└─ .codex/
   ├─ hooks.json
   └─ agents/
```

기존 `CLAUDE.md`와 `AGENTS.md`는 자동 편집하지 않습니다. 기존 hook도 command 단위로 병합하며 재설치해도 중복 등록하지 않습니다. Codex project hook은 변경된 hook hash를 사용자가 `/hooks`에서 신뢰해야 실행될 수 있습니다.

설치 확인:

```bash
cd /path/to/project
aorch doctor
aorch inventory
```

상태 손상이 의심될 때:

```bash
aorch doctor --repair
```

## 평상시 사용

설치 후 Claude Code 또는 Codex CLI에 일반 요청을 입력합니다.

```text
주문 정정 기능을 구현해줘.
```

thin gate가 요청을 분류하고 root directive를 주입합니다. 호스트 모델은 `adaptive-orchestrate` skill에서 다음 절차를 수행합니다.

1. active run과 사용자 최종 목표 확인
2. blocking hook 밖에서 `aorch lessons --lint` 실행 및 관련 advisory lesson 조회
3. 독립 검증 가능한 작업으로만 분해
4. risk를 먼저 분류하고 isolation·trust·review 요구 결정
5. write 작업은 이미 격리된 경우가 아니라면 독립 worktree에서 실행. `aorch exec`도 이를 확인하며, low/standard in-place fallback은 task의 `allowInPlaceWrite: true`와 사용자 승인이 모두 있어야 함
6. `aorch inventory`로 실제 capability 확인
7. 작업별 task envelope 작성
8. `aorch route`로 provider/model/effort 선택
9. `aorch exec`로 bounded worker 실행
10. receipt를 claim으로 취급하고 verifier attestation·실제 diff·fresh output 검토
11. 위험도에 따라 독립 reviewer 추가; reviewer에는 executor rationale보다 requirements·invariants·actual diff·verifier artifacts를 먼저 제공
12. 검토된 route 결과를 `aorch record`로 기록
13. 전체 run 종료 후 `post-run-reflection` 수행

단순 read-only 요청은 durable run 없이 처리할 수 있습니다. 개발 또는 high-risk 작업은 durable run, 명시적 acceptance criteria, 제한된 scope, verification, post-run reflection을 사용합니다.

## 작업 경계

작업을 파일 수나 임의의 시간 단위로 잘게 나누지 않습니다.

```text
한 reviewer가 작업 A는 승인하고 작업 B는 거절할 수 있는가?
```

그렇다면 분리할 가치가 있습니다. setup, 작은 config, 테스트, 문서는 해당 deliverable과 함께 두는 편이 낫습니다. worker는 다른 worker를 만들 수 없으며 전체 task graph와 사용자 목표는 root orchestrator만 소유합니다.

## Run lifecycle

실질적인 작업은 durable run으로 관리합니다. 실행 중인 run이나 reflection이 끝나지 않은 terminal run이 있으면 이를 재개·종료·회고한 뒤 새 run을 만듭니다.

### 시작

```json
{
  "prompt": "주문 정정 기능을 구현해줘.",
  "runId": "order-amend-001",
  "tasks": [
    { "id": "T1", "weight": 1, "status": "pending" },
    { "id": "T2", "weight": 3, "status": "pending" }
  ]
}
```

```bash
aorch run --action start --input run-manifest.json
```

### 작업 상태 갱신

```bash
aorch run --action task \
  --run active \
  --task T1 \
  --status running \
  --fraction 0.4
```

### 종료

```bash
aorch run --action finish --run active --status completed
```

지원 terminal status:

```text
completed
partial
blocked
failed
cancelled
```

`finish` 직후에는 `reviewStatus: pending`입니다. retrospective가 저장되기 전에는 run이 완전히 닫힌 것으로 간주하지 않습니다.

## Progress

진행률은 task weight와 fraction으로 계산합니다.

\[
P=\frac{\sum_i w_i f_i}{\sum_i w_i}\times100
\]

```bash
aorch progress --run active
```

출력에는 다음이 포함됩니다.

```text
percent: estimated value
phase: planning | executing | verifying | partial | blocked | failed | complete
confidence: low | medium | high
blockers
evidenceCount
lastEvidenceAt
activeTaskIds
```

보고 시점은 분해 직후, 의미 있는 상태 변화, verification 진입, 동일 run이 지속될 때 최소 30분마다, 최종 종료입니다. blocker가 있으면 percentage 뒤에 숨기지 않습니다.

## Task routing

예시:

```bash
aorch route --task examples/task.json
```

route 출력:

- provider와 trust tier
- profile ID와 model slug
- reasoning effort
- adapter maturity
- 보수적 품질 추정치
- token/latency index
- task별 priority order와 hard constraints
- 단계별 candidate 수

Task envelope에서 선택적으로 지정할 수 있습니다.

```json
{
  "routingPriorities": ["latency", "quality", "tokens"],
  "minimumQuality": 0.85,
  "maxTokenIndex": 2.0,
  "maxLatencyIndex": 1.5
}
```

`routingPriorities`가 quality로 시작하지 않으면 `minimumQuality`가 필수입니다.

실행 전 확인:

```bash
aorch exec --task examples/task.json --dry-run
```

실행:

```bash
aorch exec --task examples/task.json
```

## Independent verification

Task의 두 verification 계층:

```json
{
  "verificationCommands": ["npm test"],
  "verifierCommands": ["npm run check"],
  "verificationIsolation": "git-worktree"
}
```

- `verificationCommands`: worker도 알고 실행할 수 있는 공개 검증
- `verifierCommands`: worker prompt에서 제외되는 verifier-only checks
- `verificationIsolation`: `same-workspace` 또는 `git-worktree`; 기본값은 low만 same-workspace이고 standard 이상은 git-worktree
- `allowInPlaceWrite`: low/standard write task에 한해 사용자가 명시적으로 현재 checkout 수정을 허용했음을 기록하는 예외 플래그. 기본값은 `false`이며 high/critical에서는 무시하고 fail closed

worker receipt를 수동 검증할 수도 있습니다.

```bash
aorch verify \
  --task task.json \
  --receipt receipt.json \
  --isolation git-worktree
```

수동 `aorch verify`는 검증 명령을 재실행해 read-only claim을 attestation으로 남깁니다. write task의 변경 증거(before/after workspace snapshot)는 `aorch exec` 실행 중에만 캡처되므로, write claim의 attestation은 `aorch exec` 흐름에서 발급됩니다. 수동 verify에 write task를 넘기면 fail closed로 거절됩니다.

verifier는 별도 attestation artifact를 저장합니다. 검증 실패도 attestation으로 남겨 worker의 허위 완료 주장을 추적할 수 있습니다. 완료된 write claim은 Git 변경 증거가 없으면 거절되며, bounded worker가 commit·reset 등으로 `HEAD`를 바꾸는 것도 차단됩니다. 실제 worker 실행도 linked worktree 여부를 확인합니다. low/standard 작업만 명시적 사용자 승인과 `allowInPlaceWrite: true`가 있을 때 현재 checkout에서 실행할 수 있고, high/critical write는 항상 linked worktree를 요구합니다.

## 동적으로 변하는 모델 성능

모델 능력을 고정 상수로 취급하지 않습니다. 관측치는 다음 단위로 분리합니다.

```text
provider × profileId × model × effort × taskKind × role × risk × complexity
```

최근 독립 검토 결과는 크게, 오래된 결과는 작게 반영합니다.

\[
w_i=2^{-a_i/h}
\]

- \(a_i\): 관측 후 경과 일수
- \(h\): 반감기, 기본 30일

```bash
aorch record --input examples/review-observation.json
```

worker의 자기평가가 아니라 독립 reviewer/verifier 결과를 기록해야 합니다. risk와 complexity가 다른 관측치는 서로의 성능 근거로 섞지 않습니다. 새 모델은 challenger로 시작할 수 있지만 critical executor는 trusted/stable provider의 stable model만 허용합니다.

## 새 model과 provider

model/provider는 config data입니다. 라우터 코드에 model slug를 흩어놓지 않습니다.

```json
{
  "id": "new-model-profile",
  "provider": "new-provider",
  "model": "new-model-slug",
  "enabled": true,
  "roles": ["executor", "reviewer"],
  "taskKinds": ["implementation", "debugging", "review"],
  "quality": { "default": 0.82 },
  "tokenIndex": 1,
  "latencyIndex": 1,
  "maturity": "challenger",
  "efforts": [
    {
      "name": "high",
      "qualityDelta": 0.02,
      "tokenMultiplier": 1.2,
      "latencyMultiplier": 1.2,
      "complexities": ["standard", "high"]
    }
  ]
}
```

stdin으로 prompt를 받고 stdout으로 JSON receipt를 반환하는 CLI는 generic provider로 추가할 수 있습니다.

```json
{
  "id": "new-provider",
  "adapter": "generic",
  "enabled": true,
  "executable": "new-provider-cli",
  "args": ["run", "--model", "{model}", "--effort", "{effort}", "-"],
  "trustTier": "untrusted",
  "adapterMaturity": "experimental"
}
```

새 adapter는 low-risk canary와 contract test를 통과한 뒤 trust/maturity를 올리는 것이 원칙입니다. critical 실행은 experimental adapter를 사용하지 않습니다.

## Skill, plugin, hook 선택

```bash
aorch inventory
```

검색 위치:

```text
project/.claude/skills/*/SKILL.md
project/.agents/skills/*/SKILL.md
~/.claude/skills/*/SKILL.md
~/.agents/skills/*/SKILL.md
provider/plugin manifests
```

호스트 모델은 inventory에 실제 존재하는 exact ID만 task에 넣습니다. skill과 plugin처럼 서로 다른 capability type이 같은 ID를 사용하면 shadowing을 허용하지 않고 ambiguous ID로 fail closed합니다. capability description은 instruction이 아닌 bounded metadata로 표시되며, untrusted description은 inventory 출력에서 숨깁니다. project-local discovery는 기본 `reviewed`, user-global discovery는 기본 `untrusted`로 취급하며 config가 명시한 trust를 자동 승격하지 않습니다.

기본 상한:

```text
skills  ≤ 3
plugins ≤ 2
hooks   ≤ 3
```

critical 작업은 trusted capability와 trusted/stable provider만 사용합니다. untrusted provider는 `allowUntrustedProviders: true`, untrusted capability는 `allowUntrustedCapabilities: true`인 low-risk read-only task에서만 사용할 수 있습니다.

## Post-run self-feedback

terminal run이 끝나면 `post-run-reflection` skill이 다음을 분석합니다.

- 실제 오류와 증거
- route 변경과 retry
- 과도하거나 부족한 context와 agent 호출
- 잘못된 task boundary
- verification 누락 또는 과잉
- 이번 run이 만든 기술부채
- 기존 범위 밖 기술부채
- 사용자 사후 feedback

```bash
aorch run --action reflect \
  --run active \
  --input examples/retrospective.json
```

오류에서 lesson을 만들려면 최소한 다음이 필요합니다.

```text
description
prevention
scope tags
verified evidence
confidence
source run
```

lesson은 90일 기본 TTL을 가진 advisory record이며 `promotedToPolicy`는 항상 false입니다. root hook은 lesson을 읽지 않습니다. root skill이 blocking path 밖에서 다음 명령으로 검증하고 관련 항목만 조회합니다.

```bash
aorch lessons --lint
aorch lessons --query "verification test path" --limit 5
```

만료되거나 evidence/scope가 없는 lesson은 조회에서 제외됩니다.

Claude Code에서는 `Stop` hook이 terminal run의 retrospective 누락을 한 번 더 알립니다. `SessionEnd`는 종료를 막지 않고 누락 사실을 checksum journal에 기록합니다. Codex의 `Stop` hook도 같은 gate를 담당합니다.

## 사용자 feedback

```json
{
  "rating": 4,
  "comment": "결과는 맞지만 검토 범위가 지나치게 넓었다."
}
```

```bash
aorch run --action feedback \
  --run <run-id> \
  --input feedback.json
```

사용자 feedback이 새 오류나 비효율을 드러내면 retrospective를 개정합니다. 기존 feedback과 proposal decision은 revision 사이에서 보존됩니다.

## 승인형 하네스 개선

회고는 source나 policy를 직접 수정하지 않습니다. improvement proposal은 다음 경계를 갖습니다.

```text
status: pending
requiresUserApproval: true
applied: false
```

```bash
aorch run --action decide \
  --run <run-id> \
  --proposal P1 \
  --decision approved \
  --comment "별도 bounded run에서 적용"
```

승인은 동의만 기록합니다. 실제 변경은 별도 run에서 테스트·review·verification을 거쳐 구현합니다. router, verifier, permissions, hooks, skills, provider adapters를 운영 작업 중 자동 수정하지 않습니다.

## 기술부채 정책

- **현재 run이 만든 부채:** 종료 전에 해결하고 resolution evidence를 남깁니다.
- **기존 범위 밖 부채:** 현재 작업을 확장하지 않고 proposal로 기록합니다.
- **하네스 부채:** 사용자 승인 후 별도 run에서 처리합니다.

## 명령 요약

```text
aorch route
aorch exec
aorch verify
aorch record
aorch inventory
aorch progress
aorch lessons [--lint]
aorch run
aorch install
aorch doctor [--repair]
```

`aorch run` actions:

```text
start
task
finish
show
reflect
feedback
decide
```

## 프로젝트 상태 파일

```text
.aorch/
├─ active-run.json
├─ config.json
├─ observations.jsonl
├─ hooks/
├─ runs/
│  └─ <run-id>/run.json
├─ task-runs/
│  └─ <task-run>/<task-id>/
│     ├─ receipt.json
│     ├─ execution.json
│     ├─ verification-latest.json
│     └─ verifier/<verification-id>/
│        ├─ attestation.json
│        └─ *.stdout.log / *.stderr.log
└─ learning/
   ├─ retrospectives/<run-id>.json
   ├─ lessons.json
   └─ unreviewed-sessions.jsonl
```

JSON files are written atomically. JSONL journals use a live-owner-aware lock, monotonically increasing sequence, and checksum envelope. `aorch doctor --repair` can remove abandoned stale locks, truncate invalid journal tails, and clear an invalid active-run pointer. 별도 service나 DB는 필요하지 않습니다.

## 안전 경계

다음은 명시적 사용자 승인 없이 실행하지 않습니다.

- push, merge, tag, release
- production deployment
- destructive migration
- 실제 금융 주문
- risk limit 완화
- 외부 메시지 전송
- 하네스 source/policy 자동 변경

hook은 workflow policy를 주입하는 guardrail이지 운영체제 수준의 sandbox가 아닙니다. 실제 위험 작업은 provider permission, trusted capability, scope, worktree, network policy, independent verifier, human approval을 함께 사용해 통제해야 합니다.
