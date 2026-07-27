# 핸드오프 왕복 실측 실험 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 차가운 Codex가 worktree+envelope만으로 순이득(+) 결과를 내는지 맨손 왕복 1회로 실측해 프로젝트의 load-bearing 미지수 부호를 판정한다.

**Architecture:** 코드를 짓지 않는다. 실제 task envelope(파일) + 결과 로그(파일) + 봉인된 자기추정(git 커밋 타임스탬프가 봉인)을 만들고, Codex 쿼터 복구(7/29) 후 사람이 차가운 Codex 세션에 envelope만 주고 왕복시킨 뒤 verificationCommands로 검증하고 순이득 시간을 계산한다. aorch는 쓰지 않는다(핸드오프를 검증하지 도구를 검증하지 않기 위해).

**Tech Stack:** git worktree, Node.js `node --test`, Codex CLI(수동 세션). 실험 하네스 코드 없음.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-24-handoff-roundtrip-experiment-design.md` — 이 계획은 그 스펙을 구현한다.
- **맨손, aorch 미사용.** 실험 하네스·자동 타이머·다중 시행·통계 없음(YAGNI).
- 측정 대상은 **부호(+/−)**이지 정밀 숫자가 아니다.
- 자기추정은 **Codex 결과를 보기 전에** 봉인한다(블라인드). 봉인 = 위임 전에 커밋.
- 경로에 한글·공백 포함 — 셸에서 반드시 큰따옴표.
- Phase 2(왕복 실행)는 **Codex 쿼터 7/29 복구 후 + 사람이 직접** 수행(차가운 대화형 Codex 세션 + 반사실 타이밍은 사람만 가능). 이 계획의 Task 2–3는 그 절차서다.

---

## File Structure

- Create: `docs/handoff-experiment/envelope.json` — Codex가 받는 전부(task envelope). examples/task.json 스키마 준수.
- Create: `docs/handoff-experiment/log.md` — 자기추정 봉인 + 실측 결과 로그(부호 판정).
- 실행 중 임시: linked worktree(`.aorch-worktrees/` 밖, repo 밖 임시 경로) — 커밋하지 않음.

---

### Task 1: 실험 산출물 박제 + 자기추정 봉인 (Phase 1 — 지금)

**Files:**
- Create: `docs/handoff-experiment/envelope.json`
- Create: `docs/handoff-experiment/log.md`

**Interfaces:**
- Consumes: 스펙 §4의 envelope 정의, `examples/task.json` 스키마.
- Produces: `docs/handoff-experiment/envelope.json`(Task 2가 Codex에 그대로 전달), `docs/handoff-experiment/log.md`(Task 3가 결과를 채움).

- [x] **Step 1: envelope 파일 생성**

`docs/handoff-experiment/envelope.json`:

```json
{
  "id": "T-thin-exec-tests",
  "title": "Regression tests for the thin executeTask",
  "objective": "Add focused regression tests for the pruned executeTask: the dry-run path returns a route and command spec without running a worker, and a write task is refused when the workspace is not isolated.",
  "kind": "test",
  "role": "executor",
  "risk": "standard",
  "complexity": "standard",
  "write": true,
  "allowedScope": ["test/task-runner.test.js"],
  "forbiddenScope": ["src/**", "docs/**", "integrations/**"],
  "acceptanceCriteria": [
    "A dry-run of executeTask returns route, capabilities, and commandSpec without spawning a worker.",
    "A write task with risk >= high is refused when cwd is not a linked worktree.",
    "A write task at standard risk without allowInPlaceWrite is refused in-place.",
    "node --test passes with the new file included."
  ],
  "verificationCommands": ["node --test"]
}
```

- [x] **Step 2: 로그 스켈레톤 생성**

`docs/handoff-experiment/log.md`:

```markdown
# 핸드오프 왕복 실측 로그

프로브: T-thin-exec-tests (envelope.json)
스펙: docs/superpowers/specs/2026-07-24-handoff-roundtrip-experiment-design.md

## 봉인(위임 전 — 블라인드 자기추정)

- 자기추정(내가 직접 하면): __분
- 봉인 커밋: (이 파일을 Codex 결과 전에 커밋한 해시가 봉인 증거)

## 실측(7/29+ 왕복 후)

