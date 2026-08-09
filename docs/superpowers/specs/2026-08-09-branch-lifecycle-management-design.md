# 브랜치 수명주기 관리 설계 (2026-08-09, 인터뷰 확정)

기준선: `codexss`@`bd701bf`. 규율 = 얕게(신규 의존성 0, 데몬/폴링 0). aorch의 기존 자산(`runGit`, `src/verify.js`, worktree 격리)을 재사용한다.

## 문제

사용자의 실제 고충: **"어느 브랜치에서 작업을 시작해야 할지 결정하는 과정이 스트레스"** (이 저장소만 해도 미완료 브랜치 7개). 부차적으로 시작/닫기/머지 시점 판단이 어렵다. 조언에 그치지 말고, **한 번의 딸깍 승인으로 계획 전체가 실행**되기를 원한다.

## 성공 기준

1. 새 코드 작업을 시작할 때, 위험·애매한 상황이면 aorch가 브랜치 상황을 정리·판단하고 호스트가 "이렇게 하죠" 카드를 자동으로 띄운다.
2. 사용자가 한 번 승인하면 표시된 계획(정리→분기→복원, 또는 verify→머지→push→정리)이 재확인 없이 끝까지 실행된다.
3. push/merge/삭제는 승인 없이 자율 실행되지 않는다(경계 준수). 미푸시 작업 소실 위험이 있는 미머지 브랜치 삭제는 별도 확인 게이트를 통과해야 한다.

## 역할 분담 (aorch 철학: 판단은 호스트, 기계적 실행·사실은 aorch)

| 유닛 | 책임 | 종류 |
|---|---|---|
| `aorch branch status` | 기계적 git 사실 + 정리 후보 + 위치 위험 감지 + main 대상 + 마지막 verify 결과를 JSON으로 반환 | 읽기 전용 |
| 호스트(리드 모델) | 프롬프트 주제 ↔ 브랜치 이름/커밋을 **의미로 매칭**해 이어갈지/새로 팔지 판정, 사람용 제안 카드 구성 | 판단 |
| `aorch branch apply --action <start\|finish\|cleanup\|sync> --approved` | 정해진 계획을 기계적으로 실행. `--approved` 없으면 계획만 출력하고 거부 | 가드형 쓰기 |

의미 매칭을 aorch 휴리스틱이 아니라 호스트가 맡는 이유: aorch는 원래 분해·판단을 호스트에 위임하고 자신은 "무엇을 어떤 등급으로/어떻게 실행"만 답한다. 브랜치 의미 매칭은 그 판단 축에 속한다.

## `aorch branch status` 출력 (계약)

```jsonc
{
  "currentBranch": "codexss",
  "mainBranch": "claude/project-critical-review-vtl77d",   // origin/HEAD 자동감지, config.mainBranch 오버라이드, 애매하면 needsConfirmation
  "mainBranchConfident": true,
  "workingTreeClean": false,
  "positionRisk": "on-main" | "detached" | null,   // mechanical only; "is this branch foreign to the task" is the host's semantic call, not a status value
  "branches": [
    { "name": "docs-realign", "ahead": 3, "behind": 12, "lastCommitDaysAgo": 41,
      "mergedIntoMain": false, "hasRemote": true, "lastSubject": "Realign README..." }
  ],
  "cleanupCandidates": {
    "mergedLocal": ["receipt-persist"],          // 자동 삭제 대상
    "unmergedStale": ["aorch-v1"]                // 30일+ 미머지 — 별도 확인 필요
  },
  "lastVerify": { "passed": true, "runId": "...", "head": "..." } | null,
  "repoIntegration": "pr" | "direct",            // gh+원격+PR관행이면 pr, 개인/무원격이면 direct
  "recommendedAction": "start" | "finish" | "cleanup" | "sync" | "none"
}
```

`branch status`는 순수 읽기(git rev-parse, for-each-ref, merge-base, status, log)만 수행한다. 파괴적 동작 0.

## 능동적 시작 흐름 (트리거 = 위험·애매할 때만)

루트 스킬(adaptive-orchestrate)이 프롬프트를 분해할 때, 다음이 모두 참이면 시작 카드를 띄운다(그 외에는 조용히 넘어감 — 덜 귀찮게):

- 프롬프트가 쓰기/코드 작업(implementation/testing/refactor/문서-쓰기)으로 분류되고,
- `positionRisk != null`(main 위/남의 브랜치/detached) **또는** working tree dirty **또는** 주제가 현재 브랜치와 안 맞음.

훅이 아니라 **루트 스킬 흐름**에서 수행한다(thin-gate 유지). 카드 순서:

1. **정리 먼저**: 선택지를 줄이기 위해 `cleanupCandidates`를 먼저 제시.
2. **시작 추천**: 호스트가 주제 매칭으로 "기존 `feat/x` 이어가기" 또는 "새 작업 → main 최신에서 `feat/<슬러그>` 분기"를 근거와 함께 제안.
3. **위치 위험 경고**: main/남의 브랜치 위에서 쓰려 하면 분기 먼저 하도록 경고.

## `apply --action start` (한 딸깍 = 전체 실행)

단일 폴더 브랜치 전환 모델. 계획:

1. working tree dirty면 **자동 stash**(메시지에 출처 브랜치 기록).
2. 이어가기: 대상 브랜치 checkout. / 신규: `git switch main && git pull --ff-only` 후 `feat/<슬러그>` 생성·checkout. 슬러그 = 종류 접두사(feat/fix/docs/test/) + 목표 슬러그; 불명확·충돌 시 호스트가 이름 확인.
3. stash가 있었으면 새 브랜치에서 `stash pop`. **충돌 시 정지**하고 증거와 함께 사람에게 반환.

`start`는 스스로 브랜치를 삭제하지 않는다(단일 책임). 시작 카드가 정리를 함께 제안한 경우, 한 번의 승인이 `apply --cleanup --approved` 다음 `apply --start --approved`를 **연쇄 실행**한다 — 각 action은 단일 목적을 유지하고, "한 딸깍 = 전체 계획"은 호스트가 계획을 조립해 달성한다.

## `apply --action finish` (한 딸깍 = 전체 실행)

전제: working tree clean, 브랜치가 main보다 ahead. 계획:

1. **verify 재실행**(작업의 `verificationCommands`, `src/verify.js` 재사용) — 녹색 아니면 중단하고 증거 반환. 머지 게이트.
2. main 대상 확정(애매하면 status의 needsConfirmation로 호스트가 확인).
3. `repoIntegration=="pr"`면 `gh pr create`(gh 없으면 status가 미리 알리고 direct 권장). `direct`면 main으로 **merge 커밋**(`--no-ff`) 후 `git push`.
4. main으로 복귀 후 **머지된 브랜치 삭제**.
5. **되돌리기용 pre-merge main SHA를 기록**(자동 롤백은 안 함, undo 명령을 보고).

## `apply --action cleanup`

- `mergedLocal` 자동 삭제 + `git remote prune`(사라진 원격추적 ref 정리).
- `unmergedStale`(마지막 커밋 30일+; `config.branch.staleDays` 조정)은 **한-딸깍 계획에 포함하지 않는다**. 미푸시 작업 소실이 비가역이라 **별도의 명시 확인 게이트**를 통과해야 삭제. 이는 "push/merge/삭제는 승인 뒤에만"이라는 경계의 자연스러운 강화.

## `apply --action sync`

- main의 변경분을 현재 브랜치에 **merge**로 반영(rebase는 후속 옵션). 충돌 시 정지·반환.

## 안전 경계

- `--approved`가 경계가 요구하는 명시 승인이다. 호스트는 사용자의 딸깍 **뒤에만** 이 플래그를 붙인다.
- 한 번의 승인이 표시된 계획 전체(정리 삭제·push·merge 포함)를 실행하되, **그 계획은 딸깍 전에 목록으로 보여준다**. "무인 루프"가 아니라 "한 번 보고 한 번 승인 → 전부 실행".
- 미머지 브랜치 삭제만 예외적으로 별도 확인.
- 훅에 넣지 않는다(자율 변형 루프 금지, thin-gate 유지).
- 실행 시점에 전제조건을 재확인(finish의 verify, tree clean, main 최신) — status 시점과 실행 시점 사이 드리프트 방지.

## 설정 (config.branch, 전부 선택)

```jsonc
"branch": {
  "mainBranch": null,              // null이면 origin/HEAD 자동감지
  "namePrefix": true,              // feat/fix/docs/test 접두사
  "staleDays": 30,
  "integration": "auto"            // auto | pr | direct
}
```

## 테스트 (임시 git 저장소 + 로컬 bare 원격, change-guard.test.js 방식)

- `status`: ahead/behind·merged·clean·positionRisk·cleanupCandidates·mainBranch 감지 정확성.
- `apply`가 `--approved` 없으면 실행 거부(계획만 출력).
- `start`: dirty에서 자동 stash→분기→pop 왕복; 신규는 main pull 후 접두사+슬러그 생성.
- `finish`: verify 녹색 아니면 중단; 녹색이면 direct 경로로 bare 원격에 merge 커밋+push+머지 브랜치 삭제+main 복귀; pre-merge SHA 기록.
- `cleanup`: 머지된 로컬만 자동 삭제, 미머지-stale은 별도 확인 없이는 안 지움.
- `sync`: main 변경분 merge, 충돌 시 정지.
- PR 경로는 gh 가용성 뒤로 게이트(없으면 status가 direct 권장).

## 슬라이스 구성

1. `branch status`(읽기·계약·main감지·정리후보·위험감지) + 테스트.
2. `branch apply --start`(stash·분기·복원, --approved 가드) + 테스트.
3. `branch apply --finish`(verify 게이트·merge/push·삭제·undo 기록) + 테스트.
4. `branch apply --cleanup`(+미머지 별도 확인) + `--sync` + 테스트.
5. 루트 스킬에 능동적 시작 흐름 통합 + config.branch + 문서.

각 슬라이스 독립 커밋, `node --test` 그린 유지(기존 Windows symlink EPERM 1건만 허용).

## 리스크 원장

- **의미 매칭 오판**: 호스트가 엉뚱한 브랜치를 "이어가기"로 추천할 수 있음 → 카드에 근거(주제·최근 커밋)를 노출하고 사용자가 반려 가능. 애매하면 상위 후보를 제시.
- **stash pop 충돌**: 정지·반환으로 안전 처리(자동 강제 병합 안 함).
- **자동감지된 main 오류**: `mainBranchConfident=false`면 호스트가 확인. config 오버라이드가 최종 안전판.
- **gh 부재**: PR 경로 불가 시 direct 권장 또는 수동 안내.
