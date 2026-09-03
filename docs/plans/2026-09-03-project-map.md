# 프로젝트 지도 (project-map) v1 — QuantPilot 도그푸딩

## 목표

QuantPilot 저장소 하나를 스크립트 세 개(수집→병합→렌더)로 `map.json`과 자체 완결 HTML 대시보드 한 장으로 바꿔 아티팩트로 발행하고, 첫 실행의 문제 목록 상위 10개 중 사용자가 처음 보는 항목이 몇 개인지 기록하면 끝이다.

## 접근

2026-09-03 인터뷰 7라운드 + 포니테일 점검으로 확정(결정 12건은 아래 표). 구조 추출은 grimp(Python)·dependency-cruiser(TS)에, 핫스팟·복잡도는 scc에, 죽은 코드는 vulture에 맡기고 우리는 병합 규칙과 화면만 짓는다. 델타 뷰·독자 apply 로직·`aorch install` 배포는 v1에서 뺀다(포니테일 판정 수용). 문제 목록은 model-upgrade의 findings 스키마와 같은 모양으로 내보내 기존 선택→적용 흐름을 그대로 쓴다.

| # | 항목 | 결정 |
|---|---|---|
| 1 | 통증 | 구조를 모른다 + 부채가 어디 쌓이는지 모른다 |
| 2 | 첫 대상 | QuantPilot(`OneDrive/문서/코덱스/주식트레이더`) |
| 3 | 구조 | 모듈 의존 그래프(Python+TS 한 그래프) + 진입점(잡 6·라우터 13·페이지 11) 도달 경로를 grimp 그래프 질의로 |
| 4 | 부채 신호 | 크기×변경빈도 핫스팟, import 기준 테스트 공백, 죽은 코드, 복잡도는 scc 추정치 |
| 5 | 도구 | scc(winget `BenBoyter.scc`), grimp·vulture(전용 venv), dependency-cruiser(`npx -y`). radon·coverage.py·knip은 1회차 결과를 보고 |
| 6 | 시각화 | 자체 통합 대시보드 1장(ECharts 6.1.0 트리맵 + 의존 그래프 + 문제 패널), 아티팩트 발행. graphify 미사용 |
| 7 | 데이터 | `map.json` 하나(nodes·edges·problems). problems는 findings 스키마 호환 |
| 8 | 스냅샷 | 저장소 밖 `~/.local/share/aorch-tools/map/<project>/<날짜>.json`에 저장만. 델타 뷰 없음 |
| 9 | 이후 | problems → AskUserQuestion 선택 → `examples/plan-model-upgrade-apply.json` 재사용 |
| 10 | 위치 | aorch 저장소 `scripts/project-map/` + `configs/quantpilot.json`. 스킬화·배포는 후속 |
| 11 | 제외 | 옵시디언 내보내기, import-linter, CodeCharta, 함수 수준 호출 그래프 |
| 12 | 1회차 측정 | 문제 목록 상위 10개 중 처음 보는 항목 수 |

근거 파일: 오픈소스 탐색 메모(scratchpad `project-map-research.md`, 작업 0에서 `docs/plans/2026-09-03-project-map-research.md`로 복사).

## 검증 명령

aorch 저장소(`package.json`): `npm run check` — `node scripts/check-syntax.mjs && node --test`.
새 파이썬 스크립트는 전용 venv로 검증한다(작업 1에서 생성):

```bash
TOOLS="C:/Users/goyan/.local/share/aorch-tools/.venv/Scripts/python.exe"
"$TOOLS" -m pytest -q scripts/project-map/tests
"$TOOLS" scripts/project-map/collect.py --config scripts/project-map/configs/quantpilot.json --out "<snapshot>/raw"
"$TOOLS" scripts/project-map/merge.py --config scripts/project-map/configs/quantpilot.json --raw "<snapshot>/raw" --out "<snapshot>/map.json"
"$TOOLS" scripts/project-map/render.py --map "<snapshot>/map.json" --out "<snapshot>/dashboard.html"
```

`<snapshot>` = `C:/Users/goyan/.local/share/aorch-tools/map/quantpilot/<YYYY-MM-DD>`.

### 작업 0: 브랜치·문서·의존성 심사

대상 파일: `docs/plans/2026-09-03-project-map.md`, `docs/plans/2026-09-03-project-map-research.md`

