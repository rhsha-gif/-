# 관리자 지도 (manager-map) v1 — QuantPilot 1회차

## 목표

QuantPilot을 관리자 관점에서 보는 아티팩트 한 장(오퍼레이터 실행 사이클 흐름도 + 능력 히트맵 + 갭 목록)을 aorch 태스크 하나로 만들어 발행하고, 갭 상위 10개 중 STATUS·체크리스트로 이미 알던 것이 아닌 새 발견이 몇 개인지 기록하면 끝이다.

## 접근

2026-09-03 오후 인터뷰 4라운드 + 포니테일 점검으로 확정. 개발자 지도(`2026-09-03-project-map.md`)는 사용자 의도와 달라 보조 탭 링크로만 남긴다. 저장소에 이미 있는 관리자용 문서 5종(STATUS·수용 매트릭스·런북·체크리스트 2종)을 코드와 대조하는 것이 지도의 일이며, 추출 스크립트·모델 파일 없이 Fable을 핀한 worker 태스크 하나가 grep·문서 읽기→HTML을 직접 쓴다. 그 지시문을 스킬 런북으로 남겨 반복한다.

| # | 결정 |
|---|---|
| 1 | 답할 질문 4개: 어떻게 돌아가나 / 사람이 어디서 개입하나 / 무엇이 돼 있고 빈칸인가 / 어디를 개선하나 |
| 2 | 진실 = 문서 5종 × 코드(라우터 13·잡 6·enum 8·플래그 6·NotImplemented/TODO/fixture 폴백). 존재 여부는 ✓/✗, 의미 일치는 신뢰도(high/medium/low)+파일:줄 |
| 3 | 생성 = worker 태스크 1개(Fable 핀; auditor 프리셋은 Write 금지라 불가), 스크립트·모델 파일 없음, 지시문은 스킬 `aorch-manager-map`으로 |
| 4 | v1 화면 = 히트맵(첫 화면, 갭 수) + 흐름도 1개(오퍼레이터 실행 사이클, 런북 7단계 대조, 스윔레인 사람/시스템/외부) + 갭 목록 |
| 5 | 히트맵 축 = 로드맵 파트는 `roadmap_acceptance_matrix.md` §6 표 재사용(재계산 없음), 로드맵 밖 8라우터(notifications·policies·portfolio·reports·strategy_studio·level_1_2·strategy_tickets·signals)는 도메인 × (라우트/잡/UI 페이지 존재) 3열 |
| 6 | 갭 신호 = 문서–코드 불일치, 스텁·잠김·실서버 미검증, 흐름의 끊긴 고리(단계에 라우트·잡·페이지 없음, API만 있고 UI 없음 등), 수동 단계(미완 체크리스트·수동 실행 잡) |
| 7 | 제외(v1) = 흐름 2~5(승인 티켓 레일은 2차 1순위), C4, 상태 기계(paper dispatch/kill/cancel 전이 표는 2차), 개발자 지도 파이프라인 재사용 |
| 8 | 렌더 = Mermaid(`<pre class="mermaid">`, 아티팩트 네이티브) + HTML 격자, 외부 리소스 0, 두 테마 토큰 |
| 9 | 이후 = `gaps.json`(findings 스키마 7필드) → AskUserQuestion 선택 → `examples/plan-model-upgrade-apply.json` 재사용 |
| 10 | 측정 = 갭 상위 10개 중 새 발견 수(STATUS·체크리스트 재진술이 아닌 것) |

## 검증 명령

```bash
cd "<worktree>" && npm run check                       # 기존 검사, 스킬 md 추가가 깨뜨리지 않음
node scripts/manager-map-check.mjs docs/manager-map/quantpilot/<날짜>   # gaps.json 7필드·enum, index.html에 mermaid 블록·런북 7단계·외부 URL 0
node src/cli.js decompose --plan <plan.json>           # exit 0
node src/cli.js dispatch --plan <plan.json> --dry-run  # M1이 anthropic/fable
```

`<worktree>` = `.claude/worktrees/project-map`(브랜치 `worktree-project-map`, 개발자 지도와 같은 브랜치).

### 작업 1: 스킬 런북 `aorch-manager-map`

대상 파일: `integrations/claude/skills/aorch-manager-map/SKILL.md`, `integrations/codex/skills/aorch-manager-map/SKILL.md`(동일 사본), `examples/plan-manager-map.json`, `src/install.js`, `test/install.test.js`, `CHANGELOG.md`

