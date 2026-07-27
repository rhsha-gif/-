# aorch v1 — Claude 리드 분해-위임 판단층 설계

작성일: 2026-07-24
상태: 승인됨 (구현 계획 대기)
선행: [핸드오프 왕복 실측 실험](2026-07-24-handoff-roundtrip-experiment-design.md) — 이 설계의 팔2는 그 실험의 부호에 게이트된다.

## 1. Context (왜 이 설계인가)

aorch의 진짜 제품 = **"내 두 구독(Claude Code + Codex CLI)을 위한 다운시프트 판단 층"**. 통증: 여러 잡일에까지 프론티어 모델의 최고 추론을 쓰니 느리고 오래 걸리고 오버엔지니어링. 원하는 것: **기본값(모델/effort)을 언제 낮추고 높일지의 판단을 오케스트레이터에 위임** — 매번 수동으로 등급 고르기 싫음.

이 프로젝트는 한 번 자기 병(배보다 배꼽)에 걸려 두 세션간 ~2,200줄을 도려냈다. 그래서 이 설계의 최상위 규율은 **얕게 짓기**다. "최대 파쿠리"는 examined되어 **축(시간+리미트+품질바닥선)에 닿는 메커니즘만, 기존 코어를 살찌우는 형태로** 흡수하는 것으로 수렴했다(코드 벤더링 아님, 신규 시스템 수입 아님).

## 2. Goal & 목적함수

**Goal:** Claude(리드)가 작업을 서브태스크로 분해하면, aorch가 각 서브태스크마다 (a) Claude 내부 등급(Haiku/Sonnet/Opus) 또는 (b) Codex 위임을 판단하고, **테스트 실행으로 검증**하며, **Claude 리미트 소진 시 Codex로 크로스 fallback** 한다.

**목적함수 = 시간 + 구독 리미트 절약, 품질 바닥선(minimumQuality) 유지.**
- 구독제라 **토큰 비용은 매몰비용** → 비용 최적화는 목적 아님(비용 회계·대시보드·예산경보 미구현).
- 병렬 처리량은 우선순위 아님.

**라우팅 대상:** 보일러플레이트/리팩터, 테스트/문서. **읽기/조사/요약은 제외**(검증이 스팟체크≈직접하기라 순이득 ~0).

**범위(v1):** **Claude 리드 방향만**({Claude 티어 + Codex}). Codex-as-lead({Codex + Claude}) 거울상은 v2.

## 3. Architecture — 두 팔 + 핵심 메커니즘

### 3.1 핵심 메커니즘: 리드가 어떻게 aorch에 개입하나

분해기를 새로 짓지 않는다(자동 분해는 선행연구 전부 미해결 + 배꼽). 대신 **Claude Code 리드의 네이티브 분해에 올라탄다:**

- aorch는 **작은 MCP belt**(claudexor식 `route`/`delegate`/`status` 툴)를 노출한다.
- **스킬**이 리드에게 규율을 주입한다: "워커(서브에이전트)를 띄우기 전, 각 서브태스크를 `aorch route`에 물어 등급/제공자 판정을 받고 그대로 디스패치하라."
- 이는 블랭킷 프록시가 아니다 → 상시 서버·setup-token 가로채기·ToS 회색지대를 피하고 얕게 유지.
- **정직한 약점:** 권고지 강제가 아니다(리드가 성실히 belt를 호출하느냐에 의존). 강제화(pre-subagent 훅)는 실현성 미확인 → v1은 권고, 훅은 후속 조사 항목.

### 3.2 팔1 — Claude 내부 티어 라우팅 (지금 구현, 게이트 없음)

각 서브태스크의 난이도 → Haiku/Sonnet/Opus 서브에이전트(`model` 오버라이드). 네이티브 서브에이전트라 차가운 Codex 위험 0. **대부분 기존 `src/router.js` 강화**로 성립.

- 훔칠 것(claude-code-router, MIT/Node): **Router 스키마**(`default/background/think/longContext/longContextThreshold≈60000`), **tiktoken `cl100k_base` 토큰카운트 임계분기**, **`(req,config)→"provider,model"` custom-router 서명**.
- 난이도 = **태스크 종류 + 토큰 수 휴리스틱**(학습 라우터 아님 — 솔로 볼륨은 학습 불성립). 필요 시 임베딩 유사도(semantic-router식) 로컬 분류를 후속으로.

### 3.3 팔2 — Codex 위임 + 크로스 fallback (핸드오프 부호 측정 후 구현)

**load-bearing 미지수**(차가운 Codex가 worktree+envelope로 순이득?)에 게이트. 부호 (+)일 때만 배선.

- **위임 안전:** claudexor의 **depth=1 강제 + 부모당 서브런 캡**(재귀 폭주 방지).
- **크로스 fallback:** claude-code-mux의 **priority 폴백 체인**으로 "Claude 티어 → Codex" 표현. 같은 구독 풀 등급하강은 리미트 소진에 무력하므로 Codex(다른 구독)로 넘기는 것이 핵심.
- **로테이션 트리거:** claudexor식 — 벤더 `oauth/usage` 폴링 → **타입된 limit 신호에서만** 로테이션(일반 네트워크 오류엔 절대 안 함). 실패 판정·cooldown·order-level retry 규칙은 LiteLLM에서 차용.
- **워커 격리:** worktree per-워커(uzi의 fan-out 형태, fractal의 depth/time/cost 하드캡). 기존 `assertWriteIsolation`(task-runner.js) 불변식 유지.
- **디스패치 하드닝:** codex-mcp-bridge식 — env allowlist, 시크릿 리댁션, **FIFO 동시성 캡**(rate-limit 바닥), 세션 ID 멀티턴.

