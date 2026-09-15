---
name: pdf-math-md
description: "수학 문제 PDF를 AI가 읽기 쉬운 Markdown으로 변환하는 런북. 사용자가 \"수학 문제 PDF를 md로\", \"문제집 변환\", \"PDF 문제 추출\", \"이 PDF 문제 정리해줘\", \"기출 전사\"라고 하면 사용한다. 페이지 렌더링·상태·검사·조립은 동봉 스크립트가 하고, 에이전트는 페이지 이미지를 보고 페이지 JSON만 쓴다. 출력은 볼트 밖 수학문제-md 폴더이며 볼트 노트를 수정하지 않는다."
---

# pdf-math-md — 수학 문제 PDF → Markdown

## 왜 이렇게 나눴는가

일관성은 모델이 한 번에 읽는 양이 아니라 **코드가 페이지를 같은 방식으로 쪼개고, 같은 지시문과 스키마를 주고, 결과를 기계 검사하고, 상태를 기록해 재개하는 것**에서 나온다. 그래서 역할이 갈린다.

- 스크립트(`pdf2md.py`): 페이지 PNG 렌더링, 썸네일 시트, 상태·재개, JSON 스키마·코드 검사, 도형 크롭, 결정론적 조립.
- 에이전트(너): 썸네일을 보고 페이지 구간을 제안하고, 페이지 PNG를 한 장씩 보고 **페이지 JSON**을 쓴다. 수치·수식·문장은 보이는 대로 옮긴다. 요약하지 않는다.
- 사람: 구간 확인 1회, 그리고 결과 검토.

산출물은 볼트 **밖** `C:\Users\goyan\OneDrive\문서\수학문제-md\<과목 폴더>\<슬러그>\`에 생긴다(전체 md, `problems/` 문제별 md, `index.md`, `img/`). 볼트 노트는 읽지도 쓰지도 않는다. 출력은 `assemble`마다 전부 재생성되므로 **편집은 볼트로 옮긴 뒤에** 한다.

## 0. 스크립트 위치

`skill_dir`는 지금 읽고 있는 이 SKILL 파일이 들어 있는 폴더다.

- Claude Code(전역): `~/.claude/skills/pdf-math-md`
- Antigravity 앱(전역): `~/.gemini/config/skills/pdf-math-md`
- Antigravity CLI(전역): `~/.gemini/antigravity-cli/skills/pdf-math-md.md` — 동봉 자산은 `.aorch-assets/pdf-math-md/` 아래에 있고 아래 명령의 경로는 그에 맞게 치환돼 있다
- 프로젝트 설치본이 있으면 `<워크스페이스>/.claude/skills/pdf-math-md` 또는 `<워크스페이스>/.agents/skills/pdf-math-md`(폴더형만 인식됨)

스크립트는 `$skill_dir/scripts/pdf2md.py`다. 확신이 없으면 위 위치들에서 `pdf2md.py`를 검색해 첫 결과를 쓴다. 다음 명령이 자기 절대경로를 출력하므로 먼저 확인한다.

```powershell
uv run --with pypdfium2 --with pillow python "$skill_dir/scripts/pdf2md.py" --version
```

이후 모든 명령은 같은 접두사(`uv run --with pypdfium2 --with pillow python "$skill_dir/scripts/pdf2md.py"`)를 쓴다. 아래에서는 `pdf2md`로 줄여 적는다. Windows PowerShell에서는 경로를 항상 큰따옴표로 감싼다.

## 1. 준비

```powershell
pdf2md prepare "<PDF 절대경로>" --slug <슬러그> --out-root "C:\Users\goyan\OneDrive\문서\수학문제-md\<과목>"
pdf2md paths <슬러그>                    # 실행 폴더(%LOCALAPPDATA%\pdf2md\<슬러그>)와 출력 폴더
```

- 슬러그는 연도·시험명 기반으로 짧게 준다(예: `exam-2018-1`). 업로드 파일명은 한글이 빠져 있을 수 있으니 파일명에 기대지 않는다.
- `--out-root`는 **과목 폴더**(예: `선형대수학`)다. 상태 파일에 저장되므로 이후 `assemble`은 같은 곳에 쓴다. 나중에 바꾸려면 `pdf2md set-out-root <슬러그> --out-root <경로>`.
- `prepare`가 sha 불일치로 거부하면(다른 PDF가 같은 슬러그) 사용자에게 알리고 `--reset` 또는 `--slug`를 결정하게 한다.

## 2. 구간 판별 — 사용자 확인 게이트

1. `thumbs/sheet-*.png`를 순서대로 본다(Claude Code는 Read 도구, Antigravity는 이미지 보기).
2. 페이지 구간을 제안한다: `front`(표지·목차·서문), `problems`, `solutions`(정답·해설·**손글씨 답안**), `other`(색인·백지). 파일마다 다르다 — 시험지 뒤에 학생 답안 사진이 붙어 있거나, 인쇄 해설이 문제 바로 뒤에 올 수 있다.
3. `pdf2md set-ranges <슬러그> --spec "1-2:front,3-40:problems,41-52:solutions"` 실행 후 `pdf2md status <슬러그>`의 구간 표를 **사용자에게 보여 주고 확인을 받는다.** 확인 전에는 전사하지 않는다.
4. 확인되면 `pdf2md confirm-ranges <슬러그>`.

## 3. 페이지 루프

```text
반복:
  pdf2md next <슬러그>                       → 페이지 N (done이면 4단계로)
  pdf2md prompt <슬러그> --page N            → 출력된 지시문·컨텍스트·스키마를 그대로 따른다
  pages/NNN.png 를 본다
  pages/NNN.json 을 파일 도구로 직접 쓴다     (UTF-8. 셸 echo·파이프·stdin 금지: PowerShell 5.1이 $·\·한글을 깨뜨린다)
  pdf2md check <슬러그> --page N
    ok     → 다음
    failed → pdf2md prompt --page N 을 다시 실행하면 오류 목록이 붙어 나온다. 그 항목만 고쳐 다시 check
             (3회 실패면 스크립트가 skipped로 넘긴다. 읽을 수 없는 페이지는 pdf2md skip --page N --reason "..." 로 직접 넘긴다)