- [x] `node src/cli.js branch status`로 codexss 클린 확인 → 이 문서를 codexss에 커밋(사용자 확인) → `worktree-project-map` 브랜치를 `.claude/worktrees/project-map`에 linked worktree로 생성
- [x] 탐색 메모를 `docs/plans/2026-09-03-project-map-research.md`로 복사(근거 보존)
- [x] `/dependency-audit`로 신규 의존성 4개 심사: grimp(BSD-2)·vulture(MIT)·scc(MIT)·dependency-cruiser(MIT). 통과해야 작업 1 진행
- [x] 검증: `git -C <worktree> branch --show-current` = `worktree-project-map`; 심사 결과가 이 문서 "실측" 절에 한 줄

### 작업 1: 전용 도구 환경

대상: `C:/Users/goyan/.local/share/aorch-tools/`(저장소 밖), `scripts/project-map/README.md`

- [x] `uv venv "C:/Users/goyan/.local/share/aorch-tools/.venv" --python 3.11` → `uv pip install --python <venv> grimp vulture pytest`
- [x] `winget install --id BenBoyter.scc --exact` → `scc --version` = 4.0.0
- [x] QuantPilot 웹 디렉터리에서 `npx -y dependency-cruiser --version` 1회(캐시 워밍)
- [x] `scripts/project-map/README.md`에 위 세 설치 명령과 venv 경로를 적는다(재프로비저닝용)
- [x] 검증: `<venv>/Scripts/python.exe -c "import grimp, vulture"` exit 0; `scc --version`; `npx -y dependency-cruiser --version` 출력

### 작업 2: 설정 파일과 map.json 스키마

대상: `scripts/project-map/configs/quantpilot.json`, `scripts/project-map/schema.json`

- [x] 설정 키를 고정한다: `project`("quantpilot"), `root`(절대 경로), `python.package`("quantpilot"), `python.src_dirs`(["quantpilot/packages","quantpilot/services","quantpilot/jobs"]), `python.test_dirs`(["quantpilot/tests"]), `python.entry_points`({"job":"quantpilot/jobs/*.py","router":"quantpilot/services/api/routers/*.py"}), `web.root`("quantpilot/apps/web"), `web.src`("src"), `web.entry_points`({"page":"src/pages/*.tsx"}), `exclude`(["quantpilot-foundation","quantpilot-foundation-meta","experiments","local_data","marketdata","node_modules",".venv"]), `churn_days`(180), `thresholds`({"big_file_lines":1500,"hotspot_top":10,"dead_confidence":80})
- [x] `schema.json`(JSON Schema draft 2020-12): `meta`{project, generated_at, tool_versions}, `nodes[]`{id, kind(py-module|ts-module), path, lines, complexity, churn, tested(bool), entry(string[]), dead(string[]), package}, `edges[]`{from, to, kind(import|cycle)}, `problems[]` = model-upgrade findings와 같은 7필드(id, severity, fixCost, axis, location, evidence, proposal) + `nodeId`. `additionalProperties: false`
- [x] 검증: `<venv>/Scripts/python.exe -c "import json; json.load(open('scripts/project-map/schema.json')); json.load(open('scripts/project-map/configs/quantpilot.json'))"` exit 0

### 작업 3: 수집기 `collect.py`

대상: `scripts/project-map/collect.py`, `scripts/project-map/tests/test_collect.py`, `scripts/project-map/tests/fixtures/`

