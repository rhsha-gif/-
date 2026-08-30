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

- [x] `uvx paper-search-mcp --help` 실행, 첫 기동 시간(초)과 exit code 기록
- [x] 임시 mcp-config `C:/Users/goyan/.claude/jobs/35e2db0e/tmp/paper.mcp.json` 작성: `{"mcpServers":{"paper-search":{"command":"uvx","args":["paper-search-mcp"]}}}`
- [x] `claude -p "List the MCP tools available to you by exact name, one per line. Do not call them." --mcp-config <위 경로> --strict-mcp-config --allowed-tools "mcp__paper-search__*" --output-format text --max-turns 3` 실행, 도구명 목록을 이 문서에 기록. 인용수(citation)를 돌려주는 도구가 있는지 명시
- [x] 같은 방식으로 `claude -p "Search arXiv for 'LLM agent routing' and return the first 3 results as title|year|arxiv id|citation count if available."` 1회 호출 → 결과와 소요 시간 기록
- [x] Codex 스파이크: `codex exec -c 'mcp_servers.paper-search.command="uvx"' -c 'mcp_servers.paper-search.args=["paper-search-mcp"]' --sandbox read-only --json - <<< "List the MCP tools available to you by exact name."` 실행. 도구가 보이면 "Codex MCP 가능", 오류/빈 목록이면 "Codex prompt-only" 로 이 문서에 기록. 작업 4의 분기는 이 기록으로 결정
- [x] 검증: 이 문서 "스파이크 결과" 절에 기동시간·도구명 목록·인용 도구 유무·Codex 판정 4항목이 모두 채워짐. 인용 도구가 없으면 사용자에게 AskUserQuestion으로 arxiv-mcp-server 추가 여부를 묻고, 답 전까지 작업 2 이후 진행하지 않음 → 결정(08-30): 인용수만 수집, 인용 관계는 이월; 허용목록은 명시 열거

### 작업 1: 역할 등록

대상 파일: `src/config.js`, `src/decompose.js`, `config/aorch.config.json`, `schemas/task-plan.schema.json`(agentRole enum — 스카우트 보고와 달리 스키마가 역할을 열거함, 실행 중 발견), `test/config.test.js`, `test/decompose.test.js`, `test/cli-smoke.test.js`

- [x] `src/config.js` `AGENT_ROLE_KEYS`에 `'paper-researcher'` 추가, `DEFAULT_ROLE_AGENTS`에 `'paper-researcher': preset('aorch-paper-researcher')` 추가
- [x] `src/decompose.js` `AGENT_ROLES`에 `'paper-researcher': 'executor'` 추가(주석: researcher와 같은 이유 — 증거를 생산하므로 executor)
- [x] `config/aorch.config.json` `roleAgents`에 `"paper-researcher": {"claude": "aorch-paper-researcher", "codex": "aorch-paper-researcher"}` 추가
- [x] `test/config.test.js`: 역할 키 목록을 검사하는 기존 테스트가 있으면 `paper-researcher`를 기대값에 추가, 없으면 "기본 roleAgents에 paper-researcher가 있고 양 어댑터가 aorch-paper-researcher를 가리킨다" 테스트 1개 추가
- [x] `test/decompose.test.js`: `routingRoleFor('paper-researcher') === 'executor'` 단언 추가
- [x] 검증: `node --test test/config.test.js test/decompose.test.js` 통과

### 작업 2: MCP 정적 설정과 주입 경로

대상 파일: `integrations/claude/mcp/paper-researcher.mcp.json`(신규), `src/role-agent.js`, `src/providers/claude-cli.js`, `src/task-runner.js`, `test/providers.test.js`, `test/task-runner.test.js`

