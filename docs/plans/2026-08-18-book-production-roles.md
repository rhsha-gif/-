# 책 제작 역할군: writer / editor / qa-analyst + kind `writing`

## 목표

책 제작의 장 단위 파이프라인(집필→편집→QA)이 aorch dispatch로 돌고, 집필은 최상위 티어로·편집은 중간 티어로·QA 판정은 저가 티어로 라우팅되며, 실제 책 한 장으로 도그푸딩이 통과하면 끝.

## 접근

A안(단계별 최소 확장): 이번 계획은 책 슬라이스 3역할만 추가한다 — 볼트·투자·코딩 역할은 이 계획의 도그푸딩 게이트 통과 후 별도 계획으로. 프리셋은 역할 경계·receipt 계약만 담고 집필·검토 절차는 책 워크스페이스의 기존 스킬(`page-manuscript-writer`, `manuscript-writing-review`, `book-production-qa`)을 호출한다. 산문 작업의 라우팅 공백은 kind `writing` 신설로 메운다 — 스키마의 kind는 자유 문자열이므로 config 프로필의 `kinds` 배열 확장만으로 성립한다.

인터뷰 확정 사항(2026-08-17): 집필=최고지능, 조판검수=명령이 일하고 저가 에이전트가 판정, 편집자=문장·표현·오탈자만 직접 수정, 집필·편집 교차 provider 권장, 장은 quickqa·마일스톤만 full qa, QA 시각 검토는 변경 페이지+기계 선별 의심 페이지만, 진입점은 계획 템플릿+coordinator 안내 문단.

## 검증 명령

```bash
# aorch 저장소 (이 저장소, package.json scripts가 규약)
npm run check                      # node scripts/check-syntax.mjs && node --test
node --test test/<파일>.test.js    # 슬라이스별

# 책 만들기 워크스페이스 (C:/Users/goyan/OneDrive/문서/책 만들기, AGENTS.md가 규약)
npm run test:skills                # 스킬 패키지 구조 검증
npm run book:check -- --book books/<book-id>
```

### 작업 1: agentRole 3종 신설 (배선)

대상 파일: `src/decompose.js`, `src/config.js`, `schemas/task-plan.schema.json`, `config/aorch.config.json`, `test/decompose.test.js`, `test/config.test.js`

- [x] `src/decompose.js`의 `AGENT_ROLES`(12행)를 10개로 확장: `writer→executor`, `editor→executor`, `qa-analyst→reviewer` 추가. qa-analyst가 reviewer 파생인 이유는 판정 역할이기 때문(ponytail과 동일 논리)
- [x] `schemas/task-plan.schema.json`의 `agentRole` enum(45행)에 3종 추가, `description`에 각 한 줄: writer=장·페이지 단위 원고 집필(최상위 티어), editor=문장·표현·오탈자만 직접 수정하는 편집(내용·구조는 판정만), qa-analyst=기계 검사 산출을 읽고 판정문만 쓰는 조판 검수
- [x] `src/config.js`의 `AGENT_ROLE_KEYS`·`DEFAULT_ROLE_AGENTS`를 10개로 확장 — 기본 에이전트명 `aorch-writer`, `aorch-editor`, `aorch-qa-analyst`
- [x] `config/aorch.config.json`의 `roleAgents`에 3종 추가(claude·codex 양쪽)
- [x] `test/decompose.test.js`·`test/config.test.js` 단언을 10개 매핑으로 갱신
- [x] 검증: `node --test test/decompose.test.js test/config.test.js` 통과

### 작업 2: kind `writing` 신설 (라우팅)

대상 파일: `config/aorch.config.json`, `schemas/task-plan.schema.json`, `test/config.test.js` 또는 `test/router.test.js`

- [x] `config/aorch.config.json`의 `models`에서 다음 5개 프로필의 `kinds` 배열에 `"writing"` 추가: `claude-fable-apex`, `claude-opus-deep`, `codex-sol-deep`(최상위 — 집필), `claude-sonnet-general`, `codex-terra-general`(중간 — 편집). haiku·luna에는 추가하지 않는다 — 저가 티어가 원고를 잡는 것을 구조적으로 차단
- [x] `schemas/task-plan.schema.json`의 `kind` description 예시 목록에 `writing` 추가 (자유 문자열이므로 enum 변경 없음)
- [x] `test/router.test.js`에 단언 추가: kind `writing` + complexity `high`는 최상위 3프로필(fable-apex/opus-deep/sol-deep) 중 하나로, `standard`는 sonnet/terra로 라우팅되고, complexity `low`는 eligible route가 없어 거부된다
- [x] 검증: `node --test test/router.test.js test/config.test.js` 통과