- [x] 실행 결과를 `<out>/raw/` 아래 파일 5개로 남긴다: `scc.json`(`scc --format json --by-file <src_dirs+web.src>`), `churn.json`(`git log --since=<churn_days>.days --name-only --format=`를 파일별 카운트), `grimp.json`(`grimp.build_graph(package, include_external_packages=False)`의 modules·direct imports, 진입점 모듈 목록, 각 진입점의 `find_downstream_modules`, 각 소스 모듈의 `find_upstream_modules`∩tests), `vulture.json`(`vulture <src_dirs> --min-confidence 60` 텍스트 파싱: path, line, kind, name, confidence), `depcruise.json`(웹 루트에서 `NODE_PATH=<web>/node_modules npx -y -p dependency-cruiser@18.2.0 depcruise --no-config --output-type json --ts-config tsconfig.json --do-not-follow node_modules --exclude node_modules src`의 modules→dependencies)
- [x] 도구 하나가 실패하면 그 파일에 `{"error": "..."}`를 쓰고 exit 1 — 절반만 성공한 지도는 만들지 않는다(fail-closed)
- [x] grimp는 `sys.path`에 `root`를 넣고 `build_graph(package, include_external_packages=False, cache_dir=<out>/.grimp_cache)`로 실행하며 QuantPilot 의존성 import는 필요 없음(정적 파싱)을 주석으로 명시
- [x] 테스트: fixtures에 소형 파이썬 패키지(모듈 4개, 순환 1개, tests 1개)와 vulture·scc 출력 샘플을 두고, 파서 함수(churn 카운트, vulture 파싱, depcruise 변환)를 단위 테스트. 실제 도구 실행은 테스트하지 않는다
- [x] 검증: `<venv> -m pytest -q scripts/project-map/tests/test_collect.py` 통과; QuantPilot에 실행 시 `raw/` 5파일 생성·exit 0, `grimp.json`의 모듈 수가 `git ls-files 'quantpilot/packages/*.py' 'quantpilot/services/*.py' 'quantpilot/jobs/*.py' | wc -l`(=119)±5

### 작업 4: 병합기 `merge.py`

대상: `scripts/project-map/merge.py`, `scripts/project-map/tests/test_merge.py`

- [x] nodes: grimp 모듈과 depcruise 모듈을 경로 기준으로 합치고 scc(lines, complexity)·churn·tested·entry·dead를 붙인다. `package`는 경로 두 번째 세그먼트(예 `packages/core`)
- [x] edges: grimp direct imports + depcruise dependencies. 순환은 edge 목록에서 DFS로 찾아 `kind: "cycle"`로 표시(networkx 없이)
- [x] problems 규칙 6개(각각 id 접두사 고정): `hotspot-`(lines×churn 상위 `hotspot_top`, severity standard·fixCost high), `giant-`(lines > `big_file_lines`, standard·high), `untested-`(src 모듈 중 tests가 upstream에 없음, standard·standard), `cycle-`(순환 참여 모듈, high·standard), `dead-`(vulture confidence ≥ `dead_confidence`, low·low), `orphan-`(depcruise에서 아무도 import하지 않는 TS 모듈 중 pages 제외, low·low). axis는 hotspot·giant·cycle=overengineering, untested·dead·orphan=correctness. evidence에 수치, proposal에 한 문장
- [x] 출력을 `schema.json`으로 검증(간단한 자체 검증기: 필수 키·enum·additionalProperties)
- [x] 테스트: fixtures의 canned raw 5파일로 nodes 수·cycle edge 1건·untested 1건·hotspot 순서를 단언
- [x] 검증: `<venv> -m pytest -q scripts/project-map/tests/test_merge.py` 통과; QuantPilot `map.json` 생성·스키마 통과·problems ≥ 10

### 작업 5: 렌더러 `render.py` + `template.html`

대상: `scripts/project-map/render.py`, `scripts/project-map/template.html`, `scripts/project-map/tests/test_render.py`

- [x] `template.html`: `<title>`은 `<project> 지도`, `<script src="https://cdnjs.cloudflare.com/ajax/libs/echarts/6.1.0/echarts.min.js">` 하나(`integrity="sha384-…"`·`crossorigin="anonymous"`를 붙이고 해시는 설치 시 cdnjs 파일에서 `openssl dgst -sha384 -binary | openssl base64 -A`로 계산해 README에 기록), map.json은 `<script id="map" type="application/json">`으로 인라인. 외부 리소스는 그 스크립트 하나뿐(아티팩트 CSP)
- [x] 화면 3구역: (1) 트리맵 — 계층 root→package→file, value=lines, 색=churn(토글로 complexity), 클릭 시 오른쪽에 파일 지표·tested·dead 목록; (2) 의존 그래프 — 기본은 package 수준으로 접힌 노드, 클릭으로 펼침, `cycle` 엣지 빨강, 상단 셀렉트에서 진입점(job/router/page)을 고르면 grimp 도달 집합만 강조; (3) 문제 패널 — problems를 severity(critical>high>standard>low)·fixCost 순 표, 행 클릭 시 트리맵·그래프에서 해당 노드 강조
- [x] 라이트/다크 토큰(`:root`, `prefers-color-scheme`, `[data-theme]`) — 아티팩트 렌더 규칙
- [x] `render.py`는 템플릿에 JSON을 삽입만 한다(`</script>` 이스케이프 처리 포함)
- [x] 테스트: 소형 map.json으로 렌더한 HTML에 `id="map"`·echarts 스크립트 URL·문제 수만큼의 행 마커가 있는지, `</script>` 포함 문자열이 깨지지 않는지
- [x] 검증: `<venv> -m pytest -q scripts/project-map/tests/test_render.py` 통과; QuantPilot `dashboard.html` 생성, 크기 < 16MB