- [x] `integrations/claude/mcp/paper-researcher.mcp.json` 작성: `{"mcpServers":{"paper-search":{"command":"uvx","args":["paper-search-mcp"]}}}` (env 없음, 키 없음)
- [x] `src/role-agent.js`: `ROLE_MCP` 상수 추가 — `{'paper-researcher': {configPath: path.join(PACKAGE_ROOT,'integrations','claude','mcp','paper-researcher.mcp.json'), allowedTools: [search_* 22개·read_*_paper 16개·get_crossref_paper_by_doi·download_arxiv 를 명시 열거 — download_scihub 등 타 다운로드 차단(08-30 결정)]}}`. `resolveRoleAgent`의 claude 분기 반환값에 해당 역할이면 `mcpConfig`·`mcpTools`를 포함. 주석에 "하드코드인 이유: 소비자가 역할 1개, config에 command/env 표면을 열지 않기 위함(2026-08-30 포니테일 판정)" 기재
- [x] `src/providers/claude-cli.js` `buildClaudeCommand`에 선택 인자 `mcpConfig`, `mcpTools = []` 추가. `mcpConfig`가 있으면 `--mcp-config <path>`, `--strict-mcp-config` 추가하고 `--allowed-tools` 목록에 `mcpTools`를 덧붙임. READ_TOOLS 위 주석의 "role-conditional allowlists" 문단 끝에 "MCP 서버는 프로세스 기동 비용과 실패점이 있어 이 원칙의 예외로, 역할 프리셋이 반환한 mcpTools에 한해 조건부로 허용한다"를 추가
- [x] `src/task-runner.js` claude 분기에 `...(rolePreset.mcpConfig ? { mcpConfig: rolePreset.mcpConfig, mcpTools: rolePreset.mcpTools } : {})` 전달
- [x] `test/providers.test.js`: (a) `mcpConfig` 없으면 args에 `--mcp-config`가 없다, (b) 있으면 `--mcp-config <path>`·`--strict-mcp-config`·명시 열거된 mcp 도구가 `--allowed-tools` 뒤에 오고 `mcp__paper-search__download_scihub`는 없다 — 2개 단언. 180행 부근 "web tools go to every role" 테스트는 그대로 통과해야 함
- [x] `test/task-runner.test.js`: `agentRole: 'paper-researcher'` 태스크의 claude commandSpec에 `--mcp-config`가 포함되고 `agentRole: 'researcher'`에는 없다는 테스트 1개
- [x] 검증: `node --test test/providers.test.js test/task-runner.test.js` 통과

### 작업 3: fail-closed — MCP 기동 실패 시 blocked

대상 파일: `src/task-runner.js` 또는 `src/dispatch.js`(receiptVerdict 근처), `integrations/claude/agents/aorch-paper-researcher.md`, `test/dispatch.test.js`

- [x] 에이전트 프롬프트에 명시: "mcp__paper-search__* 도구가 하나도 보이지 않으면 검색을 시도하지 말고 receipt `status: blocked`, `summary`에 'paper-search MCP unavailable'을 적고 종료한다. WebSearch/WebFetch로 대체하지 않는다"
- [x] `test/dispatch.test.js`: `status: blocked` receipt가 run을 중단시키는 기존 테스트(커밋 adb06ee)가 paper-researcher 태스크에도 동일 적용됨을 확인하는 단언 1개(역할과 무관하게 동작하면 기존 테스트 인용으로 대체하고 이 단계를 "기존 커버"로 체크) → 기존 커버: `test/run-loop.test.js:536` "a blocked receipt returns to the human"이 역할 무관하게 중단을 검증함. dispatch.test.js에는 resolveRoleAgent의 MCP 반환 단언을 추가
- [x] 검증: `node --test test/dispatch.test.js` 통과

### 작업 4: 에이전트 프리셋 2종

대상 파일: `integrations/claude/agents/aorch-paper-researcher.md`, `integrations/codex/agents/aorch-paper-researcher.toml`

