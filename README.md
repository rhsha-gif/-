# Adaptive Orchestrator

> **판단 코어 릴리스** — 개인용 두 구독(Claude Code + Codex CLI) 도구에 과했던 부분을 두 차례에 걸쳐 걷어냈습니다.
>
> - 1차: worker 불신용 SHA-256 attestation·hidden verifier, 공급망 trust tier(trusted/reviewed/untrusted), 데이터 없는 학습 시스템(retrospective·lessons·proposal), 체크섬 JSONL·`doctor --repair` 같은 과잉 내구성·운영 기계
> - 2차: verifier 완료 게이트, receipt 검증, weighted progress, durable run state, doctor, file-store journal 평면 전체
>
> 남은 것은 **난이도→등급 라우팅 판단**과 그 판단을 실행하는 **얇은 디스패치**입니다. 삭제 내역은 [`CHANGELOG.md`](CHANGELOG.md), 아직 구현되지 않은 것은 [아직 없는 것 (로드맵)](#아직-없는-것-로드맵)을 보세요.

Adaptive Orchestrator는 Claude Code 또는 Codex CLI 아래에서 동작하는 소형 라우팅 런타임입니다. **작업을 대신 분해하지 않습니다.** 분해는 호스트 모델(리드)이 자기 네이티브 능력으로 하고, aorch는 그렇게 나온 각 작업에 대해 다음 조합을 판단합니다.

```text
provider
+ model
+ reasoning effort
+ skill / plugin / hook
+ permission / scope / isolation
```

핵심 흐름은 다음과 같습니다.

```text
사용자 프롬프트
→ 얇은 UserPromptSubmit 정책 게이트
→ adaptive-orchestrate root skill (호스트 모델이 분해)
→ 위험 정책 적용
→ provider/model/effort/capability 선택   (aorch route)
→ bounded worker 실행                     (aorch exec)
→ 호스트 모델이 실제 diff와 테스트로 결과 검토
→ 결과 통합
```

## 제작 우선순위와 런타임 정책

TRIP, LazyCodex, autoresearch, SyMerge 등 참고 자료를 선별해 이 소스를 제작할 때의 우선순위는 다음과 같습니다.

```text
소스 결과물의 품질 >> 토큰 효율 > 제작 시간
```

이것은 **런타임 라우터가 모든 작업에 적용하는 하나의 전역 목적함수**가 아닙니다. 런타임은 각 작업의 성공 조건, 난이도, 실패 위험, capability 호환성, 최근 독립 검토 성과, 사용자가 명시한 예산·시간 제약을 먼저 고려합니다.

기본 선택 순서는 `quality → tokens → latency`이지만 task envelope의 `routingPriorities`로 바꿀 수 있습니다. 품질 외 지표를 먼저 둘 때는 `minimumQuality`를 명시해야 합니다 — 바닥선 없이 싼 쪽으로 기울이는 것은 거부합니다.

## 제어 경계

### 얇은 root gate

`UserPromptSubmit` hook은 모델 라우팅, inventory 검색, 작업 분해를 하지 않습니다. 요청을 `read-only`, `development`, `high-risk`로 보수적으로 분류하고 최소 정책만 주입합니다. 보안·DB·금융 같은 주제를 설명하거나 분석해 달라는 read-only 요청은 mutation 요청으로 오인하지 않습니다. 무거운 오케스트레이션은 hook 바깥의 root skill이 수행합니다.

### risk-first 라우팅

라우터는 모델 점수부터 비교하지 않습니다. 먼저 risk에 따라 허용되는 adapter maturity를 제한하고(experimental adapter는 `experimentalAdapterMaxRisk` 이하 risk에서만), critical 작업에서는 challenger 모델을 후보에서 제외합니다 — reviewer 역할이면서 `criticalMinimumSamples` 이상의 실효 표본을 가진 경우에만 남습니다. 그렇게 좁혀진 후보 안에서 model과 effort를 선택합니다. write isolation은 라우터가 아니라 실행 단계(`aorch exec`)가 강제합니다.

### worker claim — 현재는 강제되지 않는다

worker receipt는 완료 증명이 아니라 주장입니다. **현재 `aorch exec`는 receipt를 파싱해 그대로 반환할 뿐, 검증 명령을 실행하지 않습니다.** task의 `verificationCommands`는 워커 프롬프트에 요구사항으로 전달되지만 강제되지 않으며, claimed diff와 actual diff를 대조하는 가드도 없습니다. 완료 판단은 전적으로 호스트 모델(리드)의 몫입니다 — receipt를 그대로 믿지 말고 실제 diff와 테스트 결과를 직접 확인하세요.

SHA-256 attestation, 숨은 verifier 명령, sterile worktree 재실행 격리는 워커를 불신하는 분산형 도구의 장치였고 개인 도구에는 과해 제거했습니다. 그것을 대체할 **테스트 실행 게이트**는 아직 구현되지 않았습니다([아직 없는 것](#아직-없는-것-로드맵)).

### 실제로 강제되는 안전 불변식: write isolation

문서가 아니라 코드가 지키는 유일한 실행 시점 불변식입니다. `aorch exec`는 write task의 워커를 띄우기 전에 다음을 확인하고, 통과하지 못하면 실행하지 않고 실패합니다(fail closed).

- write task는 Git 저장소 안에서만 실행할 수 있습니다.
- `high`/`critical` risk write는 **항상** 독립 linked worktree를 요구합니다. 예외 없음.
- `low`/`standard` write가 현재 checkout을 직접 수정하려면 task에 `allowInPlaceWrite: true`가 명시돼 있어야 합니다. 기본값은 거부.

blast-radius 통제이지 worker 불신이 아닙니다.

### file-first state

데이터베이스나 daemon을 추가하지 않고 다음을 구현했습니다.

- config·settings의 atomic write: 임시 파일 → rename
- append-only plain JSONL 관측 기록

## 포함 범위

1. Claude Code와 Codex의 `UserPromptSubmit` thin gate
2. root `adaptive-orchestrate` skill
3. task-specific provider/model/effort router
4. 설치된 skill/plugin/hook exact-ID inventory
5. 시간 감쇠가 적용된 모델 성과 관측(provider·model·effort·taskKind 4차원)
6. 설정만으로 추가 가능한 모델과 generic provider
7. bounded worker 디스패치와 receipt 스키마 전달(구조화 출력 강제는 provider CLI에 위임)
8. write isolation 불변식

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
- 자동 작업 분해 (호스트 모델의 네이티브 분해에 올라탐)

## 아직 없는 것 (로드맵)

제거했지만 되돌릴 의도가 있는 것들입니다. 문서가 실제보다 강한 보증을 주장하지 않도록 여기에 분리해 둡니다.

- **테스트 실행 완료 게이트** — "테스트를 돌려라, LLM에게 묻지 마라." task가 선언한 `verificationCommands`를 워크스페이스에서 실제로 실행하고 하나라도 실패하면 완료를 거절하는 게이트. 조사한 어떤 라우터도 verify를 테스트 실행으로 하지 않기 때문에 이 프로젝트의 차별점으로 남겨 둔 항목입니다.
- **claimed diff vs actual diff 대조** — worker가 주장한 변경 파일이 실제 Git diff와 일치하는지, read-only 작업이 파일을 건드리지 않았는지, bounded worker가 `HEAD`를 바꾸지 않았는지 확인하는 값싼 변경 가드.
- **receipt 영속화** — 현재 워커 프롬프트는 wrapper가 receipt를 `.aorch/task-runs/.../receipt.json`에 저장한다고 안내하지만 실제로 저장하지 않습니다. Codex adapter만 `worker-output.json`을 남깁니다.
- **run lifecycle과 진행률** — durable run state, weighted progress, `Stop` hook의 미완료 run 차단. `Stop` hook은 아직 `.aorch/active-run.json`을 읽지만 그 포인터를 쓰는 코드가 없어 사실상 항상 통과합니다. 프루닝 이전 설치에서 넘어온 stale 포인터가 남아 있다면 세션 종료를 풀 명령이 없으니 그 파일을 지우세요.
- **Codex 위임과 크로스 fallback** — 현재 라우팅은 Claude 티어 사이에서만 실측·검증됐습니다.

## 요구사항

- Node.js 20 이상
- Claude Code CLI 또는 Codex CLI
- Git 저장소: read-only 작업에는 선택 사항이지만 write 작업의 격리 worktree에는 필수

각 provider CLI는 사전에 로그인되어 있어야 합니다. 이 패키지는 API key를 저장하거나 전달하지 않습니다. `aorch inventory`는 로컬 catalog와 설치된 capability를 보여주지만, 계정별 모델 entitlement를 원격 호출 없이 검증했다고 주장하지 않습니다.

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
│  ├─ schemas/
│  └─ hooks/
│     ├─ gate.mjs
│     ├─ user-prompt-submit.mjs
│     └─ session-review.mjs
├─ .claude/
│  ├─ settings.json
│  ├─ skills/
│  │  └─ adaptive-orchestrate/SKILL.md
│  └─ agents/
├─ .agents/
│  └─ skills/
│     └─ adaptive-orchestrate/SKILL.md
└─ .codex/
   ├─ hooks.json
   └─ agents/
```

기존 `CLAUDE.md`와 `AGENTS.md`는 자동 편집하지 않습니다. 기존 hook도 command 단위로 병합하며 재설치해도 중복 등록하지 않습니다. `.aorch/config.json`은 이미 있으면 덮어쓰지 않습니다(`--force-config`로 강제). Codex project hook은 변경된 hook hash를 사용자가 `/hooks`에서 신뢰해야 실행될 수 있습니다.

설치 확인:

```bash
cd /path/to/project
aorch inventory
```

## 평상시 사용

설치 후 Claude Code 또는 Codex CLI에 일반 요청을 입력합니다.

```text
주문 정정 기능을 구현해줘.
```

thin gate가 요청을 분류하고 root directive를 주입합니다. 호스트 모델은 `adaptive-orchestrate` skill에서 다음 절차를 수행합니다.

1. 독립 검증 가능한 작업으로만 분해
2. risk를 먼저 분류하고 isolation·review 요구 결정
3. write 작업은 이미 격리된 경우가 아니라면 독립 worktree에서 실행. `aorch exec`도 이를 강제하며, low/standard in-place fallback은 task의 `allowInPlaceWrite: true`와 사용자 승인이 모두 있어야 함
4. `aorch inventory`로 실제 capability 확인
5. 작업별 task envelope 작성
6. `aorch route`로 provider/model/effort 선택
7. `aorch exec`로 bounded worker 실행
8. receipt를 claim으로 취급하고 **직접** 실제 diff를 확인하고 테스트를 실행 (aorch는 아직 이를 대신 해 주지 않음)
9. 위험도에 따라 독립 reviewer 추가; reviewer에는 executor rationale보다 requirements·invariants·actual diff를 먼저 제공
10. 검토된 route 결과를 `aorch record`로 기록

## 작업 경계

작업을 파일 수나 임의의 시간 단위로 잘게 나누지 않습니다.

```text
한 reviewer가 작업 A는 승인하고 작업 B는 거절할 수 있는가?
```

그렇다면 분리할 가치가 있습니다. setup, 작은 config, 테스트, 문서는 해당 deliverable과 함께 두는 편이 낫습니다. worker는 다른 worker를 만들 수 없으며 전체 task graph와 사용자 목표는 root orchestrator만 소유합니다.

## Task routing

예시:

```bash
aorch route --task examples/task.json
```

route 출력:

- provider
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

`--dry-run`은 워커를 띄우지 않고 선택된 route, capability, 실제 실행될 command spec을 보여줍니다. 워커를 띄우지 않으므로 write isolation 검사도 이 시점에는 하지 않습니다.

실행:

```bash
aorch exec --task examples/task.json
```

기본 watchdog timeout은 1시간입니다. `--timeout-ms`로 바꾸고 `--timeout-ms 0`으로 끕니다.

## Task envelope 필드

```json
{
  "verificationCommands": ["npm test"],
  "allowInPlaceWrite": false
}
```

- `verificationCommands`: 워커에게 전달되는 검증/테스트 요구사항. `critical` risk task는 이 값이 비어 있으면 validation 단계에서 거부합니다(fail closed). **현재 aorch는 이 명령을 직접 실행하지 않습니다** — 호스트 모델이 실행해야 합니다.
- `allowInPlaceWrite`: low/standard write task에 한해 사용자가 명시적으로 현재 checkout 수정을 허용했음을 기록하는 예외 플래그. 기본값은 `false`이며 high/critical에서는 무시하고 fail closed

## 동적으로 변하는 모델 성능

모델 능력을 고정 상수로 취급하지 않습니다. 관측치는 다음 단위로 분리합니다.

```text
provider × model × effort × taskKind
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

worker의 자기평가가 아니라 독립 reviewer 결과를 기록해야 합니다. 관측치는 provider·model·effort·taskKind 4차원으로 매칭합니다(솔로 볼륨에서 셀이 실제로 차도록 축소). 새 모델은 challenger로 시작할 수 있으며, 검증되지 않은 challenger를 critical 작업의 단독 executor로 쓰지 않습니다.

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
  "adapterMaturity": "experimental"
}
```

새 adapter는 low-risk canary와 contract test를 통과한 뒤 maturity를 올리는 것이 원칙입니다. critical 실행은 experimental adapter를 사용하지 않습니다.

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

호스트 모델은 inventory에 실제 존재하는 exact ID만 task에 넣습니다. skill과 plugin처럼 서로 다른 capability type이 같은 ID를 사용하면 shadowing을 허용하지 않고 ambiguous ID로 fail closed합니다. capability description은 instruction이 아닌 bounded metadata로 표시됩니다.

기본 상한:

```text
skills  ≤ 3
plugins ≤ 2
hooks   ≤ 3
```

## 기술부채 정책

- **현재 작업이 만든 부채:** 종료 전에 해결하고 resolution evidence를 남깁니다.
- **기존 범위 밖 부채:** 현재 작업을 확장하지 않고 사용자에게 보고합니다.
- **하네스 부채:** 사용자 승인 후 별도 작업에서 처리합니다.

## 명령 요약

```text
aorch route      task JSON에 대한 provider/model/effort 선택
aorch exec       route 후 bounded worker 하나를 디스패치 (--dry-run 지원)
aorch record     독립 검토된 model-performance 관측 추가
aorch inventory  설정된 provider·model·skill·plugin·hook 출력
aorch install    프로젝트 로컬 Claude Code / Codex 통합 설치
```

## 프로젝트 상태 파일

```text
.aorch/
├─ config.json
├─ observations.jsonl
├─ schemas/
├─ hooks/
└─ task-runs/
   └─ <run-id>/<task-id>/
      └─ worker-output.json   (Codex adapter만)
```

JSON 파일은 atomic하게 씁니다(임시 파일 → rename). 관측 기록은 plain append-only JSONL입니다. 별도 service나 DB는 필요하지 않습니다.

## 안전 경계

다음은 명시적 사용자 승인 없이 실행하지 않습니다.

- push, merge, tag, release
- production deployment
- destructive migration
- 실제 금융 주문
- risk limit 완화
- 외부 메시지 전송
- 하네스 source/policy 자동 변경

hook은 workflow policy를 주입하는 guardrail이지 운영체제 수준의 sandbox가 아닙니다. 실제 위험 작업은 provider permission, scope, worktree, network policy, 사람의 검토를 함께 사용해 통제해야 합니다. **aorch가 코드로 강제하는 것은 write isolation 하나뿐**이라는 점을 전제로 두세요.