```

- 지시문의 컨텍스트(현재 heading, 마지막 문제 번호, 이전 페이지 꼬리)는 **이어짐 판단용**이다. 앞 페이지에서 이어진 첫 항목은 `continuation`(또는 번호가 보이면 `continues_from_previous: true`), 페이지 끝에서 잘린 마지막 항목은 `continues_to_next: true`.
- 출력은 **문제은행**이다. 시험 이름은 노트에 남지 않고, 번호가 1부터 다시 시작하는 지점을 코드가 "시험지 묶음"으로 나눠 해설 매칭과 배점 정규화에만 쓴다. 인쇄된 시험 제목이 보이면 `heading` 항목으로 옮기고, 보이지 않으면 만들어 넣지 않는다(검사 오류). 번호가 2 이상 건너뛰는 것이 원문 그대로면 `page_notes`에 `allow-gap`이라고 적는다.
- 번호는 인쇄돼 있으면 반드시 `number`에 넣는다(로마 숫자·원문자·괄호는 도구가 정규화). 배점 라벨은 `points`(소문항은 `parts[].points`)에 숫자로 넣는다.
- 문제문의 첫 줄은 노트 제목이 된다. 첫 줄에 `$$`가 있으면 검사 오류다(행렬은 둘째 줄부터).
- 손글씨 낙서·채점 표시·학생 메모는 문제가 아니다. 옮기지 않는다. 손글씨 답안 페이지는 `solution` 항목으로 옮기되 읽을 수 없는 부분은 `confidence`를 낮추고 `page_notes`에 `손글씨`라고 적는다(index의 검토 권장 목록에 오른다). 해설이 문제를 다시 적고 있으면 `statement_md`에 그대로 담는다 — 대응 문제가 없으면 조립기가 그 해설을 문제 노트로 만든다.
- **검사를 통과시키려고 값을 지어내지 않는다.** 검사 오류가 원문과 충돌하면 `page_notes`에 적고 `pdf2md skip --page N --reason "..."`로 사람에게 넘긴다. `skipped` 페이지를 되살리는 `check --force`는 사람이 지시했을 때만 쓰고 `--reason`에 그 지시를 적는다(이력에 남는다).
- 2단 조판은 왼쪽 열 위→아래, 오른쪽 열 위→아래 순서로 항목을 적고, 페이지 안에서는 한 항목을 쪼개지 않는다.
- 도형·그래프·표: `bbox_norm`은 페이지 폭·높이에 대한 비율 `[x0, y0, x1, y1]`, `caption`은 인쇄된 라벨(없으면 짧게), `description`은 한국어 한 문단(축·기호·모양). 크롭은 코드가 한다.
- 10페이지마다 `pdf2md status <슬러그>`로 진행을 사용자에게 알린다. 중단됐다가 재개할 때도 `status` → 3단계.

## 4. (선택) 별도 PDF의 해설 병합

해설이 다른 PDF에 있으면 그 PDF도 1~3단계로 처리한 뒤 `pdf2md merge-solutions <슬러그> --from <해설슬러그>`.

## 5. 조립과 보고

```powershell
pdf2md assemble <슬러그>
```

`index.md`의 표와 `## 검토 권장`·`## 해설에서 만든 문제`·`## 미매칭 해설`·`## 고아 조각`·`## 실패·건너뜀 페이지`·`## 그림 미추출` 절을 요약해 보고한다. 문제 수, 해설 매칭 수, 해설에서 만든 문제 수, 검토 권장 건수, 건너뛴 페이지와 이유를 적는다. 출력은 재생성되며 편집은 볼트로 옮긴 뒤에 한다는 점을 알린다.

