# 프로젝트 지도 오픈소스 탐색 (2026-09-03, aorch-researcher 2건)

## A. 분석(정리) 도구 — 검증 26개 중 핵심

| 필요 | Python | TypeScript | 언어 무관 |
|---|---|---|---|
| 의존 그래프 | pydeps (BSD-2, 2.1k, SVG/JSON, Graphviz 필요), grimp (BSD-2, Python API), tach (MIT, 2.8k, DOT/JSON/web) | dependency-cruiser (MIT, 7.1k, dot/svg/html/json/mermaid), madge (MIT, 10k, svg/dot/json, Graphviz) | graphify (Apache-2.0+MIT 혼재, tree-sitter, graph.json) |
| 핫스팟(크기×변경빈도) | — | — | scc (MIT, 8.7k, 단일 바이너리, git 히스토리 보고서 5종: hotspots·change coupling·bus factor, JSON/HTML), code-maat (GPLv3, Clojure JAR, CSV), hercules (Apache, Go) |
| 복잡도·함수 길이 | radon (MIT, `radon cc -j` JSON), wily (Apache, 시계열), ruff (MIT, 규칙) | — | scc(복잡도 추정) |
| 죽은 코드 | vulture (MIT, 4.8k, v2.16 2026-03) | knip (ISC, 12.2k, JSON), ts-prune(404) | jscpd (MIT, 6.1k, 중복, 15 포맷) |
| 테스트 대응 공백 | coverage.py + pytest-cov (JSON/HTML; 직접 매핑 도구는 없음 → import 기반 자체 계산 필요) | vitest coverage | — |
| 아키텍처 규칙 | import-linter (BSD-2, 계약 DSL, 브라우저 UI), tach | dependency-cruiser 규칙 DSL | — |

권장 최소 스택(리서처): Python radon+vulture+pydeps+coverage+import-linter, TS dependency-cruiser+knip+jscpd, 공통 scc(핫스팟·LOC).

## B. 시각화 도구

| 후보 | 라이선스/별/최근 | 입력 | 출력 | 판정 근거 |
|---|---|---|---|---|
| CodeCharta | BSD-3, 502, 2026-09-02 | 자체 `.cc.json`(tokei·code-maat·sonar·git log 임포트) | 3D 코드 도시(면적·높이·색=지표), 델타 뷰; npm CLI·바이너리·Docker·Web Studio | 정적 단일 HTML 내보내기 여부 미확인 |
| emerge | MIT, 1.1k, GH 2026-08 / PyPI 2024-08 | 소스 직접 스캔(Python·TS 포함) | 자체 완결 HTML(file://), 힘-방향 그래프+Louvain+히트맵, 트리맵 없음 | PyPI 릴리스 2년 정체 |
| git-truck | MIT, 775, 2026-08 | .git | 트리맵·원 패킹(최근성·저자·핫스팟 색), `npx -y git-truck` | 정적 파일 여부 미확인 |
| dependency-cruiser | MIT | JS/TS | self-containing html 포함 | Python 불가 |
| pydeps | BSD-2 | Python | SVG(hover 경로 강조) | Graphviz 설치 필요 |
| pyan (Technologicat) | GPL-2, 451, 2026-02 부활 | Python 정적 호출그래프 | dot/svg/html | 실행 흐름 후보 |
| graphify | 별 114k(구독자 388, 신뢰 불가), 2026-08-30 | tree-sitter | graph.html(힘-방향), callflow(Mermaid) | Mermaid는 500노드 미만에서 저하; `tree_html` 산출 미확인 |
| Sourcetrail/JSCity/softvis3d/pycallgraph | 아카이브·정체 | | | 제외 |

렌더링 라이브러리(cdnjs 가용 확인): D3 7.9.0, ECharts 6.1.0(graph·tree·treemap·sunburst 내장), Cytoscape.js 3.34.2, vis-network 10.1.2, sigma.js 3.0.3+graphology 0.26.0(수천 노드 WebGL), d3-graphviz 5.6.0, viz.js 2.1.2(구형만), Mermaid 11.15. d3-voronoi-treemap은 jsdelivr만·D3 v7 호환 미확인.

미해결: CodeCharta 정적 내보내기, git-truck 정적 여부, graphify 라이선스 범위·별 진위, 원조 CodeCity 소스 공개 여부.
