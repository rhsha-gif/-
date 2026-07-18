# v0.7.0 구현 리뷰 (alpha.1 초안)

작성일: 2026-07-18
대상 버전: `0.7.0-alpha.1`
베이스라인: v0.6.1 핸드오프 (source commit `e6dacca8515e`, 268 tests passing)

이 문서는 릴리스 문서가 아니라 **핵심 불변식 단계(우선순위 1~5)** 완료 시점의
정직한 상태 보고서다. v0.7.0 정식 릴리스 전에 우선순위 6~11 구현과 함께 갱신한다.

## 1. 이번 alpha에서 구현된 것

### P1. 구독-local 클라이언트/인증/쿼터 평면

- `subscription-local` 기본 접근 프로필. `explicit-api`는 이름과 fail-closed
  경계만 예약 (`validateAccessProfile`이 즉시 거부).
- API key·custom endpoint·Bedrock/Vertex/Foundry·PAYG·cloud 위임 기본 차단.
- claude/codex worker 실행 전 credential 충돌 검사: 충돌 시 실행 자체를 차단.
  `claude -p`는 `ANTHROPIC_API_KEY`가 있으면 무조건 사용한다는 공식 문서
  사실(2026-07-18 확인)이 차단의 근거다.
- `CLAUDE_CODE_OAUTH_TOKEN`/`apiKeyHelper`는
  `access.allowAutomationCredential` 명시 정책 필요.
- worker는 sanitized 전체 교체 환경으로 실행 (executor `envMode: 'replace'`).
- 사용량 pool: `anthropic-subscription` 하나(interactive/native/`claude -p`
  공유, 현재 일시중지된 Agent SDK credit 정책 기준) + `openai-agentic`.
  상태는 `unknown|green|yellow|red|exhausted`만 기록, 퍼센트 발명 금지,
  60분 초과 snapshot 거부.
- 명령: `aorch usage show|set`, `aorch models inspect`,
  `aorch models probe --live --yes`, `aorch doctor --subscription`,
  `aorch doctor --surface codex-app`.

### P2. Bootstrap-only host 강제

- 의존성 없는 PreToolUse 정책 런타임
  (`integrations/shared/hook-policy.mjs` 단일 소스, 설치본과 byte-identical).
- host 제품 파일 편집 거부, `.aorch/inbox/**`만 쓰기 허용, 보호 파일 상시 거부.
- host Bash: `aorch` + read-only 명령만. redirection/pipe/chaining/command
  substitution/환경변수 주입(`AORCH_WORKER=` 위조 포함) 거부.
- native Agent 호출은 일회성 hash-bound dispatch permit(`.aorch/dispatch/`)
  필요: 만료·일회 소비·model/effort binding 검증. 관리되는 `aorch-worker`
  하나만 설치하고 scout/reviewer native agent는 제거.

### P3. 완료 상태의 attestation 결속

- `complete|accepted|done`은 digest 검증된 pass attestation 없이는 기록 불가.
- attestation은 state root 내부에 있어야 하며 taskId/runId/digest 재검증.
- `completed` run은 skip 제외 모든 task의 attestation을 다시 읽어 재검증.
- 초기 상태가 완료인 task로 run을 만들 수 없음.

### P4. Immutable captured-content 검증 (attestation v2)

- 캡처 시점에 binary patch 바이트+SHA-256, untracked/evidence immutable
  snapshot 사본, canonical snapshot digest 기록.
- git-worktree verifier는 live workspace를 다시 읽지 않고 캡처본에서
  materialize; materialized fingerprint 전수 재검사로 캡처~검증 사이 변조는
  fail closed.
- attestation schemaVersion 2: `baseHead`/`patchSha256`/`snapshotDigest`/
  `files`. evidenceDigest는 redaction 이후 내용에 대해 계산(기존의
  digest-전-redaction 불일치 결함 수정).

### P5. Hidden verifier + sanitized environment

- private task envelope(verifierCommands·verifierPrepareCommands·
  verifierProtectedScope·approval)와 public worker envelope 분리. worker
  prompt에 private 값 누출 없음(테스트로 확인).
- 변경 파일이 protected scope와 겹치면 check 실행 전 fail.
- write task는 실행검사 최소 1개 필요 (low-risk + `allowChangeEvidenceOnly`
  명시 시에만 change-evidence-only 허용).