- [x] SKILL.md frontmatter `description`(트리거: "관리자 지도", "프로젝트가 어떻게 돌아가는지 보여줘", "워크플로 점검", "빈칸 찾아줘"). 본문 = 태스크 지시문의 정본: (1) 읽을 문서 목록(프로젝트별 `<status-doc>`·`<acceptance-doc>`·`<runbook>`·`<checklists>`), (2) 존재 목록을 뽑는 명령(라우터 `grep -rn "@router\.\(get\|post\|put\|delete\|patch\)"`, 잡 `ls jobs/*.py`, enum `grep -n "class .*(str, Enum)"`, 플래그 `grep -rn "_ENABLED\|BROKER_MODE\|DATA_MODE"`, 스텁 `grep -rn "NotImplementedError\|TODO\|fixture" `), (3) 흐름 1개 정의 방법(런북 단계 → 각 단계에 코드 앵커·행위자(사람/시스템/외부)·통제점(플래그·킬스위치·승인)·존재 ✓/✗·의미 일치 신뢰도), (4) 히트맵 축 규칙(결정 5), (5) 갭 신호 4종과 findings 7필드 매핑(severity: 끊긴 고리·불일치 high, 스텁·잠김 standard, 수동 단계 low; axis: 불일치·끊긴 고리 correctness, 스텁 usage, 수동 단계 usage), (6) HTML 형식(첫 화면 히트맵+갭 수, 흐름도 `<pre class="mermaid">` flowchart LR with subgraph 스윔레인 3개, 갭 표, 개발자 지도 링크 자리, 두 테마 토큰, 외부 리소스 0), (7) 표시 규칙(✓/✗ 배지와 신뢰도 배지의 모양을 다르게), (8) 측정 질문과 후속(선택→apply 플랜)
- [x] `examples/plan-manager-map.json`: 태스크 `M1-manager-map`(agentRole worker, kind writing, risk standard, complexity critical, write true, `allowedProfileIds: ["claude-fable-apex"]`, allowedScope `docs/manager-map/<project>/<date>/**`, verificationCommands = check 스크립트, acceptanceCriteria: "index.html has one mermaid flowchart whose nodes cover every runbook step", "every gap has the seven findings fields and a file:line location", "existence facts and judgement claims are visually distinct"). objective에는 `<project-root>`·문서 경로·출력 경로 치환자
- [x] `src/install.js`의 설치 목록에 `.claude/skills/aorch-manager-map` 추가, `test/install.test.js`에 존재 단언 1개, CHANGELOG Unreleased/Added 한 줄
- [x] 검증: `npm run check` 통과; `node src/cli.js decompose --plan examples/plan-manager-map.json` exit 0

### 작업 2: 검증 스크립트 `scripts/manager-map-check.mjs`

대상: `scripts/manager-map-check.mjs`(단일 파일, 표준 라이브러리만)

- [x] 인자 `<출력 디렉터리>`. 검사: `gaps.json`이 배열이고 각 항목에 id·severity·fixCost·axis·location·evidence·proposal이 있으며 enum 값이 맞고 location이 `파일:줄` 또는 `문서#절` 형식; `index.html`에 `<pre class="mermaid">` ≥ 1, `http://`·`https://` 0건, 런북 7단계 키워드(게이트·전략·동기화·신호·제안·제출·보고) 각각 ≥ 1회, `data-kind="fact"`와 `data-kind="judgement"` 배지가 둘 다 존재. 실패 항목을 나열하고 exit 1
- [x] 검증: 빈 디렉터리로 실행 → exit 1과 이유 출력; 손으로 만든 최소 정상 디렉터리(scratchpad) → exit 0

### 작업 3: QuantPilot 1회차 실행

대상: `docs/manager-map/quantpilot/<날짜>/index.html`, `gaps.json`, 이 문서 "실측" 절

- [x] `examples/plan-manager-map.json`을 복사해 치환(project-root `C:/Users/goyan/OneDrive/문서/코덱스/주식트레이더`, 문서 5개 경로, 출력 `docs/manager-map/quantpilot/<날짜>`). objective에 "`quantpilot-foundation`·`Me/` 류 개인 자료는 열지 말 것, 변경은 출력 디렉터리만" 명시
- [x] dry-run으로 M1이 anthropic/fable인지 확인 → git bash `nohup`으로 dispatch(`--timeout-ms 1800000`), 로그 `scratchpad/mm-evidence/`
- [x] 리드 게이트: check 스크립트 통과, HTML을 읽어 흐름도가 런북 7단계와 대응하는지, 갭 수와 상위 10개 목록 확인
- [x] 아티팩트 발행(favicon 🧭, 제목 `QuantPilot 운영 지도`), URL을 "실측" 절에
- [x] 검증: check 스크립트 exit 0, 아티팩트 URL 기록

### 작업 4: 측정과 이월

대상: 이 문서 "실측"·"이월" 절, 스킬 런북 되먹임

