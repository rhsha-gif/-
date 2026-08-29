# Obsidian Vault 전문가 에이전트 7종

## 목표

볼트(`C:\Users\goyan\OneDrive\문서\Obsidian Vault`, 이하 VAULT)에서 한글 트리거로 부를 수 있는 스킬 8종(영양사·트레이너·수학교수·심리상담·문학교수·철학자·공모전 팀·공모전 탐색)과 공모전 서브에이전트 5종이 설치되고, 혼디콜 NIA 기획서로 공모전 팀 1바퀴가 실전 통과하면 완료. 슬랙 워커 자동화(코멘트·주간 탐색)는 별도 저장소 단계로 마지막.

## 접근

인터뷰 22라운드 + 포니테일 점검 2회로 확정한 설계(`~/.claude/plans/c-users-goyan-onedrive-obsidian-vault-steady-harp.md`가 상세 원장). 기존 볼트 계약(CLAUDE.md 층별 문턱, `Advice/Advice.md`, 봉인, `review-interview` 라운드 패턴)을 재기술하지 않고 참조한다. 프로필 사실은 `Me/Me.md` 3장에(이 세션은 신중 세션으로 승인됨), 운영 선호만 SKILL.md에. 오픈소스는 MIT/Apache만, 한국어로 재작성 + 출처 한 줄. MCP 1차는 gutenberg 하나, 키 필요한 것은 2차.

## 검증 명령

볼트는 코드 프로젝트가 아니라 자동 테스트가 없다. 각 작업의 검증은 파일 존재·형식 grep과 실사용 1회 관찰이다.

```bash
# 위키링크 0개 확인 (AI 산출물)
grep -c "\[\[" "<파일>"            # 기대: 0
# MCP 연결
"C:/Users/goyan/.local/bin/claude.exe" mcp list
# sympy
python -c "import sympy; print(sympy.integrate('x**2','x'))"   # 기대: x**3/3
# 슬랙 워커 (단계 E)
cd "C:/Users/goyan/Documents/SecondBrain-scripts/slack-worker" && pytest
powershell -File "C:/Users/goyan/Documents/SecondBrain-scripts/weekly.ps1" -DryRun
```

### 작업 1: 공통 골격

대상: `VAULT/.claude/skills/_shared/persona-contract.md`, `VAULT/Me/Me.md`(3장·8-2), `VAULT/.mcp.json`, `VAULT/.obsidian/graph.json`

- [x] `persona-contract.md` 작성 — SKILL.md 작성 규약(런타임 미참조): 프론트매터 형식(name, description에 한글 트리거 열거), "읽는 폴더" 절 형식, `Advice/Advice.md` 참조 문구, 위키링크 금지, Me.md 0장 상속, 봉인 기본 규칙(counselor만 예외), 프롬프트 준수 의존 명기
- [x] `Me/Me.md` 3장 읽고 구조 파악 → 역할별 소절 추가(신체·운동: 무릎 수술 이력·분할·유산소 루틴·보충제·집밥; 독서: 세계 고전+서울대 추천도서, 시; 철학: 이력·고대 그리스 관심; 공모전: 관심 영역·거주/학적·개인 참가). 8-2 변경 이력에 근거(인터뷰 2026-08-29) 기재
- [x] `.mcp.json`에 gutenberg 등록(`npx -y @cyanheads/gutenberg-mcp-server@latest`)
- [x] ~~`pip install sympy`~~ → 시스템 python이 uv 관리(PEP 668)라 pip 불가. `uv run --with sympy python -c ...`로 대체(9초, 이후 캐시). 규약에 반영
- [x] `graph.json` `search`에 `-path:"Advice/" -path:"Study/Math/오류풀-math.md" -path:"Study/Math/오답노트-math.md" -path:"Study/Math/보충학습/"` 설정
- [x] 검증: sympy `x**3/3` 확인. `claude mcp list`(볼트 cwd): gutenberg **Pending approval** — 프로젝트 범위 MCP는 볼트에서 `claude`를 열어 1회 승인해야 Connected(사용자 액션). 그 외 통과

### 작업 2: 공모전 서브에이전트 5종

대상: `VAULT/.claude/agents/{admin-expert,legal-expert,contest-researcher,contest-judge,contest-juror}.md`

- [x] admin-expert(opus): 행정·예산·실현가능성·지원사업 검토. 웹/MCP 근거 의무, 출처 URL, 미확인 "확인 필요". tools: Read, Glob, Grep, WebSearch, WebFetch, naver-search, korean-law(2차)
- [x] legal-expert(opus): 법령·조례·개인정보·저작권·공모 규약 검토. 동일 근거 규율
- [x] contest-researcher(sonnet): 유사 수상작·기출·주최기관 성향 조사
- [x] contest-judge(opus): 채점표 확보 또는 임시 기준표 생성, 항목별 페르소나 문단 생성, 패널 결과 종합(만장일치 경고), 수정 지시
- [x] contest-juror(sonnet) 템플릿: 주입된 페르소나·기준표로 독립 채점 + 탈락 사유, 반론 라운드 응답 형식
- [x] 검증: 5파일 프론트매터에 name/description/model/tools(각 4건 grep 확인), `^tools:` 줄에 Write/Edit 0건

