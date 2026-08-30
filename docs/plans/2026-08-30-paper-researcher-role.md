# paper-researcher 역할과 paper-search-mcp 주입

## 목표

aorch 13번째 역할 `paper-researcher`가 `paper-search-mcp` 서버를 통해 논문을 검색·수집하고, CS 주제 1개의 실제 run에서 서지 5편 이상·인용수·출처 도구명이 담긴 receipt를 내며 `npm run check`가 통과하면 완료.

## 접근

2026-08-30 인터뷰(6라운드 + 포니테일 점검 1회)로 확정한 설계. 역할은 기존 `researcher`와 같은 "수집만, 판단 금지" 규율을 논문 어휘로 치환하고 `executor`로 라우팅한다. MCP는 저장소에 체크인한 정적 mcp-config 하나를 `src/role-agent.js`가 역할명으로 하드코드 반환하고, `claude-cli.js`가 `--mcp-config`·`--strict-mcp-config`와 `mcp__paper-search__*` 허용목록을 덧붙인다. 범용 `roleAgents.*.mcpServers` 스키마·런타임 임시파일·analyst/license-reviewer 사전단계·외부 리포 프롬프트 차용·arxiv-mcp-server는 포니테일 판정으로 제외했다(전문은 WebFetch로 먼저, 실패 실측 시 arxiv-mcp-server 재검토). Codex MCP는 사용자 결정으로 스파이크를 유지한다.

사용자 확정 결정(재제안 금지): aorch 역할로 설치(볼트 아님) · 4분야 전부(CS/수학/생의학/전분야) · 검색·수집만 · receipt에 서지+인용관계+초록/한줄요약 · arXiv OA 전문은 요청 시에만 · 무키 시작 · 정적 JSON+하드코드 · fail-closed · Codex 스파이크 유지.

## 검증 명령

```bash
cd "C:/Users/goyan/OneDrive/문서/adaptive orchestrator"
npm run check                     # node scripts/check-syntax.mjs && node --test — 전부 통과
node --test test/config.test.js test/providers.test.js test/decompose.test.js test/task-runner.test.js
node src/cli.js decompose --plan examples/plan-paper-search.json   # exit 0
"C:/Users/goyan/.local/bin/claude.exe" mcp list                       # 등록 여부 확인용(전역 오염 없어야 함)
```

### 작업 0: 스파이크 — paper-search-mcp 실측

대상 파일: `docs/plans/2026-08-30-paper-researcher-role.md`(이 문서의 "스파이크 결과" 절에 기록)

- [ ] `uvx paper-search-mcp --help` 실행, 첫 기동 시간(초)과 exit code 기록
- [ ] 임시 mcp-config `C:/Users/goyan/.claude/jobs/35e2db0e/tmp/paper.mcp.json` 작성: `{"mcpServers":{"paper-search":{"command":"uvx","args":["paper-search-mcp"]}}}`
- [ ] `claude -p "List the MCP tools available to you by exact name, one per line. Do not call them." --mcp-config <위 경로> --strict-mcp-config --allowed-tools "mcp__paper-search__*" --output-format text --max-turns 3` 실행, 도구명 목록을 이 문서에 기록. 인용수(citation)를 돌려주는 도구가 있는지 명시
- [ ] 같은 방식으로 `claude -p "Search arXiv for 'LLM agent routing' and return the first 3 results as title|year|arxiv id|citation count if available."` 1회 호출 → 결과와 소요 시간 기록
- [ ] Codex 스파이크: `codex exec -c 'mcp_servers.paper-search.command="uvx"' -c 'mcp_servers.paper-search.args=["paper-search-mcp"]' --sandbox read-only --json - <<< "List the MCP tools available to you by exact name."` 실행. 도구가 보이면 "Codex MCP 가능", 오류/빈 목록이면 "Codex prompt-only" 로 이 문서에 기록. 작업 4의 분기는 이 기록으로 결정
- [ ] 검증: 이 문서 "스파이크 결과" 절에 기동시간·도구명 목록·인용 도구 유무·Codex 판정 4항목이 모두 채워짐. 인용 도구가 없으면 사용자에게 AskUserQuestion으로 arxiv-mcp-server 추가 여부를 묻고, 답 전까지 작업 2 이후 진행하지 않음

### 작업 1: 역할 등록

대상 파일: `src/config.js`, `src/decompose.js`, `config/aorch.config.json`, `test/config.test.js`, `test/decompose.test.js`

- [ ] `src/config.js` `AGENT_ROLE_KEYS`에 `'paper-researcher'` 추가, `DEFAULT_ROLE_AGENTS`에 `'paper-researcher': preset('aorch-paper-researcher')` 추가
- [ ] `src/decompose.js` `AGENT_ROLES`에 `'paper-researcher': 'executor'` 추가(주석: researcher와 같은 이유 — 증거를 생산하므로 executor)
- [ ] `config/aorch.config.json` `roleAgents`에 `"paper-researcher": {"claude": "aorch-paper-researcher", "codex": "aorch-paper-researcher"}` 추가
- [ ] `test/config.test.js`: 역할 키 목록을 검사하는 기존 테스트가 있으면 `paper-researcher`를 기대값에 추가, 없으면 "기본 roleAgents에 paper-researcher가 있고 양 어댑터가 aorch-paper-researcher를 가리킨다" 테스트 1개 추가
- [ ] `test/decompose.test.js`: `routingRoleFor('paper-researcher') === 'executor'` 단언 추가
- [ ] 검증: `node --test test/config.test.js test/decompose.test.js` 통과