| 항목 | 값 |
|---|---|
| 핸드오프 준비 시간 | __분 |
| Codex 왕복 벽시계 | __분 |
| 리워크 시간 | __분 |
| **순이득 = 추정 − (준비+리워크)** | __분 |
| acceptance 통과? | __ |
| verification(node --test) | __ |
| 관찰된 실패 모드 | __ |
| **부호 판정** | (+)/(−) |
| 다음 함의 | __ |
```

- [x] **Step 3: 사용자에게 블라인드 자기추정 N 요청 후 기록** — 75분("60분+" 버킷)

사용자에게 묻는다: "이 envelope 작업(thin executeTask 회귀 테스트)을 **당신이 직접** 하면 몇 분 걸릴 것 같나요?" — 받은 숫자 N을 `log.md`의 "자기추정: __분"에 채운다. (이 숫자는 사람의 반사실이라 모델이 지어내지 않는다.)

- [x] **Step 4: 봉인 커밋 (Codex 결과 전)** — `5fd6fd8` (2026-07-24T21:55:17+09:00)

```bash
git add docs/handoff-experiment/envelope.json docs/handoff-experiment/log.md
git commit -m "Seal handoff experiment envelope and blind self-estimate"
```

Expected: 커밋 성공. 이 커밋이 **자기추정 봉인 증거**(Codex 결과를 보기 전 시점 고정).

---

### Task 2: 차가운 Codex 왕복 실행 (Phase 2 — 7/29+, 사람 주도)

**전제:** Codex 쿼터 복구됨. 이 태스크는 **사람이 직접** 수행하는 절차서다.

**Files:**
- 임시 worktree(커밋 안 함). 변경 대상: `test/task-runner.test.js`(Codex가 worktree 안에서 생성).

**Interfaces:**
- Consumes: `docs/handoff-experiment/envelope.json`.
- Produces: worktree 안의 `test/task-runner.test.js` + Codex의 작업 요약(무엇을 했는지). Task 3가 이를 검증한다.

- [x] **Step 1: 격리 worktree 생성 + 시간 기록 시작** — 실제 경로 `~/.claude/jobs/50c8fd88/tmp/handoff-probe` (23:03:26 체크아웃)

현재 커밋에서:

```bash
git worktree add "C:/Users/goyan/AppData/Local/Temp/aorch-handoff-probe" HEAD
```

이 시점부터 **핸드오프 준비 시간** 타이머 시작(worktree 생성 + Step 2 세팅까지).

- [x] **Step 2: 차가운 Codex 세션에 envelope만 전달** — 이탈: 사용자 지시로 에이전트가 `codex exec` 헤드리스 실행(맥락 0 유지, log.md 이탈 기록 참조)

worktree 디렉터리에서 **새(차가운) Codex CLI 세션**을 연다. 우리 대화·이 계획 어떤 맥락도 주지 않는다. 프롬프트로 `envelope.json`의 내용만 붙여넣는다. 여기서 준비 시간 타이머 정지, **Codex 왕복 벽시계** 타이머 시작.

- [x] **Step 3: Codex 작업 완료까지 관찰** — 23:09:07 완료(왕복 ≈5분41초), 범위 이탈 없음

Codex가 `test/task-runner.test.js`를 만들고 끝내면 왕복 타이머 정지. Codex가 범위를 벗어났는지(forbiddenScope: src/**, docs/**), 의도를 오해했는지 육안 관찰해 메모(실패 모드 후보).

Expected: worktree 안에 `test/task-runner.test.js`가 생성됨(혹은 실패/이탈 — 그 자체가 데이터).

---

### Task 3: 검증 + 리워크 + 부호 판정 (Phase 2 — 7/29+, 이어서)

**Files:**
- Modify(필요 시 리워크): worktree의 `test/task-runner.test.js`
- Modify: `docs/handoff-experiment/log.md`(메인 워크스페이스)

**Interfaces:**
- Consumes: Task 2의 worktree 결과.
- Produces: 채워진 `log.md`(부호 판정 포함).

- [x] **Step 1: verificationCommands 실행** — 89→93(+4) 그린, 기존 symlink EPERM 1건만(환경성)

worktree에서:

```bash
node --test
```

Expected: 그린이면 품질 바닥선 통과 후보. 실패면 실패 내용 기록.

- [x] **Step 2: acceptance 육안 확인 + 리워크(시간 측정)** — 4/4 통과, 리워크 0분(무수정 채택, `8d5720e` 바이트 동일)

envelope의 acceptanceCriteria 4개를 하나씩 확인한다(dry-run route+commandSpec 반환 / high-risk 격리 거절 / standard in-place 거절 / node --test 그린). 미달이면 **사람이 직접 고쳐** 수용 가능하게 만들고 그 시간을 **리워크 시간**으로 잰다. 리워크가 "처음부터 내가 짜는 것"과 다름없으면 그 사실을 기록(순이득에 그대로 반영).

- [x] **Step 3: 로그 채우고 부호 판정** — **(+)**, 순이득 ≥ +65분 (2026-07-28 타임스탬프 재구성 기입)

`docs/handoff-experiment/log.md`의 실측 표를 채운다: 준비/왕복/리워크 시간, 순이득 = N − (준비+리워크), acceptance/verification 결과, 실패 모드, **부호 (+)/(−)**, 다음 함의(부호 (+)면 "envelope 민감도" 실험, (−)면 "실패 모드" 실험으로 분기).

- [x] **Step 4: worktree 정리** — 2026-07-28 제거 완료

```bash
git worktree remove "C:/Users/goyan/AppData/Local/Temp/aorch-handoff-probe"
```

(수용된 테스트를 메인에 살릴지는 별도 결정 — 실험 로그와 무관.)

- [x] **Step 5: 결과 커밋** — 이 갱신과 함께 커밋(봉인 `5fd6fd8`과 분리)

```bash
git add docs/handoff-experiment/log.md
git commit -m "Record handoff round-trip result and sign verdict"
```

Expected: 봉인 커밋(Task 1 Step 4)과 결과 커밋이 분리돼, git history가 "추정은 결과 전에 봉인됐다"를 증명.

---

## Self-Review

**1. Spec coverage:** 스펙 §1 목표→Task 3 부호판정. §2 순이득 지표→Task 3 Step 3. §3 맨손/aorch미사용→Global Constraints + Task 전반. §4 envelope→Task 1 Step 1. §5 프로토콜 5단계→Task 2–3. §6 블라인드 측정→Task 1 Step 3(봉인)+Task 2–3(실측). §7 로그 구조→Task 1 Step 2. §8 타임라인→Global Constraints + Phase 표기. §9 YAGNI→Global Constraints. 누락 없음.

**2. Placeholder scan:** log.md의 `__` 칸은 7/29+ 실행 시 채울 의도된 데이터 자리(플레이스홀더 결함 아님). 자기추정 N은 사람 입력이라 Task 1 Step 3에서 획득 절차 명시. 그 외 TBD/TODO 없음.

**3. Type consistency:** 파일 경로(`docs/handoff-experiment/envelope.json`, `log.md`, worktree 임시 경로), envelope id(`T-thin-exec-tests`), 검증 명령(`node --test`)이 Task 전반에서 일관.