문제 노트 `problems/NNN-<슬러그>.md`의 frontmatter: `source`, `pages`, `source_number`(인쇄 번호), `tags`, `points`(배점), `importance`(같은 시험지 묶음 안에서 배점 비중 × 문제 수, 1.0이 평균), `has_solution`, `solution_pages`, `from_solution`(해설에서 만든 문제), `confidence`. 제목은 은행 번호 `### NNN.`이며 배점 라벨은 제목·본문에서 빠진다. 시험 이름·장 이름은 노트에 쓰지 않는다(전체 md에는 인쇄된 heading이 그대로 남는다).

## 6. 여러 PDF를 Antigravity 헤드리스로 일괄 처리

사람이 1~2단계(준비·구간 확인)를 모든 슬러그에 먼저 끝낸 뒤, 3~5단계만 Antigravity CLI에 슬러그당 한 대화씩 순차로 맡긴다. 드라이버는 `$skill_dir/scripts/antigravity-batch.ps1`이며 **작업 폴더(스킬이 보이는 워크스페이스)에서** 실행한다. 다른 폴더에서 띄우면 `-Vault <워크스페이스>`를 준다.

```powershell
powershell -ExecutionPolicy Bypass -File "$skill_dir/scripts/antigravity-batch.ps1" -Slugs exam-2020-1,exam-2014-1
```

- 구간이 확인되지 않은 슬러그는 건너뛴다. 재실행하면 상태 파일 덕에 `next`부터 이어진다.
- 한 번에 agy 프로세스 하나만 띄운다(헤드리스 세션은 메모리를 많이 쓴다). 드라이버는 다른 agy가 돌고 있으면 기다리고, 타임아웃으로 남은 자기 agy는 종료하며, 개인 쿼터 도달("Individual quota reached… Resets in ~1h55m")이면 리셋까지 잔 뒤 같은 슬러그를 이어 돌린다(최대 3회). 실측: 인쇄 시험지 약 1.5분/쪽, 사진·손글씨 4분/쪽.
- 로그는 `<출력 루트>\_dogfood\<슬러그>.log`(에이전트 출력), `<슬러그>.agy.log`(CLI 로그), 진행은 `batch.log`.
- 기본 모델 `gemini-3.1-pro-high`. 실측에서 인쇄 시험지 전사는 원본과 일치했고 실패 페이지는 1회 재시도로 회복됐다. Flash 모델은 48쪽 손글씨 페이지를 640초 안에 끝내지 못했다.

## 금지

- 볼트 노트(`Study/`, `Concepts/`, `Me/` 등)를 읽거나 쓰지 않는다. 이 스킬의 입출력은 PDF, 실행 폴더, 출력 폴더뿐이다.
- 페이지에 없는 문제·수식·답·제목을 만들지 않는다. 읽을 수 없으면 `confidence`를 낮추고 `page_notes`에 적는다.
- 검사를 통과시키기 위한 값 조작, 사람 지시 없는 `check --force`.
- 구간 확인 전 전사, 셸을 통한 JSON 작성, 출력 폴더 직접 편집.

## 검증

```powershell
uv run --with pytest --with pypdfium2 --with pillow pytest "$skill_dir/scripts/tests"
```