### 작업 2: MCP 정적 설정과 주입 경로

대상 파일: `integrations/claude/mcp/paper-researcher.mcp.json`(신규), `src/role-agent.js`, `src/providers/claude-cli.js`, `src/task-runner.js`, `test/providers.test.js`, `test/task-runner.test.js`

- [ ] `integrations/claude/mcp/paper-researcher.mcp.json` 작성: `{"mcpServers":{"paper-search":{"command":"uvx","args":["paper-search-mcp"]}}}` (env 없음, 키 없음)
- [ ] `src/role-agent.js`: `ROLE_MCP` 상수 추가 — `{'paper-researcher': {configPath: path.join(PACKAGE_ROOT,'integrations','claude','mcp','paper-researcher.mcp.json'), allowedTools: ['mcp__paper-search__*']}}`. `resolveRoleAgent`의 claude 분기 반환값에 해당 역할이면 `mcpConfig`·`mcpTools`를 포함. 주석에 "하드코드인 이유: 소비자가 역할 1개, config에 command/env 표면을 열지 않기 위함(2026-08-30 포니테일 판정)" 기재
- [ ] `src/providers/claude-cli.js` `buildClaudeCommand`에 선택 인자 `mcpConfig`, `mcpTools = []` 추가. `mcpConfig`가 있으면 `--mcp-config <path>`, `--strict-mcp-config` 추가하고 `--allowed-tools` 목록에 `mcpTools`를 덧붙임. READ_TOOLS 위 주석의 "role-conditional allowlists" 문단 끝에 "MCP 서버는 프로세스 기동 비용과 실패점이 있어 이 원칙의 예외로, 역할 프리셋이 반환한 mcpTools에 한해 조건부로 허용한다"를 추가
- [ ] `src/task-runner.js` claude 분기에 `...(rolePreset.mcpConfig ? { mcpConfig: rolePreset.mcpConfig, mcpTools: rolePreset.mcpTools } : {})` 전달
- [ ] `test/providers.test.js`: (a) `mcpConfig` 없으면 args에 `--mcp-config`가 없다, (b) 있으면 `--mcp-config <path>`·`--strict-mcp-config`·`mcp__paper-search__*`가 `--allowed-tools` 뒤에 온다 — 2개 단언. 180행 부근 "web tools go to every role" 테스트는 그대로 통과해야 함
- [ ] `test/task-runner.test.js`: `agentRole: 'paper-researcher'` 태스크의 claude commandSpec에 `--mcp-config`가 포함되고 `agentRole: 'researcher'`에는 없다는 테스트 1개
- [ ] 검증: `node --test test/providers.test.js test/task-runner.test.js` 통과

### 작업 3: fail-closed — MCP 기동 실패 시 blocked

대상 파일: `src/task-runner.js` 또는 `src/dispatch.js`(receiptVerdict 근처), `integrations/claude/agents/aorch-paper-researcher.md`, `test/dispatch.test.js`

- [ ] 에이전트 프롬프트에 명시: "mcp__paper-search__* 도구가 하나도 보이지 않으면 검색을 시도하지 말고 receipt `status: blocked`, `summary`에 'paper-search MCP unavailable'을 적고 종료한다. WebSearch/WebFetch로 대체하지 않는다"
- [ ] `test/dispatch.test.js`: `status: blocked` receipt가 run을 중단시키는 기존 테스트(커밋 adb06ee)가 paper-researcher 태스크에도 동일 적용됨을 확인하는 단언 1개(역할과 무관하게 동작하면 기존 테스트 인용으로 대체하고 이 단계를 "기존 커버"로 체크)
- [ ] 검증: `node --test test/dispatch.test.js` 통과

### 작업 4: 에이전트 프리셋 2종

대상 파일: `integrations/claude/agents/aorch-paper-researcher.md`, `integrations/codex/agents/aorch-paper-researcher.toml`