- [x] AskUserQuestion: 갭 상위 10개 중 새 발견 수(0~2 / 3~5 / 6~8 / 9~10) + 세 화면 판정(히트맵·흐름도·갭 목록: 그대로/손볼 것/빼도 됨)
- [x] 새 발견 ≤2면 대조 장치 축소안(STATUS 링크 지도)을 이월에, ≥3이면 2차 순서(승인 티켓 레일 → paper 전이 표 → 반복 실행이 필요해지면 존재 목록 스크립트화 → 2번째 프로젝트)를 이월에
- [x] 실행 중 드러난 지시문 결함을 SKILL.md에 되먹임(두 사본 동일)
- [x] 갭 선택→적용은 이 계획 밖(`examples/plan-model-upgrade-apply.json` 복사)
- [x] 검증: `npm run check`, 이 문서 미체크 0

## 실측

- 작업 1·2(16:05~16:20 KST): 스킬 두 사본·예시 플랜·install 목록·테스트·CHANGELOG, 검증 스크립트(빈 디렉터리 exit 1, 최소 정상 디렉터리 exit 0). `npm run check` 304 pass, decompose ok.
- 작업 3 기동(20:02 KST): 플랜 `scratchpad/plan-mm-quantpilot.json`, dry-run M1 = anthropic/fable high, nohup dispatch, 로그 `mm-evidence/dispatch-mm-1.log`.
- M1 결과(20:02~20:17 KST, fable high, confidence 0.82): 흐름도 24노드(사람 7·시스템 13·외부 4, 런북 7단계 전부 앵커 포함), 히트맵 = 매트릭스 §6 원장 복사 + 라우터 13개 존재 3열, 갭 25건(불일치 10·끊긴 고리 4·스텁 6·수동 5; high 7·standard 12·low 6), 판단 low 2건(paper 브로커 경로, provider 배선). 게이트 `manager-map-check.mjs` OK. **change guard 실패는 리드 실수**: run 도중 미추적 계획 문서에 체크박스를 넣어 범위 밖 변경으로 잡힘 → 산출물은 게이트·receipt 기준 채택, 런북 §5에 함정 추가. 워커가 남긴 위험: 매트릭스가 참조하는 workboard·baseline 보고서 2개가 저장소에 없음(MIS-09), tests 디렉터리는 읽기 허용 밖이라 내용 미검증, §6 출처 링크는 상대 경로라 아티팩트에서 미해석.
- **발행(20:22 KST)**: https://claude.ai/code/artifact/6b9e1bbb-57bf-4121-a51f-b691606a5b98 (라벨 `2026-09-03 first run`). 갭 상위 10 = MIS-01·02·03·04, LINK-01·02, MIS-09, MIS-05·06·08.
- **1회차 측정(20:25 KST)**: 상위 10개 중 새 발견 **9~10개** (개발자 지도의 6~8개보다 높음). 화면 판정: 히트맵 "가시성이 떨어짐, 비전문가용 자세한 설명 필요", 흐름도 "더 보기 편했으면", 갭 목록 "그대로". → 리드가 디자인 스킬 기준으로 히트맵·흐름도를 손질해 같은 URL에 재발행하고, 설명 규칙을 런북 §2에 되먹임.
- 손질(20:30~20:45 KST, 리드 직접): 상단 "읽는 법"+용어집 8항목, 히트맵 두 표에 한 줄 요약과 관문·열·도메인 뜻 설명, 셀·배지 확대, 흐름도를 정상 경로(12노드, classDef 색 스윔레인, 짧은 라벨)와 멈춤·예외·재개(8노드) 두 장으로 분리 + 7문장 서술(갭 링크). 게이트 OK, 61KB. 같은 URL에 재발행(라벨 `readable pass`). 런북 §2-8·§5에 표현 규칙·run 중 편집 금지 함정 추가.

## 이월

- v1 제외 확정: 흐름 2~5, C4, 상태 기계, 개발자 지도 파이프라인 재사용, 반복 실행용 스크립트(요구가 생기면).
- 개발자 지도(`scripts/project-map/`)는 같은 브랜치에 남아 있고 별도 판단(보조 탭 링크만).
- 2차 순서(새 발견 9~10개로 확정): ① 승인 티켓 레일 흐름(권위 문서 없음) → ② paper dispatch/kill/cancel 전이 표(상태 기계) → ③ 반복 실행이 필요해지면 존재 목록 스크립트화 → ④ 2번째 프로젝트(study-agent: 문서 5종 대응물이 무엇인지부터).
- 갭 25건은 사용자가 고르면 `examples/plan-model-upgrade-apply.json`으로 적용. 워커가 남긴 판단 low 2건(E1 paper 브로커 경로, E2 provider 배선)과 미열람(tests 본문·kis_paper·submit_order_plan 본문)은 적용 전 직접 확인.
- 아티팩트의 §6 출처 링크는 상대 경로라 호스트에서 열리지 않음(문서 위치 표시용).