### 작업 6: 도그푸딩 — QuantPilot 1회차

대상: 이 문서 "실측" 절, 스냅샷 디렉터리

- [x] 검증 명령 절의 세 스크립트를 순서대로 실행(스냅샷 `<날짜>`), 소요 시간·도구 버전 기록
- [x] `dashboard.html`을 Artifact로 발행(favicon 🗺️, 이 세션에서 직접)하고 URL을 "실측" 절에 기록
- [x] problems 상위 10개를 표로 옮기고 AskUserQuestion(multiSelect)으로 "처음 보는 항목"을 고르게 해 개수를 기록 — 결정 12의 측정값
- [x] 화면 품질 판정도 함께 묻는다: 트리맵·그래프·문제 패널 각각 "그대로 / 손볼 것 / 빼도 됨"
- [x] 검증: "실측" 절에 아티팩트 URL, 처음 보는 항목 수, 화면 판정 3개가 적혀 있음

### 작업 7: 결정 유보 항목 판정과 이월

대상: 이 문서 "실측"·"이월" 절

- [x] radon: `uv pip install --python <venv> radon` 후 `radon cc -j`로 상위 10 핫스팟 파일의 복잡도 순위를 scc 순위와 비교. 순위 차이가 있으면 채택(작업 3 수집기에 추가), 없으면 제거. 결과 한 줄
- [x] knip: problems에 TS 죽은 코드가 실제로 떴는지(orphan 규칙만으로 부족한지) 판단해 채택/보류 한 줄
- [x] 처음 보는 항목 수가 0~2면 B안(기성 HTML+문제 패널)으로의 축소를 이월 절에 제안, 3 이상이면 후속 순서(델타 뷰 → `aorch-project-map` 스킬화·`aorch install` 배포 → study-agent 2번째 프로젝트)를 이월 절에 적는다
- [x] 문제 선택→적용은 이 계획 밖: 사용자가 고르면 `examples/plan-model-upgrade-apply.json`을 복사해 별도 실행
- [x] 검증: `npm run check` 통과(파이썬 스크립트가 JS 검사에 영향 없음), `<venv> -m pytest -q scripts/project-map/tests` 전부 통과, 이 문서 미체크 항목 0

## 실측