- [ ] `aorch-paper-researcher.md` 작성 — frontmatter: `name`, `description: Searches academic sources through the paper-search MCP and records verifiable bibliographic evidence without ranking.`, `disallowedTools: Write, Edit, NotebookEdit, Agent`, `maxTurns: 40`. 본문은 `aorch-researcher.md` 규율을 논문 어휘로 치환: (1) 주제를 하위 질의 3~5개로 나눠 소스별로 검색, (2) 논문마다 제목·저자·연도·DOI 또는 arXiv ID·URL·인용수·피인용/인용 관계·초록 원문(없으면 한 줄 요약이라 표시)·각 사실을 돌려준 MCP 도구명 기록, (3) 순위·추천·품질 판단 금지, (4) 제외한 논문과 이유 기록, (5) 확인 안 되는 사실은 미해결로, (6) arXiv 전문은 태스크가 명시 요청할 때만 WebFetch로 abs/pdf URL 시도, (7) 작업 3의 blocked 규칙, (8) 위임·파일 수정 금지
- [ ] `aorch-paper-researcher.toml` 작성 — `name`, `description`, `sandbox_mode = "read-only"`, `developer_instructions`에 md 본문과 같은 규율. 작업 0의 Codex 판정이 "prompt-only"면 첫 줄에 "This Codex preset has no MCP access; if no paper-search tools are available report status blocked"를 명기
- [ ] 작업 0 판정이 "Codex MCP 가능"일 때만: `src/providers/codex-cli.js` `buildCodexCommand`에 `mcpConfig` 인자 추가 → JSON을 읽어 `-c mcp_servers.<name>.command=...`, `-c mcp_servers.<name>.args=[...]`로 변환, `src/role-agent.js` codex 분기도 `mcpConfig` 반환, `test/providers.test.js`에 단언 1개. "prompt-only"면 이 단계는 "스파이크 결과로 제외"로 체크
- [ ] 검증: `node src/cli.js install --dry-run` 또는 동등 명령으로 두 프리셋이 설치 대상에 잡히는지 확인(install 명령 옵션은 `src/cli.js` 확인 후 사용); `node --test test/install.test.js` 통과

### 작업 5: 예시 플랜과 문서

대상 파일: `examples/plan-paper-search.json`, `integrations/claude/skills/adaptive-orchestrate/SKILL.md`, `CHANGELOG.md`

- [ ] `examples/plan-paper-search.json` 작성 — `plan-invest-evidence.json` 형식. 태스크 2개: `P1-search`(kind `research`, agentRole `paper-researcher`, complexity `standard`, write false, acceptanceCriteria: "≥5 records each with title, authors, year, DOI or arXiv id, URL, citation count, and the MCP tool that returned it", "abstract or a flagged one-line summary per record", "excluded papers listed with reasons", "nothing ranked or recommended"), `P2-refute`(kind `review`, agentRole `reviewer`, allowedProviders를 다른 프로바이더로 고정, objective: P1 레코드의 서지 사실을 원출처로 대조)
- [ ] `SKILL.md` "Borrowing from an open-source project" 절 뒤에 "### Searching the literature" 절 추가: `examples/plan-paper-search.json` 복사 지시, paper-researcher는 수집만·판단은 reviewer/analyst, MCP는 역할 프리셋이 주입하므로 플랜이 서버를 지정하지 않음, MCP 불가 시 blocked로 멈춤, Codex 지원 여부는 작업 0 판정대로 기재
- [ ] `CHANGELOG.md` Unreleased/Added에 항목: `paper-researcher` 역할 + 역할 프리셋이 `--mcp-config`를 주입하는 첫 사례, READ_TOOLS 전역 원칙의 예외임을 명시
- [ ] 검증: `node src/cli.js decompose --plan examples/plan-paper-search.json` exit 0; `grep -c "paper-researcher" integrations/claude/skills/adaptive-orchestrate/SKILL.md CHANGELOG.md` 각 ≥1

### 작업 6: 도그푸딩 — CS 주제 1회 실 run

대상 파일: `docs/plans/2026-08-30-paper-researcher-role.md`("도그푸딩 결과" 절)

- [ ] `.aorch` 설치본이 저장소보다 우선하는 함정(메모 aorch-wide-tiers) 확인: `aorch install` 또는 동등 명령으로 새 프리셋·역할 맵을 설치본에 반영
- [ ] `examples/plan-paper-search.json`을 복사해 주제를 "LLM agent difficulty-aware model routing"으로 채우고 `aorch dispatch`(또는 `aorch exec`) 실행
- [ ] P1 receipt 검사: 레코드 ≥5, 각 레코드에 인용수와 `mcp__paper-search__*` 도구명, 제외 목록 존재. 미달이면 프롬프트/turn 예산 조정 후 1회 재실행하고 조정 내용 기록
- [ ] 소요 시간·모델·receipt 경로를 이 문서 "도그푸딩 결과" 절에 기록
- [ ] 검증: `npm run check` 전부 통과; receipt 파일이 위 3조건을 만족

## 스파이크 결과

(작업 0에서 채움: 기동시간 / 도구명 목록 / 인용 도구 유무 / Codex 판정)

## 도그푸딩 결과

(작업 6에서 채움)

## 이월

- arxiv-mcp-server 추가: WebFetch로 arXiv 전문 확보가 실패한다고 실측되거나 paper-search-mcp에 인용 도구가 없을 때만
- 무료 키(Semantic Scholar·NCBI) 발급: rate limit이 receipt 품질을 떨어뜨린다고 관측될 때
- 범용 `roleAgents.*.mcpServers` 스키마: MCP를 쓰는 두 번째 역할이 생길 때