### 작업 3: contest-team 스킬 + 혼디콜 실전

대상: `VAULT/.claude/skills/contest-team/SKILL.md`, `VAULT/Projects/혼디콜/`

- [x] SKILL.md: 트리거("공모전 팀", "공모전 검토"), 입력(구두 → `Projects/<이름>/`), Me.md 3장 공모전 소절 읽기, 파이프라인 순서, 심사위원 생성 규칙(항목당 1인·3~5 클립, Agent 병렬 호출), 반론 라운드 매번, 한 바퀴 후 사용자 질문, 산출물 5종 파일명, 위키링크 금지
- [x] 혼디콜 NIA 2차 기획서로 1바퀴 실행(헤드리스 opus, `--allowedTools`에 Agent·웹·naver 명시. 첫 시도는 권한으로 중단·재실행)
- [x] 검증: 5종 생성(리서치 141줄·검토-행정 217·검토-법률 276·기획서-v1 200·심사 211), 기존 초안 diff 0, `[[` 전부 0, 심사 파일에 기준표/독립 채점 5인/반론/판정(**탈락권**)/수정 지시 5건, 한 바퀴 후 정지. **부분 미달**: 출처가 도메인(`law.go.kr`)·조문명(21건) 형태이고 일부 단정 문장에 URL 미병기 → admin/legal 규율에 "https:// 전체 URL을 문장 뒤 괄호에" 명시로 수정. 헤드리스라 "반복 여부 질문"은 지시로 생략

### 작업 4: contest-scout 스킬

대상: `VAULT/.claude/skills/contest-scout/SKILL.md`, `VAULT/Projects/공모전보드.md`

- [x] SKILL.md: 트리거("공모전 탐색", "공모전 찾아"), naver-search+WebSearch로 포털·지자체·공공기관 스캔, 프로필 필터(Me.md 3장), 보드 갱신 규칙(신규/마감임박/제출완료/팀필수)
- [x] `공모전보드.md` 초기화(`type: moc` 아님 — frontmatter `type: board`, 위키링크 금지), `공모전_후보_2026-08-28.md` 항목 흡수
- [x] 검증: 헤드리스 1회(`--allowedTools`에 웹·naver 명시 필요 — 첫 시도는 권한으로 중단) → 신규 접수 중 5건(GovTech 창업경진대회 ~9/21 적합 상 포함), 예정 1건, 마감·참고 8건 보강, 마감일·적합도 열 유지, `[[` 0, 갱신 이력 1줄

### 작업 5: 심리상담

대상: `VAULT/.claude/skills/_shared/references/counsel-frameworks.md`, `VAULT/.claude/skills/counselor/SKILL.md`

- [x] counsel-frameworks 저장소(MIT)를 읽고 14 프레임워크 요지·라우팅 매트릭스·강도 필터·한국 문화 적응층을 한국어 재작성(위기·면책 제외), 출처 한 줄
- [x] SKILL.md: 트리거("상담", "상담 세션", "얘기 좀 하자"), 읽기 순서(Me.md 0장 → 사례개념화 → 긴장 → 원리 → 최근 Daily 7일 → Advice 상담 요약 전부), 5단계 골격, 프레임워크 선택 규칙과 이유 제시, 기대 순위(패턴 > 정서 > 행동), 봉인 "자제" 기준 4가지 예시, 요약 승인 → `Advice/YYYY-MM-DD-심리.md`, 8-3 제출 형식·별도 커밋, 8-3 외 Me/ 쓰기 금지, 위기 프로토콜 없음 한 줄
- [ ] 검증: 시나리오 세션 1회 → 선택 이유 제시, 승인 전 파일 없음, 승인 후 Advice 파일 frontmatter 5필드·`[[` 0, `git status`에 Me.md(8-3)와 Advice만 — **미실행(의도적)**: 라운드마다 사용자 답이 필요하고 승인분이 Me.md 8-3에 들어가는 세션이라 헤드리스 시나리오는 가짜 관찰 유입 위험. 사용자가 볼트에서 "상담"으로 첫 세션을 열 때 검증

### 작업 6: 영양사·트레이너

대상: `VAULT/.claude/skills/_shared/references/{nutrition,exercise}.md`, `VAULT/.claude/skills/{nutritionist,trainer}/SKILL.md`

- [x] health-coach(MIT) references를 한국어 재작성: nutrition(BMR/TDEE·매크로·감량 속도·리피드), exercise(분할·볼륨·회복·부상 관리, 무릎 주의 동작)
- [x] nutritionist SKILL.md: 트리거("영양사", "식단"), 수치 관리 접근, 읽는 폴더, Advice 규약 참조·직전 다이어트 스냅샷 루프, 트레이너와 경계
- [x] trainer SKILL.md: 트리거("트레이너", "운동 프로그램"), 프로그램 설계·점검·정체·폼, 무릎 이력 반영, 영양사와 경계
- [x] 검증: 트레이너 `Advice/2026-08-29-운동.md` 5필드·`[[` 0·무릎 5회 통과. 영양사 `Advice/2026-08-29-다이어트.md` 5필드·`[[` 0·TDEE/매크로 계산 통과. **결함 발견**: 영양사가 나이를 찾으려 읽기 목록 밖 `Me/미생.md`를 열었다(프롬프트 준수 의존의 실례) → counselor 외 스킬 6종 읽기 절에 "Me/ 하위 다른 파일 열지 않음, 없는 사실은 묻거나 가정" 명시로 수정. 신장은 Me.md 3장에 없어 175cm 가정 — 사용자가 3장에 추가하면 재계산 가능