- [x] `aorch-paper-researcher.md` 작성 — frontmatter: `name`, `description: Searches academic sources through the paper-search MCP and records verifiable bibliographic evidence without ranking.`, `disallowedTools: Write, Edit, NotebookEdit, Agent`, `maxTurns: 40`. 본문은 `aorch-researcher.md` 규율을 논문 어휘로 치환: (1) 주제를 하위 질의 3~5개로 나눠 소스별로 검색, (2) 논문마다 제목·저자·연도·DOI 또는 arXiv ID·URL·인용수·피인용/인용 관계·초록 원문(없으면 한 줄 요약이라 표시)·각 사실을 돌려준 MCP 도구명 기록, (3) 순위·추천·품질 판단 금지, (4) 제외한 논문과 이유 기록, (5) 확인 안 되는 사실은 미해결로, (6) arXiv 전문은 태스크가 명시 요청할 때만 WebFetch로 abs/pdf URL 시도, (7) 작업 3의 blocked 규칙, (8) 위임·파일 수정 금지
- [x] `aorch-paper-researcher.toml` 작성 — `name`, `description`, `sandbox_mode = "read-only"`, `developer_instructions`에 md 본문과 같은 규율. 작업 0의 Codex 판정이 "prompt-only"면 첫 줄에 "This Codex preset has no MCP access; if no paper-search tools are available report status blocked"를 명기
- [x] 작업 0 판정이 "Codex MCP 가능"일 때만: `src/providers/codex-cli.js` `buildCodexCommand`에 `mcpConfig` 인자 추가 → JSON을 읽어 `-c mcp_servers.<name>.command=...`, `-c mcp_servers.<name>.args=[...]`로 변환, `src/role-agent.js` codex 분기도 `mcpConfig` 반환, `test/providers.test.js`에 단언 1개. "prompt-only"면 이 단계는 "스파이크 결과로 제외"로 체크 → 판정 "Codex MCP 가능"이라 구현함(codex-cli.js `mcpServers` → `-c` 오버라이드, role-agent codex 분기가 JSON을 읽어 반환)
- [x] 검증: install은 `integrations/*/agents` 디렉터리를 통째로 복사하므로(`src/install.js`) 새 프리셋이 자동 포함됨; `node --test test/install.test.js` 통과

### 작업 5: 예시 플랜과 문서

대상 파일: `examples/plan-paper-search.json`, `integrations/claude/skills/adaptive-orchestrate/SKILL.md`, `CHANGELOG.md`

- [x] `examples/plan-paper-search.json` 작성 — `plan-invest-evidence.json` 형식. 태스크 2개: `P1-search`(kind `research`, agentRole `paper-researcher`, complexity `standard`, write false, acceptanceCriteria: "≥5 records each with title, authors, year, DOI or arXiv id, URL, citation count (openalex/crossref; arxiv returns 0 and semantic may return empty), and the MCP tool that returned it", "abstract or a flagged one-line summary per record", "excluded papers listed with reasons", "nothing ranked or recommended"), `P2-refute`(kind `review`, agentRole `reviewer`, allowedProviders를 다른 프로바이더로 고정, objective: P1 레코드의 서지 사실을 원출처로 대조)
- [x] `SKILL.md` "Borrowing from an open-source project" 절 뒤에 "### Searching the literature" 절 추가: `examples/plan-paper-search.json` 복사 지시, paper-researcher는 수집만·판단은 reviewer/analyst, MCP는 역할 프리셋이 주입하므로 플랜이 서버를 지정하지 않음, MCP 불가 시 blocked로 멈춤, Codex 지원 여부는 작업 0 판정대로 기재
- [x] `CHANGELOG.md` Unreleased/Added에 항목: `paper-researcher` 역할 + 역할 프리셋이 `--mcp-config`를 주입하는 첫 사례, READ_TOOLS 전역 원칙의 예외임을 명시
- [x] 검증: `node src/cli.js decompose --plan examples/plan-paper-search.json` exit 0; `grep -c "paper-researcher" integrations/claude/skills/adaptive-orchestrate/SKILL.md CHANGELOG.md` 각 ≥1

### 작업 6: 도그푸딩 — CS 주제 1회 실 run

대상 파일: `docs/plans/2026-08-30-paper-researcher-role.md`("도그푸딩 결과" 절)

