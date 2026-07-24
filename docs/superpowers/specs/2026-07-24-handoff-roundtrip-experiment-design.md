# 핸드오프 왕복 실측 실험 — 설계

작성일: 2026-07-24
상태: 승인됨 (구현 계획 대기)

## 1. 목표

프로젝트 전체의 **load-bearing 미지수**를 먼저 친다:

> 차가운(cold) Codex가 **worktree + task envelope**만으로 순이득(+) 결과를 내는가?

이 부호(sign)가 (+)면 분해기·라우터·학습·검증을 짓는 것이 의미를 갖고, (−)면 어떤 상위 도구도 이 미스매치를 못 살린다. 따라서 다른 무엇을 짓기 전에 이 왕복 1회를 실측한다.

측정하는 것은 **정밀한 숫자가 아니라 부호**다. "핸드오프가 순이득인가, 아니면 조삼모사(부적합 조각을 사람이 체크비용으로 되갚음)인가"라는 이진 질문에 답하는 것이 목적이다.

## 2. 성공 기준 (1차 지표: 순이득 시간)

```
순이득 = 자기추정(직접 했을 때의 시간) − (핸드오프 준비 시간 + 리워크 시간)
```

- 순이득 > 0 이고 acceptance 통과 → 핸드오프 가설 생존.
- 순이득 ≤ 0 또는 acceptance 실패 → 가설 반증(또는 재설계 필요).

보조로 기록: acceptance/verification 통과 여부(품질 바닥선), 관찰된 실패 모드(범위 이탈 / 의도 오해 / 버그).

## 3. 결정적 설계 선택 — 맨손, `aorch` 미사용

이 실험은 **핸드오프(worktree+envelope)**를 검증하는 것이지 **도구(aorch)**를 검증하는 것이 아니다. `aorch exec`로 돌리면 "도구 디스패치가 되는가"와 "핸드오프가 맞는 결과를 내는가"가 뒤섞여 변수가 오염된다.

따라서 코드 0줄. **순수 프로토콜 + 실제 task envelope + 결과 로그**만 만든다. 메모리의 "코드 전에 맨손 실측 1회"와 정확히 일치하며, "얕게 짓기" 원칙의 정수다. 맨손 핸드오프가 순이득이면 그때 비로소 그 주위에 도구를 짓는 것이 정당화된다.

## 4. 프로브 task envelope

실제로 필요한 작업을 프로브로 쓴다. 2026-07-24 깊은 절단에서 `task-runner.test.js`(303줄)를 삭제해 thin `executeTask`에 테스트가 0인 커버리지 구멍이 생겼다. 이를 메운다.

envelope (Codex가 받는 전부. examples/task.json 스키마 준수, 필드는 영어):

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

핸드오프 왕복에서 Codex가 받는 것은 **이 envelope 텍스트 + 그 worktree**뿐이다. 우리 대화 맥락은 0.

## 5. 핸드오프 프로토콜 (맨손 왕복 1회)

1. 현재 커밋에서 linked git worktree를 만든다(격리). 예: `git worktree add`.
2. **차가운 Codex CLI 세션**을 그 worktree에서 연다. 프롬프트로 §4 envelope 텍스트만 준다 — 다른 어떤 맥락도 주지 않는다.
3. Codex가 작업하고 변경 + 짧은 요약(무엇을 했는지)을 낸다.
4. 메인 워크스페이스로 결과를 가져와 `verificationCommands`(`node --test`)를 실제 실행한다.
5. acceptance를 사람이 확인하고, 필요한 **리워크**(고쳐서 수용 가능하게)를 하며 그 시간을 잰다.

## 6. 측정 (블라인드 자기추정)

- **봉인(위임 전):** "내가 이 작업을 직접 하면 몇 분"을 §7 로그에 먼저 적는다. Codex 결과를 보기 전에 적어 편향을 막는다.
- **실측:** 핸드오프 준비 시간(worktree 생성 + envelope 최종화 + Codex 세션 세팅), Codex 왕복 벽시계, 리워크 시간.
- **판정:** 순이득 계산 + acceptance 통과 여부 + 실패 모드.

## 7. 결과 로그 구조

같은 스펙 파일 하단 또는 인접 로그 파일에 채운다(실행은 §8 타임라인상 7/29+):

| 항목 | 값 |
|---|---|
| 자기추정(봉인, 위임 전) | __분 |
| 핸드오프 준비 시간 | __분 |
| Codex 왕복 벽시계 | __분 |
| 리워크 시간 | __분 |
| **순이득 = 추정 − (준비+리워크)** | __분 |
| acceptance 통과? | 예/아니오 |
| verification(node --test) | 그린/실패 |
| 관찰된 실패 모드 | (범위이탈/의도오해/버그/없음) |
| 부호 판정 | (+)/(−) |
| 다음 함의 | (자유 서술) |

## 8. 타임라인

- Codex 쿼터 7/29 복구 (오늘 7/24).
- **지금:** 이 스펙 확정 + envelope 박제 + 자기추정 봉인.
- **7/29+:** 라이브 왕복 1회 실행 + §7 로그 채움 + 부호 판정.

## 9. 안 만드는 것 (YAGNI)

- 하네스·자동 타이머·러너 코드 (맨손이 핵심).
- 다중 시행·통계·신뢰구간 (부호 1회 판정에 불필요).
- 분해기·라우터 개선 (이 실험 결과가 (+)여야 착수 정당화).

부호가 (+)로 나오면 다음 실험은 "envelope 품질이 순이득에 얼마나 민감한가"로, (−)면 "무엇이 의도를 떨어뜨렸는가(실패 모드)"로 자연히 이어진다.