### 3.4 Verify — 프로젝트의 화이트스페이스 (양 팔 공통)

조사한 어떤 라우터도 verify를 테스트 실행으로 하지 않는다(전부 LLM-judge/학습scorer/휴리스틱). **cheapest-first 캐스케이드(FrugalGPT 골격) + 테스트 실행 검증 + 실패 시 에스컬레이트**가 남이 안 한 유일 조합이자 aorch의 차별점.

- metaswarm 철학: **서브에이전트 self-report 불신, 오케스트레이터가 독립 검증**.
- 검증 = task의 `verificationCommands` 실제 실행(예: `node --test`). attestation 아님. (기존 프루닝에서 verifier→테스트 게이트로 이미 전환한 결정과 일치.)
- 실패 시: 같은 서브태스크를 **한 등급 위로 에스컬레이트**(캐스케이드). 반복 캡 후 사람 에스컬레이션(metaswarm식).

## 4. 재사용/보존 코어 (신규 파일 최소화)

파쿠리는 전부 아래 기존 유닛의 **강화**로 흡수한다:
- `src/router.js` — 난이도→등급/제공자 (팔1 Router 스키마·임계 이식 대상)
- `src/task.js` — task envelope (스키마 §5 필드 보강 대상)
- `src/task-runner.js` — thin `executeTask`(route→capabilities→dispatch), `assertWriteIsolation` 불변식
- `src/capabilities.js`, `src/config.js`, `src/executor.js`, `src/providers/*` — 디스패치 배관
- `src/observations.js`, `src/performance-store.js` — 4차원 근거 축적
- `src/cli.js` — `route`/`exec` 명령 (belt가 이를 감쌈)

## 5. Task Envelope 스키마 보강

기존 envelope(`examples/task.json` 스키마)에 spec-kit/A2A 필드를 더한다:
- 유지: `id, title, objective, kind, role, risk, complexity, write, allowedScope, forbiddenScope, acceptanceCriteria, verificationCommands`
- 추가: `status`(pending|running|done|failed), `verification_result`(green|fail + 요약)
- 핸드오프=타입된 payload(OpenAI Agents SDK "handoff=툴 input" 관점): belt의 `delegate` 툴 input이 곧 envelope.

## 6. 파쿠리 지도 (층별 · 라이선스 · 패턴만)

| 층 | 출처 | 라이선스 | 훔칠 패턴 |
|---|---|---|---|
| JS 라우터 뼈대 | claude-code-router | MIT | Router 스키마·tiktoken 임계·custom-router 서명 |
| 구독 OAuth | claude-code-mux | MIT(Rust) | PKCE OAuth 인터셉트·priority 폴백 |
| 쿼터 로테이션 | claudexor | MIT | usage폴링→타입된 limit에서만 로테이션·depth=1/서브런 캡·2패밀리 리뷰 |
| 폴백 규칙 | LiteLLM | MIT(Py) | 실패판정(429/5xx/timeout)·cooldown·order-level retry |
| worktree 격리 | uzi, fractal | MIT, Apache | fan-out·SQLite 런원장·depth/time/cost 캡 |
| 양방향 브리지(v2) | codex-claude-bridge | MIT | Codex→Claude 블로킹 툴콜(비대칭) |
| verify | metaswarm, FrugalGPT | MIT, 논문 | self-report 불신·크로스모델 리뷰·캐스케이드(scorer=테스트실행) |
| envelope | spec-kit, A2A | MIT, Apache | intent+acceptance+status+verification_result |

**라이선스 규율:** 순수 개인용 영구라 사용엔 제약 없으나 **코드 벤더링 금지, 패턴만 clean-room 재구현**. 특히 claude-squad(AGPL)·ruflo(배꼽 정수)는 동작만 참고.

## 7. 구현 순서 (승인됨: 순서 1)

- **팔1 먼저(지금, 내가 구현):** router.js 강화 + belt + 스킬 + 테스트-verify 캐스케이드. 게이트 무관.
- **팔2 측정 병행(사람 주도):** 봉인된 핸드오프 왕복 1회 실측 → 부호 판정(선행 스펙 절차). (+)면 팔2 배선, (−)면 재설계.

## 8. 검증 (end-to-end)

- 단위: `node --test` 그린(기존 `cli-smoke.test.js` Windows symlink EPERM 1건은 환경성·소스무관 → "그 외 신규 실패 없음"으로 판정).
- 팔1 스모크: 난이도 다른 서브태스크 2개를 belt `route`에 넣어 하나는 Haiku, 하나는 Opus로 갈리는 결정이 관찰되는지.
- verify: 의도적으로 실패하는 서브태스크가 테스트 게이트에서 걸려 에스컬레이트되는지.

## 9. 안 만드는 것 (YAGNI)

- 분해기(선행연구 미해결 + Claude 네이티브에 올라탐).
- 비용 회계·예산경보·savings 대시보드(죽은 축).
- 학습 라우터·트레이닝(솔로 볼륨 불성립).
- 블랭킷 투명 프록시(상시 서버·ToS 회색지대·품질 맹점).
- Codex-as-lead 거울상(v2).
- 팔2를 부호 (+) 전에 배선(재작업 위험).
