# aorch 리빌드 설계 (2026-07-28, 인터뷰 확정)

기준선: `left`@`02293d5`. 리빌드 = 기준선 위 증축. 규율 = 얕게(신규 의존성 0, 데몬/폴링 0).

## 성공 기준

**aorch 자기 자신에서 실사용 왕복 1회**: 리드가 실제 서브태스크를 classify로 다운시프트하고, 1건을 Codex에 위임해 verify 게이트(테스트 실행)를 통과.

## 확정 결정 원장 (3라운드 인터뷰)

| 축 | 결정 |
|---|---|
| 다운시프트 실효화 | 카탈로그 확장(haiku에 testing 0.82 / implementation 0.80), FLOOR_BY_COMPLEXITY 불변 |
| 사용 표면 | PreToolUse 훅 강제 — 서브에이전트 스폰 차단+교정(classify 결과를 deny reason으로) |
| 팔2 | 헤드리스 `codex exec` 위임 + 크로스 fallback v1 포함 |
| 리미트 신호 | 수동 토글(`.aorch/limits.json`, 만료 타임스탬프) + rate-limit 에러 반응 감지. usage 폴링 안 함 |
| verify | 테스트 실행 게이트 + escalate 사다리: Claude→opus→fable, Codex→sol→sol@xhigh. 총 attempt ≤ 3, 소진 시 증거와 함께 사람 반환 |
| Fable | 카탈로그에 `claude-fable-apex` 신설, `complexities:["critical"]` 잠금 — 일반 라우팅(classify 최대 high)에서 절대 선택되지 않고 escalate의 forcedRoute만 접근. 잠그지 않으면 quality-first인 모든 high 작업을 하이재킹해 비용 역주행 |
| 관측 | verify 결과를 performance-store에 자동 기록(통과 1.0 / 실패 0.2, `metadata.source:'verify-gate'`) — 테스트 실행은 워커 밖의 객관 증거라 독립-리뷰 원칙에 부합. 다운시프트 확장의 자연 복원 안전망 |
| 청소 | Stop 훅 제거(전제인 durable run이 삭제된 평면, 완료 게이트는 exec 루프 안으로), 유물 삭제, DESIGN.md 재작성 |
| 왕복 대상 | aorch 자체(도그푸딩) |

## Slice 0 스파이크 실측 (2026-07-28)

1. **PreToolUse 서브에이전트 게이트 = 차단형 가능.** 실측 payload(`hook-payloads.jsonl`):
   - `tool_name: "Agent"` (Task 아님 — 단 matcher `"Task"`로도 발동됨. 구현은 `"Task|Agent"` matcher 사용)
   - `tool_input: { description, prompt, subagent_type, model }` — **`model` 존재 확인** → 과등급 판정 가능
   - 세션 `effort: {level}` 도 payload에 포함됨
2. **`claude --model fable` 유효** — canonical `claude-fable-5`로 실행 확인. 카탈로그 model 문자열 = `fable`.
3. **`claude --effort` 허용값 = `low, medium, high, xhigh, max`** — 기존 opus 프로필의 xhigh/max 유효(잠재 버그 없음).

## 슬라이스 구성

0. 스파이크(완료, 이 문서) → 1. 다운시프트 실효화 → 2. verify+escalate+Fable → 3. 훅 강제 → 4. Codex 위임+크로스 fallback+도그푸딩 → 5. 청소+문서.

상세 구현 단계는 계획 파일(세션 플랜) 참조. 각 슬라이스는 독립 커밋, `node --test` 그린 유지(기존 Windows symlink EPERM 1건만 허용).

## 리스크 원장

- haiku implementation 0.80이 품질 미달이면 verify-gate 관측이 conservative를 바닥선 아래로 끌어내려 자연 복원. 급하면 config 한 줄.
- claude CLI의 실제 한도 메시지 포맷 미확정 — 이벤트 발생 시 fixture 캡처해 감지 패턴 고정(후속). 그때까지 1차 경로는 수동 토글.
- security/architecture(high)는 다운시프트되지 않음 — quality-first 유지가 의도된 동작. 매트릭스 테스트로 경계 고정.
- verificationCommands는 셸 실행 — envelope 작성자가 사용자 측 리드이므로 신뢰 경계 내부.