### 작업 7: 수학교수·문학교수·철학자

대상: `VAULT/.claude/skills/{math-professor,literature-professor,philosopher}/SKILL.md`, `VAULT/Study/Math/보충학습/`

- [x] math-professor: 트리거("수학교수", "수학 강의", "보충학습"), 강의식·LaTeX·교재 엄밀성, 진도(학습 로드맵·최근 Study/Math)와 오류풀 읽기, sympy 검산 Bash 스니펫, 저장 요청 시 `보충학습/YYYY-MM-DD-주제.md`(`type: supplement`, topic, errors 평문)
- [x] literature-professor: 트리거("문학교수", "독후 대화", "시 강평", "책 추천"), 소크라테스식, Books/·발췌 취향 기반 추천(통상 권장 제외), gutenberg 인용(실패 시 WebFetch), Daily 코멘트 수동 모드·"코멘트 이어서", vault-learn 경계
- [x] philosopher: 트리거("철학자", "철학 조언"), 조언자(지도자 아님), 원리·긴장 출발 → 철학사 유사 논의(고대 그리스 우선), gutenberg·SEP WebFetch, Daily 코멘트 수동 모드·이어서
- [x] 검증(헤드리스 `claude -p`, 볼트 cwd): 수학 → `Study/Math/보충학습/2026-08-29-부등식-강도.md` 생성, `type: supplement`·errors 평문 경로, `[[` 0. 문학·철학 → Daily/2026-08-28.md에 문학교수는 침묵(소재 없음), 철학자는 하단 섹션 1개 추가(diff는 append 8줄뿐, 원문 불변, `[[` 0). 헤드리스라 WebFetch·gutenberg 권한이 막혀 원전 인용은 요지 수준 — 코멘트에 그 사실 명시됨. 대화 세션에서는 승인 프롬프트로 해결

### 작업 8: 슬랙 워커 자동화 (별도 저장소)

대상: `C:\Users\goyan\Documents\SecondBrain-scripts\slack-worker\{channels.py,pipeline.py}`, `weekly.ps1`

- [x] channels.py: `DAILY_COMMENT_ROLES`·`daily_comment_prompt(note, role)`(스킬 파일 지목, 봉인 금지, 원리·긴장까지, 계약 줄 `코멘트:`/`코멘트 없음:`) + `daily_comment_settings()`(`Edit(Daily/**)`만, Me/ 전부 deny) + `weekly_scout_settings()`/`weekly_scout_prompt()` + `__main__`에 `weekly-scout` 등록
- [x] pipeline.py `_process_daily()`: me_commit 뒤 역할별 `run_claude(..., "opus", ...)` 2회 → `commit_paths([note], "slack(daily): {date} 코멘트")`, 회신에 코멘트 커밋·역할별 계약 줄·비용 표시, 실패는 경고로 격리. `_comment_summary()` 추가. 스니펫 업로드는 기존 `seal.filter_text` 경로 그대로
- [x] weekly.ps1: `weekly-scout` settings 파일, `$scoutDisallowed='Bash,Task'`(웹 열림), review 뒤 scout 패스(sonnet, -Json), 보드를 첨부·facts에 추가, exit 집계에 `$scoutExit`
- [x] 검증: `pytest` 82 passed(신규 테스트 4건 포함), `weekly.ps1 -DryRun -NoPost` exit 0·로그에 scout 프롬프트·"보드 갱신됨"·첨부 공모전보드.md. **실제 슬랙 일기 1건 → 4커밋 실측은 워커 재시작 후 다음 일기에서 확인(이 세션에서 미실행)**

### 작업 9: 2차 MCP (사용자 키 발급 후)

- [ ] korean-law-mcp(`npx korean-law-mcp setup`, 법제처 OC 환경변수), legal/admin 에이전트 tools에 추가
- [ ] k-mfds-fooddb(`GOV_API_KEY` 환경변수), nutritionist에 추가
- [ ] 검증: `claude mcp list` 둘 다 Connected, 각 1회 조회

## 완료 조건

- [x] 작업 1~7 검증 통과 (볼트) — 예외: 상담 시나리오(사용자 대화 세션에서), gutenberg MCP 승인(사용자 1회)
- [x] 혼디콜 1바퀴 산출물 5종 — 사용자 반복 결정 대기(판정: 탈락권, 수정 지시 5건)
- [x] 작업 8 pytest 통과(82) + DryRun 배선 확인 — 4커밋 실측은 다음 실제 일기에서
- [ ] 작업 9는 키 발급 시점에 따라 이월 가능
