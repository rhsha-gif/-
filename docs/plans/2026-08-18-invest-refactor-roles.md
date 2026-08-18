# invest-analyst / refactorer 역할 추가

## 목표

투자 판단 보조와 리팩토링 실행이 aorch 역할로 성립하고(`agentRole` 12종), 계획 템플릿으로 진입 가능하며, 설치본 갱신까지 끝나면 완료. 실전 도그푸딩은 성격상 이번 범위 밖(아래 명시).

## 접근

책 3종과 같은 패턴의 기계적 확장. 인터뷰 확정(08-18): invest-analyst=분석·종합 전담(수집은 researcher, 반박은 reviewer와 분업, invest-judge 입력 형식 산출, read-only → reviewer 축), refactorer=write 실행자(동작 보존, 테스트 통과가 verify 게이트, ponytail이 '무엇을'·refactorer가 '어떻게'). 새 kind 불필요 — invest는 `risk-analysis`, refactor는 `implementation`이 이미 있다.

**함정 선반영**: `roleAgents` 블록은 선언되면 전 키 엄격 검사이므로, 역할 추가 후 **오늘 force-config로 갱신한 두 설치본(aorch·책 만들기)은 10키 블록이 12키 검사에 걸려 깨진다** → 다시 `--force-config`(aorch는 `progress` 키 보존·복원). 주식트레이더·study-agent 설치본은 roleAgents 블록이 없어 기본값으로 동작 — 확인만 한다.

## 검증 명령

```bash
npm run check
node src/cli.js decompose --plan examples/plan-invest-evidence.json
node src/cli.js dispatch --plan examples/plan-invest-evidence.json --dry-run
node src/cli.js dispatch --plan examples/plan-refactor.json --dry-run
```

### 작업 1: 배선 (12종)

대상: `src/decompose.js`, `src/config.js`, `schemas/task-plan.schema.json`, `config/aorch.config.json`, `test/decompose.test.js`, `test/config.test.js`, `test/cli-smoke.test.js`

- [x] `AGENT_ROLES`에 `invest-analyst→reviewer`, `refactorer→executor` 추가
- [x] enum·AGENT_ROLE_KEYS·DEFAULT_ROLE_AGENTS·config roleAgents 12종으로, description 한 줄씩
- [x] 세 테스트의 목록 단언 갱신
- [x] 검증: `node --test test/decompose.test.js test/config.test.js test/cli-smoke.test.js`

### 작업 2: 프리셋 4파일

대상: `integrations/{claude,codex}/agents/aorch-invest-analyst.{md,toml}`, `aorch-refactorer.{md,toml}`, `test/install.test.js`

- [x] invest-analyst — researcher가 모은 증거를 근거/반증/맹점 구조로 분석해 invest-judge 스킬의 결정 레코드 입력 형식으로 정리. 증거 수집·순위 매기기·매매 지시 금지, 불확실은 불확실로. 차단: `Write, Edit, NotebookEdit, Agent`, codex `read-only`
- [x] refactorer — 동작 보존 구조 정리만 직접 수행. 공개 API·동작 변경 발견 시 수정하지 말고 unresolvedRisks로 보고. 테스트를 verify로 신뢰하되 테스트 약화 금지. 차단: `Agent`
- [x] install 테스트: 4파일 설치, `tools:` 없음, invest-analyst만 편집 도구 차단
- [x] 검증: `node --test test/install.test.js`

### 작업 3: 템플릿 2종 + 스킬 안내

대상: `examples/plan-invest-evidence.json`, `examples/plan-refactor.json`, 두 `SKILL.md`

- [x] plan-invest-evidence: ① researcher 증거 수집(research/standard) ② invest-analyst 분석(risk-analysis/high, read-only) ③ reviewer 반박(교차 provider, review/high). 전부 write:false, 산출은 invest-judge 입력
- [x] plan-refactor: ① ponytail 축소 판정(read-only) ② refactorer 실행(implementation/standard, write, 테스트 명령 verify, linked worktree 전제 — 코드 저장소는 node_modules 문제가 프로젝트별이므로 allowInPlaceWrite는 채우는 쪽이 결정) ③ reviewer 검토(교차)
- [x] 두 SKILL.md에 각 한 문단 (기존 패턴)
- [x] 검증: decompose ok + dry-run이 역할·티어 배정(②가 write, invest-analyst가 reviewer 축)

### 작업 4: 설치본 갱신

- [x] `install --target both --force-config` (aorch: progress 키 보존·복원) + 책 만들기 동일
- [x] `update --check` stale 0, 주식트레이더·study-agent config에 roleAgents 블록 없음(기본값 경로) 확인
- [x] 검증: 설치본 config 기준 dry-run 정상

## 완료 조건

- [x] `npm run check` 전체 통과
- [x] 두 템플릿 dry-run 정상 배정
- [x] 설치본 4곳 정상 (`update --check` stale 0)

## 도그푸딩 (명시적 이월)

- invest-analyst: 다음 실제 투자 판단(invest-judge 호출) 때 plan-invest-evidence로 자연 검증
- refactorer: 다음 실제 리팩토링 요청 때 자연 검증 — 합성 대상 리허설은 책 사례와 달리 실익 대비 비용이 큼
- review-interview(볼트): 다음 일요일 리뷰에서 사용자와 실사용 검증