- verifier check는 sanitized 교체 환경에서 실행.
  `verification.envAllowlist`로 추가 변수 허용 가능하나 credential deny가
  항상 우선.

## 2. 이번 alpha에 포함되지 않은 것 (스펙 우선순위 6~11)

- prompt profile 날짜 기반 fail-closed 제거와 provider fallback (P6)
- gate monotonic risk floor 재작업, persistent shadow 제거 (P7)
- attestation 기반 보수적 reliability 자동 관측 (P8)
- hook runtime 통합 마무리(journal.mjs 중복 제거)·compact·worktree·
  upgrade/uninstall (P9)
- human-bound approval journal (P10)
- 릴리스 패키징·release manifest·REVIEW 최종화 (P11)
- **router의 usage-pressure 반영**: pool 상태·`planLimitResponse` 정책 함수는
  존재하지만 router 선택 순서에는 아직 연결되지 않았다 (P8과 함께 예정).
- **claude-native-subagent transport 실행 경로**: 인터뷰 결정에 따라 permit
  발급/검증 인터페이스와 hook 강제만 구현. 이번 alpha의 Anthropic 실행 경로는
  cross-host `claude -p` 하나다.

## 3. 핸드오프 대비 기록된 편차

- 2026-07-18 공식 문서 재확인 결과가
  `docs/official/CLIENT-SUBSCRIPTION-SOURCES.md`에 추가됨. 핵심: Codex에
  공식 hooks 프레임워크가 문서화되어 있으나 write-tool(PreToolUse의
  apply_patch/Edit 계열) 가로채기는 공식 확인 불가 → Codex 표면의 strict
  주장은 여전히 authenticated fixture 없이는 금지, 문서만으로는 advisory가
  최대.
- verifier의 evidenceDigest 계산 시점을 redaction 이후로 수정 (v0.6.1의
  잠재 결함).

## 4. 검증 상태 구분

### 로컬에서 기계적으로 검증됨

- 전체 테스트 스위트: **332 passed / 0 failed** (`npm test`, Node 20+,
  이 리포지토리의 CI 컨테이너).
- fake CLI fixture 기반: credential 차단, env sanitization, permit 발급/소비/
  만료/재사용 거부, snapshot TOCTOU fail-closed, protected scope 차단,
  attestation 결속, hook 진입점 end-to-end(deny/allow JSON 출력).

### 인증된 클라이언트로는 실행되지 않음 (not exercised)

아래 항목은 이 구현 환경에 ChatGPT 로그인된 Codex CLI와 Claude 구독 로그인이
없어 실행되지 않았다. `docs/SMOKE-CHECKLIST.md`의 절차로 사용자의 로컬
환경에서 확인해야 한다.

- `claude auth status` 실제 출력 파싱 (JSON 형식은 공식 문서로만 확인)
- `codex login status` 실제 출력과 exit code
- Codex 앱에서의 hook 실행 여부 및 write-tool 가로채기 (enforcement는
  evidence 파일 없이는 `unknown`으로 보고됨 — 의도된 동작)
- `aorch models probe --live`의 실제 provider 응답과 limit 오류 파싱
- 실제 구독 한도 도달 시나리오

### 공식 문서로만 확인됨

- Claude Code 인증 우선순위와 `-p`의 API key 무조건 사용
- Agent SDK credit 변경 일시중지(`claude -p`가 구독 한도 차감 유지)
- Codex hooks 이벤트 목록과 trust 모델

## 5. 잔여 위험

- PreToolUse hook은 OS sandbox가 아니다. worker transport의 sandbox·
  permission mode·worktree와 함께 써야 한다.
- Codex 표면에서 hook의 write-tool 가로채기가 미확인이므로, Codex host의
  bootstrap-only는 현재 advisory 수준이다. strict가 필요하면 Claude Code
  host 또는 read-only host workspace를 사용해야 한다.
- Bash 정책은 allowlist 기반이지만 shell 파싱은 근사치다. 정책 우회 가능성이
  발견되면 allowlist를 좁히는 방향으로 수정한다.
- usage pool 상태는 자기신고/수동 기록 중심이며 provider의 실시간 잔여량이
  아니다.