### 작업 3: 프리셋 6파일 작성

대상 파일: `integrations/claude/agents/aorch-writer.md`, `aorch-editor.md`, `aorch-qa-analyst.md` 및 `integrations/codex/agents/` 대응 `.toml` 3종, `test/install.test.js`

공통 규칙: `tools:` 프론트매터 금지(receipt 죽음, 08-17 실측), 절차 복제 금지 — 책 워크스페이스 스킬을 지시.

> **실행 중 조정**: 책 스킬은 `.agents/skills/`(Codex 관례)에만 있고 Claude 네이티브 스킬로 노출돼 있지 않아, `capabilityIds` 경로는 워커가 blocked를 반환할 위험이 있다. 프리셋이 **작업 디렉터리의 `.agents/skills/<name>/SKILL.md`를 읽고 따르라**고 지시하는 방식으로 변경 — 양 provider 공통, 추가 배선 불필요, 절차 재사용 합의는 유지.

- [x] `aorch-writer` — 임무: 지정된 장/페이지 원고 집필. task의 `capabilities.skills`로 전달되는 `page-manuscript-writer` 스킬을 절차로 사용하라고 지시. 출처·인용·통계 날조 금지(책 AGENTS.md 금지사항)를 경계로 명시. `disallowedTools: Agent`, `maxTurns: 80`
- [x] `aorch-editor` — 임무: 직전 집필 산출의 문장·표현·오탈자만 직접 수정. **내용·구조·사실 관계 변경은 수정하지 말고 receipt의 unresolvedRisks에 판정으로 남긴다**(집필 task로 되돌릴 입력). `manuscript-writing-review` 스킬을 검토 기준으로 사용. `disallowedTools: Agent`, `maxTurns: 60`
- [x] `aorch-qa-analyst` — 임무: `book:quickqa`/`book:qa`가 이미 계산한 산출(qa-report.json, digest 감사, 스크린샷)을 읽고 판정문만 쓴다. **시각 검토는 (a) digest 대조로 변경된 페이지와 (b) 기계 지표가 의심 표시한 페이지만** 연다. 불확실한 페이지는 직접 판정하지 말고 unresolvedRisks에 페이지 번호와 사유를 남겨 상위 티어 후속 task의 입력으로 넘긴다(2단 escalation). `disallowedTools: Write, Edit, NotebookEdit, Agent`, `maxTurns: 40`
- [x] `test/install.test.js` 단언 추가: 신규 3종이 claude·codex 양쪽에 설치되고, `^tools:`가 없고, 전부 `^disallowedTools:`를 가지며, qa-analyst에만 `Write, Edit`가 차단 목록에 있다
- [x] 검증: `node --test test/install.test.js` 및 `npm run check` 통과

### 작업 4: 장 단위 계획 템플릿

대상 파일: `examples/plan-book-chapter.json`, `integrations/claude/skills/adaptive-orchestrate/SKILL.md`, `integrations/codex/skills/adaptive-orchestrate/SKILL.md`

- [x] `examples/plan-book-chapter.json` 작성 — 3 task 순서대로: ① `writer` 집필(`kind: writing`, `complexity: high`, `write: true`, `verificationCommands: ["npm run book:check -- --book books/<book-id>"]`, `capabilityIds`에 page-manuscript-writer) ② `editor` 편집(`kind: writing`, `complexity: standard`, `write: true`, 같은 book:check, objective에 "집필과 다른 provider가 맡도록 allowedProviders를 채우라"는 사용 안내 주석을 objective 문장으로) ③ `qa-analyst` 검수(`kind: log-analysis`, `complexity: low`, `write: false`, `verificationCommands: ["npm run book:quickqa -- --book books/<book-id>"]`) — full `book:qa`는 템플릿에 넣지 않고 마일스톤 수동 실행으로 명시
- [x] 세 task의 `allowedScope`를 `books/<book-id>/**`로, `forbiddenScope`를 `tools/**`·`.agents/**`로 선언
- [x] 두 SKILL.md에 한 문단 추가: 책 장 제작 요청이 오면 이 템플릿을 복사해 book-id를 채워 dispatch하라는 지시와 경로
- [x] 검증: `node src/cli.js decompose --plan examples/plan-book-chapter.json`이 `ok: true, taskCount: 3` 출력, `node src/cli.js dispatch --plan examples/plan-book-chapter.json --dry-run`이 ①을 최상위 프로필로 ③을 haiku/luna급으로 배정