- [x] `.aorch` 설치본이 저장소보다 우선하는 함정(메모 aorch-wide-tiers) 확인: `aorch install` 또는 동등 명령으로 새 프리셋·역할 맵을 설치본에 반영 → 실측: 설치 없이 dispatch하면 Claude CLI가 `--agent 'aorch-paper-researcher' not found`로 2초 만에 exit 1(워크트리에 `.claude/agents`가 없어 상위 체크아웃의 구 설치본을 읽음). `node src/cli.js install --project . --target both --force-config`로 해결
- [ ] `examples/plan-paper-search.json`을 복사해 주제를 "LLM agent difficulty-aware model routing"으로 채우고 `aorch dispatch`(또는 `aorch exec`) 실행
- [ ] P1 receipt 검사: 레코드 ≥5, 각 레코드에 인용수와 `mcp__paper-search__*` 도구명, 제외 목록 존재. 미달이면 프롬프트/turn 예산 조정 후 1회 재실행하고 조정 내용 기록
- [ ] 소요 시간·모델·receipt 경로를 이 문서 "도그푸딩 결과" 절에 기록
- [ ] 검증: `npm run check` 전부 통과; receipt 파일이 위 3조건을 만족

## 스파이크 결과 (2026-08-30 실측)

- 기동시간: `uvx paper-search-mcp` 첫 실행 49초(86개 패키지 설치 포함, exit 0), 캐시 후 3초. CORE 키 없음 경고 1줄(무해).
- Claude 주입: `claude -p ... --mcp-config paper.mcp.json --strict-mcp-config --allowed-tools "mcp__paper-search__*"` 28초에 도구 76개 인식. 도구군: `search_<source>` 22개(arxiv, semantic, openalex, crossref, pubmed, pmc, europepmc, biorxiv, medrxiv, dblp, core, base, doaj, hal, iacr, openaire, ssrn, unpaywall, zenodo, citeseerx, google_scholar, `search_papers` 통합), `download_<source>` 19개(**`download_scihub` 포함**), `read_<source>_paper` 16개, `get_crossref_paper_by_doi`.
- 반환 스키마(전 소스 공통 15필드): `paper_id, title, authors, abstract, doi, published_date, pdf_url, url, source, updated_date, categories, keywords, citations, references, extra`. `year` 필드 없음(`published_date`에서 추출).
- 인용 도구 유무: **인용수는 있음** — `search_openalex` `citations: 3689`, `search_crossref` `citations: 2` 실측. `search_arxiv`는 항상 `citations: 0`. `search_semantic`은 무키 상태에서 오류 없이 `{"result": []}`(정확한 제목 "RouteLLM"도 0건 — rate limit 또는 키 부재). **인용 관계(`references`)는 모든 소스에서 빈 문자열** → receipt의 "피인용 관계"는 이 서버로 충족 불가.
- 관련성: OpenAlex는 인용수 순에 가까운 결과(주제 무관 논문 상위), Crossref는 주제 적합. 프롬프트에 "소스별 특성·0건은 실패 아님·다른 소스 폴백" 명시 필요.
- Codex 판정: **Codex MCP 가능.** `codex exec -c 'mcp_servers.paper-search.command="uvx"' -c 'mcp_servers.paper-search.args=["paper-search-mcp"]' --sandbox read-only --json -`로 도구 인식. 도구명은 `mcp__paper_search__*`(하이픈→밑줄). 200초 소요 — 전역 `codex_apps`·`chrome_devtools` MCP가 함께 로드된 탓, 모델 캐시 경고(`missing field base_instructions`) 2줄은 무관.

## 도그푸딩 결과

(작업 6에서 채움)

## 이월

- arxiv-mcp-server 추가: 인용 관계(피인용 목록)가 필요해질 때 — paper-search-mcp는 `references`를 전 소스에서 비워 돌려준다(08-30 실측). WebFetch 전문 실패 시에도 재검토
- 무료 키(Semantic Scholar·NCBI) 발급: rate limit이 receipt 품질을 떨어뜨린다고 관측될 때
- 범용 `roleAgents.*.mcpServers` 스키마: MCP를 쓰는 두 번째 역할이 생길 때
