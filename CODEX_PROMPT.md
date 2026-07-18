# Paste This Into Codex

이 저장소는 Adaptive Orchestrator v0.7.0 **subscription-first** 구현 인계 패키지다.

먼저 다음을 순서대로 읽어라.

1. `AGENTS.md`
2. `CODEX_START_HERE.md`
3. `docs/SUBSCRIPTION-LOCAL.md`
4. `docs/official/CLIENT-SUBSCRIPTION-SOURCES.md`
5. `docs/superpowers/specs/2026-07-17-v0.7-minimal-sound-core-design.md`
6. `docs/superpowers/plans/2026-07-17-v0.7-minimal-sound-core.md`
7. `docs/reviews/REVIEW-2026-07-17-v0.6.2-FIRST-PRINCIPLES.md`

현재 코드는 v0.6.1 기준선이며 v0.6.2는 소스가 아니라 설계 검토 자료다. `scripts/prepare-codex-workspace.sh`를 실행하고 268개 기준 테스트가 통과하는지 확인한 뒤, 격리된 feature branch/worktree에서 구현 계획을 TDD 방식으로 순서대로 실행하라.

사용자의 실제 환경은 다음과 같다.

```text
- Codex는 주로 ChatGPT desktop app의 Codex view에서 사용한다.
- Claude는 주로 Claude Code CLI에서 사용한다.
- 두 provider 모두 개인 구독으로 사용한다.
- 직접 API는 거의 쓰지 않으며 자동 API/PAYG fallback을 원하지 않는다.
```

따라서 기본 배포 프로필은 `subscription-local`이어야 한다.

- Codex 앱은 host UI다. 비공식 IPC로 제어하지 마라.
- Codex 앱에서 strict host enforcement가 실제로 지원·실행되는지 공식 문서와 authenticated fixture로 증명하기 전에는 strict라고 주장하지 마라. `strict|advisory|unsupported|unknown`을 보고하라.
- OpenAI worker는 같은 ChatGPT 계정으로 로그인한 local Codex CLI를 사용하라.
- Claude Code host의 same-provider worker는 일회성 permit에 결속된 managed native subagent를 우선하라.
- Codex host에서 Anthropic worker가 필요하면 subscription OAuth의 `claude -p`를 사용하라.
- API key, custom endpoint, Bedrock/Vertex/Foundry, usage credit, PAYG, Codex cloud task를 자동 fallback으로 추가하지 마라.
- 2026-07-17 현재 `claude -p` 별도 Agent SDK credit 전환은 중지된 상태이므로 interactive Claude와 같은 subscription pool로 처리하라.
- provider가 노출하지 않는 잔여량 퍼센트나 비용을 만들어내지 마라.
- model profile은 entitlement가 아니다. live probe는 사용자 동의가 있는 read-only canary로만 수행하라.

핵심 불변식:

- host는 모든 실질 작업에서 bootstrap-only다.
- 저위험 단순 작업도 host-direct가 아니라 하나의 delegated worker 호출로 처리한다.
- worker receipt는 claim이고 captured content에 결속된 passing attestation만 완료 증거다.
- hidden verifier plan은 worker에게 노출되지 않는다.
- regex gate는 risk floor다.
- stale prompt guidance는 warning/fallback이며 fleet outage가 아니다.
- provider-aware prompt template은 공식 가이드를 반영하지만 원격 문서에서 자동 컴파일됐다고 과장하지 않는다.
- 실행하지 않은 alternative는 성능 evidence가 아니다.
- 자동 관측은 execution reliability만 기록한다.
- control-plane 변경과 access-profile 변경은 실제 사용자 승인에 결속된다.

Claude Code 또는 Codex client 동작이 현재 버전에 의존하면 OpenAI·Anthropic 공식 문서만 사용해 확인하고, plan과 다르면 근거·날짜·영향을 `docs/REVIEW-0.7.0.md`에 기록하라.

각 task마다 RED → GREEN → focused verification → focused commit 순서를 지켜라. 작업을 끝냈다고 주장하기 전에는 전체 release evidence를 실제로 생성하고 검증하라.