### 작업 5: 설치본 갱신과 책 워크스페이스 안내

대상 파일: 없음(배포) + `C:/Users/goyan/OneDrive/문서/책 만들기/.agents/skills/book-production-coordinator/SKILL.md`

- [x] `node src/cli.js install --target both`로 로컬 설치본 갱신
- [x] `node src/cli.js update` 실행 — 책 만들기의 stale 설치본(현재 구버전 4종만 있음)도 함께 갱신됨. `update --check`가 `stale: 0` 보고
- [x] 책 만들기 coordinator SKILL.md에 한 문단 추가: 장 단위 제작을 aorch로 위임할 때 `plan-book-chapter.json` 템플릿을 쓰라는 안내와 aorch 설치 전제. 책 저장소 규약대로 커밋은 그쪽 관례를 따름
- [x] 검증: 책 워크스페이스에서 `npm run test:skills` 통과

### 작업 6: 도그푸딩 게이트 (다음 단계 착수 조건)

대상 파일: `docs/handoff/2026-08-18-book-roles-dogfood.md` (신규)

> **실행 중 조정**: ① 진행 중인 사람 작업(reading-english-poetry 미커밋 수정)과 분리하기 위해 실제 책 대신 픽스처 기반 합성 테스트 북 `books/aorch-dogfood`를 만들어 실행(사용자 승인). ② B3의 escalation 낭비 실측이 read-only fail-fast 불변식 구현으로 이어짐(`src/run-loop.js`, 계획 밖 추가 — 도그푸딩이 드러낸 결함의 즉시 수정). ③ 외부 중단 3회로 F1 receipt가 유실돼 잔여 8px 트림은 운영자가 직접 수행(handoff 문서에 명시).

**볼트·투자·코딩 역할 착수 조건이다. 여기서 실패하면 다음 단계를 시작하지 않는다.**

- [x] 책 만들기의 실제 책 하나(예: `books/reading-english-poetry`)에서 실제 미집필 장 또는 기존 장의 재집필 대상을 골라 템플릿을 채운다
- [x] `aorch dispatch` 실 실행 — 실행 중 책 저장소에서 커밋하지 않는다(HEAD 이동 시 guard 전체 반환, 08-17 실측)
- [x] 확인 항목: ① 세 task 모두 워커 receipt(`status`·`filesChanged`·`criteria` 존재) ② writer가 최상위 프로필, qa-analyst가 저가 프로필로 라우팅 ③ editor의 diff가 문장·표현 수준에 머무름(사람 검토) ④ `book:check`/`book:quickqa` verify 게이트 통과와 관측 기록 ⑤ change guard `claimed=actual`
- [x] qa-analyst의 시각 검토 페이지 수를 receipt에서 확인 — 전체 페이지 대비 유의미하게 적은지(변경+의심만 열었는지)가 QA 절감 설계의 성패 지표
- [x] 결과를 위 handoff 문서에 기록: 성공/실패, 증거 경로, 각 역할 라우팅 실측, QA 비용(검토 페이지 수·소요 시간), 드러난 결함
- [x] 검증: 문서가 존재하고 확인 항목 5개 각각에 실측 결과가 있음

## 완료 조건

- [x] `npm run check` 전체 통과 (aorch 저장소)
- [x] `dispatch --dry-run`이 3 task를 writer=최상위/editor=중간/qa-analyst=저가로 배정
- [x] 책 만들기 설치본에 신규 3종 포함(`update --check` stale 0) 및 `npm run test:skills` 통과
- [x] 도그푸딩 게이트(작업 6) 통과와 handoff 문서 존재

## 이 계획 밖 (후속 계획으로)

- 볼트 3종(math-verifier·review-interviewer·note-expander) + 볼트 aorch 설치 + daily/weekly `aorch exec` 배선 + Anki 오답 파일 계약 — 작업 6 통과 후
- invest-analyst(분석·종합 전담) + plan-invest-evidence 템플릿 — 볼트 단계 후
- refactorer(write 실행자, 동작 보존) — 볼트 단계 후
- full `book:qa` 마일스톤 실행의 자동화 여부 — 도그푸딩 결과 보고 재판단