- 2026-09-03 의존성 심사 통과: grimp 3.16(BSD-2)·vulture 2.16(MIT)·scc 4.0.0(MIT, winget SHA=GitHub checksums 일치)·dependency-cruiser 18.2.0(MIT, 전이 43개 MIT/ISC) — OSV·npm audit 취약점 0건. 조건: grimp `cache_dir` 지정, 버전 고정, depcruise typescript 노출.
- 작업 1(10:50 KST): venv `~/.local/share/aorch-tools/.venv`(Python 3.11, grimp 3.16·vulture 2.16·pytest 9.1.1), scc 4.0.0(winget). 심사가 권한 `npx -p typescript@5.9.3 -p dependency-cruiser` 병행은 **실측 실패**(`--info`에 `x typescript`, `x .tsx`) — dependency-cruiser가 자기 위치 기준 require라 npx 임시 트리의 typescript를 못 찾는다. 대신 `NODE_PATH=<web>/node_modules`로 웹 프로젝트의 typescript 5.9.3을 노출하면 ✔(실제 파싱 1,107 모듈·tsx 35, node_modules를 따라가므로 수집기에서 `--do-not-follow node_modules`). scc `--by-file` JSON: Python 119파일(예상 119 일치)·TypeScript 47.
- 작업 3~5(15:07~15:31 KST, Codex sol high 3태스크 1회 통과, 워커 테스트 12): 리드 게이트 12 통과. QuantPilot 실제 수집 6초(scc 169파일·churn 569경로·grimp 213모듈·vulture 369건·depcruise). **리드가 잡은 결함 3건**: (1) 워커가 grimp의 upstream/downstream을 거꾸로 씀(grimp에서 upstream=내가 import하는 것, downstream=나를 import하는 것) → 테스트 판정 0/213, 진입점 도달 집합도 반대. 수정 후 소스 120개 중 97개 테스트 도달, 방향 고정 테스트 추가. (2) dependency-cruiser가 `@/` 별칭 177/189건 미해석 — paths가 `tsconfig.app.json`에 있음 → 설정 `web.ts_config` 추가, 미해석 5건으로, orphan 29→0. (3) 정렬이 핫스팟을 giant·untested 뒤로 밀어 카테고리 순서(hotspot·cycle·giant·untested·dead·orphan) 추가; orphan 규칙에서 테스트·d.ts·main.tsx 제외; 생성 파일(`openapi.d.ts`)을 설정 `generated`로 핫스팟·giant에서 제외. 최종: 노드 263(py 213·ts 50), 엣지 924(순환 6), 문제 23건(순환 5·핫스팟 10·거대 5·미검증 1·죽은 코드 2), 테스트 13 통과.
- 작업 5 리드 손질(15:35~15:45 KST): 디자인 스킬 기준으로 팔레트(파랑 기운 중립 + 청록 잉크 악센트, 심각도 의미색 4종, 변경빈도 램프 담청→주홍)·서체(IBM Plex Sans KR + IBM Plex Mono, Google Fonts)·심각도 칩·한국어 열 이름·ECharts SRI(`sha384-C2iskrW/…`)를 넣고, 아티팩트용 `--fragment` 모드(doctype·html·head·body·meta 제거) 추가. 테스트 14 통과. 외부 URL은 폰트 1·ECharts 1.
- **작업 6 발행(15:46 KST)**: 아티팩트 https://claude.ai/code/artifact/15416532-345b-40c6-8ed5-01a2965fc59c (버전 라벨 `2026-09-03 first run`, 스냅샷 `~/.local/share/aorch-tools/map/quantpilot/2026-09-03/`). 상위 10개 = 순환 5(core.data.external·kis_historical·providers, core.strategies.lifecycle_binding·registry) + 핫스팟 5(jobs.run_kis_paper_session, execution.paper_submission, harness_service, kis_paper, operator.position_ledger). 처음 보는 항목 수·화면 판정은 아래 사용자 답변.
- **1회차 측정(15:50 KST)**: 상위 10개 중 처음 보는 항목 **6~8개** → 장치 정당화(결정 12, 3 이상). 화면 판정: 트리맵·의존 그래프·문제 패널 셋 다 "손볼 것 있음"(세부는 후속 질문으로 수집).
- 작업 7 radon(15:55 KST, radon 6.0.1을 도구 venv에 추가): 핫스팟 파이썬 9파일에서 파일 합계 복잡도 순위는 scc와 상위 2개 동일, 9자리 중 5자리 상이(scc 3위 professional_cycle 398 vs radon 3위 position_ledger 496). 결정적 차이는 함수 단위: radon만 함수 최대 CC를 준다(position_ledger 115, professional_cycle 91, operator.service 81, sqlite_repositories 66). → **채택**: 다음 라운드에서 수집기에 `radon.json`(`radon cc -j -s`)을 추가하고 문제 규칙 `complex-<module>:<function>`(CC ≥ 30, standard/standard, overengineering)을 넣는다. scc 파일 복잡도는 트리맵 색으로 유지.
- 작업 7 knip: 별칭 해석 뒤 TS orphan 0건, TS 죽은 코드 신호가 문제 목록에 없음 → **보류**(사용자가 TS 쪽 부채를 느낄 때 추가).
- 작업 7 후속 순서: 처음 보는 항목 6~8개이므로 A안 유지. 순서 = 화면 손질(사용자 지적 3건) + radon 규칙 → 델타 뷰(두 번째 스냅샷 생기면) → `aorch-project-map` 스킬화·`aorch install` 배포 → 2번째 프로젝트(study-agent, TS만).

## 이월

- v1 제외 확정: 델타 뷰(스냅샷은 저장), `aorch-project-map` 스킬·`aorch install` 배포, 옵시디언 내보내기, import-linter 계층 규칙, CodeCharta, 함수 수준 호출 그래프(pyan·graphify callflow).
- 다른 프로젝트 적용 시 알려진 차이: study-agent는 Python 없음(TS만), 책 만들기는 코드보다 문서(951 md) — 설정 파일 스키마가 그대로 맞는지는 2번째 프로젝트에서 확인.
