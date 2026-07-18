# 구독 인증 스모크 체크리스트 (사용자 로컬 실행용)

이 체크리스트는 클라우드 구현 환경에서 실행할 수 없었던 **인증 의존 검증**을
사용자의 실제 환경(ChatGPT Pro 로그인 Codex CLI + Claude Max 로그인
Claude Code CLI)에서 수행하기 위한 것이다. 각 항목의 결과를
`docs/REVIEW-0.7.0.md`의 "not exercised" 목록과 대조해 갱신한다.

## 준비

```bash
git clone <this-repo> && cd <this-repo>
npm test                      # 332 passed 확인
npm pack                      # adaptive-orchestrator-0.7.0-alpha.1.tgz
npm install -g ./adaptive-orchestrator-0.7.0-alpha.1.tgz
```

테스트 프로젝트에 설치:

```bash
cd /path/to/scratch-project
aorch install --target both --project .
```

## 1. 구독 인증 진단 (쿼터 소비 없음)

```bash
aorch doctor --subscription
```

- [ ] `providers.anthropic.auth.status`가 실제 로그인 상태와 일치하는가
      (로그인 상태면 pass, 로그아웃 후 재실행하면 fail + "run claude /login")
- [ ] `providers.openai.auth.status`가 `pass` 또는 `unknown`인가
      (`codex login status`가 기계 판독 가능하지 않으면 unknown이 정상)
- [ ] `ANTHROPIC_API_KEY=sk-test aorch doctor --subscription` 실행 시
      anthropic environment가 `fail`로 바뀌는가

## 2. Codex 앱 enforcement 정직성

```bash
aorch doctor --surface codex-app
```

- [ ] evidence 파일 없이 `status: "unknown"`인가 (strict를 주장하지 않아야 정상)
- [ ] Codex 앱에서 이 프로젝트를 열고 파일 편집을 시도했을 때 hook이 실제로
      개입하는지 관찰. 개입이 확인되면 그 내용을
      `.aorch/evidence/codex-app.json`에 기록:

```json
[{ "kind": "authenticated-fixture",
   "detail": "Codex app <버전>에서 Edit/apply_patch가 pre-tool-use hook에 의해 거부됨",
   "verifiedAt": "<ISO 날짜>" }]
```

- [ ] 기록 후 `status`가 `strict`로 바뀌는가. 개입이 확인되지 않으면 기록하지
      말 것 (advisory/unknown이 정직한 값).

## 3. Claude Code host 강제

Claude Code로 설치된 프로젝트를 열고:

- [ ] host에게 제품 파일 수정을 요청 → PreToolUse가 deny하고
      ".aorch/inbox에 task envelope" 안내가 나오는가
- [ ] `.aorch/inbox/T1.json` 작성은 허용되는가
- [ ] `git commit` 같은 mutating Bash가 거부되는가
- [ ] permit 없이 `aorch-worker` Agent 호출이 거부되는가

## 4. 모델 availability (쿼터 소비 있음 — 선택)

```bash
aorch models inspect                       # 호출 없음, unknown이 정상
aorch models probe --live --profile claude-sonnet-general        # --yes 없이 → 경고 후 종료
aorch models probe --live --yes --profile claude-sonnet-general  # 실제 1회 호출
```

- [ ] `--yes` 없이 실행하면 쿼터 경고와 함께 exit 1인가
- [ ] probe 후 `aorch models inspect`에서 해당 profile이
      `available`(source: live-probe)로 기록되는가
- [ ] (선택) Codex 쪽: `--profile codex-terra-general`로 동일 확인

## 5. 사용량 pool 기록

```bash
aorch usage show
aorch usage set --pool anthropic-subscription --state yellow --source user
aorch usage show
```

- [ ] 상태 5단계 외 값(`42%` 등)이 거부되는가

## 6. 실제 한도 시나리오 (자연 발생 시에만)

실제 사용 중 rate/usage limit 오류를 만나면:

- [ ] 오류 문자열을 기록해 두었다가 전달 (probe의 `temporarily-limited` 분류
      정확도 개선에 사용)
- [ ] `aorch usage set --pool <pool> --state red --source limit-error`로 기록

## 결과 반영

체크 결과(특히 1·2·4의 실제 출력)를 세션에 공유하면
`CLIENT-SUBSCRIPTION-SOURCES.md`와 `REVIEW-0.7.0.md`의 not-exercised 항목을
authenticated-smoke 항목으로 옮긴다.
