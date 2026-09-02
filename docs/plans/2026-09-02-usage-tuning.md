# 최근 30일 사용 이력 기반 전역 설정 파인튜닝

## 목표

2026-08-03~09-02 Claude Code 사용 이력(프롬프트 394건, 세션 249개, 도구 호출 약 12,000회)이 보여준 실제 패턴에 전역 설정·스킬·프로젝트 목록을 맞추고, 그 근거 수치를 이 문서에 남기면 끝.

## 접근

2026-09-02 인터뷰 3라운드로 확정. 분석은 `~/.claude/history.jsonl`과 `~/.claude/projects/*/*.jsonl`의 도구 호출 메타데이터와 어휘 빈도만 썼고 프롬프트 본문은 읽지 않았다(사용자 결정). 실측 요지: 도구 호출 기준 활동 프로젝트는 study-agent(`C:/dev/study-agent`, 4,180회) > Obsidian Vault(3,050) > adaptive orchestrator(2,584) > QuantPilot(1,007) > 책 만들기(799)인데 `C:/Users/goyan/CLAUDE.md`는 세 개만 활동으로 적고 있다. `/resume-work` 직접 호출 10회, interview 스킬 37회, AskUserQuestion 652회, ship 16회, PowerShell 889회(QuantPilot에서는 Bash보다 많음), `Stop-Process` 103회(거의 전부 study-agent electron 재시작), superpowers 플러그인은 8월 10일 이후 미사용. 스킬 트리거 어휘는 plan만 8회가 description 어휘 없이 호출됐고(인터뷰 종료 선택지 "계획 문서로 정리" 경로) 나머지는 적중.

사용자 확정 결정(재제안 금지): 대상 4축(프로젝트 목록·신뢰 경계 / 권한 프롬프트 / 스킬 트리거·중복 / 셸 규칙) · 30일·메타데이터만 · resume-work는 얇은 별칭으로 복원 · study-agent 정본은 `C:/dev/study-agent`이고 CLAUDE.md 신설 · 셸 규칙 예외는 프로젝트 CLAUDE.md로 · allowlist는 프로젝트별 settings.json · OneDrive study agent 잔여 설치본 삭제 · 책 만들기 활동 프로젝트 등록 · description은 plan만 · 훅·superpowers 비활성 유지.

## 검증 명령

```bash
node -e "require('C:/Users/goyan/.claude/settings.json'); console.log('settings ok')"
node -e "const s=require('C:/Users/goyan/.claude/settings.json'); console.log(s.autoMode.environment.find(l=>l.startsWith('**Trusted repo**')))"
ls "C:/Users/goyan/.claude/skills"                       # resume-work 포함 9개
grep -c "계획 문서로 정리" "C:/Users/goyan/.claude/skills/plan/SKILL.md"    # 1
grep -c "study-agent" "C:/Users/goyan/CLAUDE.md"          # ≥1
cd "C:/dev/study-agent" && npm run verify                 # study-agent CLAUDE.md가 적는 검증 명령 실재 확인
```

### 작업 1: 활동 프로젝트 목록 정합화

대상 파일: `C:/Users/goyan/CLAUDE.md`, `C:/Users/goyan/.claude/CLAUDE.md`

- [x] `C:/Users/goyan/CLAUDE.md` "활동 프로젝트" 절을 이력 순위대로 5개로 고친다: study-agent(`C:\dev\study-agent`, Electron/vite/vitest, 검증 `npm run verify`, 규약은 프로젝트 `CLAUDE.md`), Obsidian Vault(기존), adaptive orchestrator(기존), QuantPilot(기존), 책 만들기(`OneDrive\문서\책 만들기`, Codex 중심 워크스페이스, `AGENTS.md` 필독, 필수 명령 `npm run book:check -- --book books/<id>`·`npm test`). 아카이브 절은 그대로
- [x] `C:/Users/goyan/.claude/CLAUDE.md` "셸 원칙" 첫 항목 끝에 한 문장 추가: "프로젝트 `CLAUDE.md`가 셸·프로세스 규칙의 예외를 정할 수 있다"
- [x] 검증: `grep -c "study-agent\|책 만들기" "C:/Users/goyan/CLAUDE.md"` ≥ 2; `grep -c "예외를 정할 수 있다" "C:/Users/goyan/.claude/CLAUDE.md"` = 1

### 작업 2: autoMode 신뢰 경계 갱신

대상 파일: `C:/Users/goyan/.claude/settings.json` (`autoMode.environment`의 `**Trusted repo**` 항목)

- [x] 수정 전 `settings.json`을 `~/.claude/backups/2026-09-02-usage-tuning/`에 복사
- [x] Trusted repo 항목을 5개 경로로 갱신: `C:\dev\study-agent`(GitHub 원격), `OneDrive\문서\adaptive orchestrator`(원격), `OneDrive\문서\코덱스\주식트레이더`(원격), `OneDrive\문서\책 만들기`(원격), `OneDrive\문서\Obsidian Vault`(원격 없음, `Me/` 사용자 전용). "updated 2026-09-02" 표기 유지
- [x] 검증: 검증 명령 1·2 — JSON 파싱 성공, Trusted repo 줄에 `study-agent`와 `책 만들기` 포함

### 작업 3: study-agent 프로젝트 CLAUDE.md 신설

대상 파일: `C:/dev/study-agent/CLAUDE.md` (신규, 미커밋으로 둠)

- [x] 작성 내용: (1) 한 줄 소개(Electron + electron-vite + vitest 학습 앱, Android 빌드 있음), (2) 검증 명령 `npm run typecheck` · `npm test` · `npm run build` · 종합 `npm run verify`, 실행 `npm run dev`, (3) 문서 포인터 `docs/plans/`(진행 원장), `docs/android.md`, `docs/gestures.md`, `docs/packaging.md`, `docs/borrowing.md`, (4) 셸·프로세스 예외: "이 앱의 electron 프로세스를 개발 중 재시작하기 위한 `Stop-Process -Name electron`은 허용한다. 그 외 프로세스 종료는 전역 규칙대로 금지", (5) `.claude/agents`·`.claude/skills`·`.aorch`는 aorch 설치본이며 `aorch update`로만 갱신
- [x] 검증: `cd "C:/dev/study-agent" && npm run verify` 종료 코드 0 (문서가 적은 명령이 실재함); `git -C "C:/dev/study-agent" status --short CLAUDE.md` → `?? CLAUDE.md`

### 작업 4: QuantPilot CLAUDE.md에 셸 관례 한 줄

대상 파일: `C:/Users/goyan/OneDrive/문서/코덱스/주식트레이더/CLAUDE.md` ("## Commands" 절)

- [x] "## Commands" 첫 줄에 추가: "This project's commands are written for PowerShell (below); PowerShell is the working convention here and overrides the user-level Bash default." 프로젝트 문서 언어(영어) 유지
- [x] 검증: `grep -c "overrides the user-level Bash default" ".../주식트레이더/CLAUDE.md"` = 1; `git -C ".../주식트레이더" diff --stat CLAUDE.md` 1파일 +1

### 작업 5: resume-work 별칭 복원과 plan description 보강

대상 파일: `C:/Users/goyan/.claude/skills/resume-work/SKILL.md` (신규), `C:/Users/goyan/.claude/skills/plan/SKILL.md`

- [x] `resume-work/SKILL.md` 작성: frontmatter `name: resume-work`, `description`은 삭제 전 원문 그대로(백업 `~/.claude/backups/2026-09-02-pre-audit/skills/resume-work/SKILL.md`에서 복사). 본문은 세 줄: "이 스킬은 별칭이다. execute-plan 스킬의 '시작' 절 0번(재개 절차: TaskList → docs/plans 미체크 문서 → git status, 변경 되돌리기 금지)을 그대로 따른다. 나머지 규칙도 execute-plan이 정본이다."
- [x] `plan/SKILL.md` description의 트리거 목록에 `"계획 문서로 정리"`, `"계획으로 만들어"` 추가
- [x] 검증: 검증 명령 3·4 — `ls ~/.claude/skills`에 `resume-work` 포함(9개), plan description grep = 1. 다음 프롬프트의 스킬 목록에 두 변경이 반영됨(세션 확인)

### 작업 6: 프로젝트별 권한 allowlist

대상 파일: 각 프로젝트의 `.claude/settings.json` — `C:/dev/study-agent`, `OneDrive/문서/Obsidian Vault`, `OneDrive/문서/adaptive orchestrator`, `OneDrive/문서/코덱스/주식트레이더`, `OneDrive/문서/책 만들기`

- [x] 프로젝트마다 그 디렉터리를 cwd로 `fewer-permission-prompts` 스킬을 호출한다(스킬이 트랜스크립트를 읽어 읽기 전용 Bash·MCP 호출을 뽑아 제안)
- [x] 제안 목록을 적용 전에 검토: 쓰기(`rm`, `git push`, `git reset`, `Stop-Process`, `npm install`)·네트워크 명령이 섞이면 뺀다. 오늘 전역에서 ask로 옮긴 `Bash(git push:*)`는 어느 프로젝트 allow에도 넣지 않는다
- [x] 적용 후 각 `settings.json`이 JSON으로 파싱되고 기존 hooks 키가 보존됐는지 확인
- [x] 검증: `node -e "for (const p of [...5경로]) require(p+'/.claude/settings.json')"` 오류 없음; 각 파일의 `permissions.allow`에 `git push` 없음

### 작업 7: OneDrive study agent 잔여 설치본 삭제

대상: `C:/Users/goyan/OneDrive/문서/study agent/` (프로젝트 파일 없음, `.agents`·`.aorch`·`.claude`·`.codex` 39파일)

- [x] 삭제 직전 `find "<경로>" -type f | wc -l`이 39이고 `package.json`이 없음을 다시 확인한다(프로젝트 파일이 생겼으면 중단)
- [x] 디렉터리 삭제 — 파일 39개 삭제 완료. 빈 디렉터리 자체는 다른 프로세스(OneDrive 동기화 추정)가 잡고 있어 `rm -rf`·`Remove-Item`·`rmdir` 모두 "resource busy". 재부팅 또는 OneDrive 일시정지 후 빈 폴더 삭제 필요
- [ ] aorch 레지스트리 `~/.aorch/installs.json`에 `OneDrive/문서/study agent` 항목 잔존 — 빈 디렉터리가 남아 있어 prune 조건(경로 부재) 미충족. 폴더 삭제 후 `aorch update`로 정리
- [ ] 검증: `ls "C:/Users/goyan/OneDrive/문서/study agent"` → 없음; 레지스트리 JSON에 해당 경로 없음 (빈 폴더 삭제 후 재검증)

### 작업 8: 기록

대상 파일: 이 문서, `docs/plans/2026-09-02-model-upgrade-fable-5-1.md`("이월" 절), `~/.claude/projects/.../memory/aorch-model-upgrade.md`

- [x] 이 문서 하단 "실측" 절에 작업별 결과(변경 파일, allowlist 항목 수, 삭제 파일 수)를 적는다
- [x] 모델 업그레이드 문서 "이월 — 전역" 절에 "autoMode·CLAUDE.md는 09-02 이력 기반으로 재갱신(usage-tuning 문서 참조)" 한 줄
- [x] 메모리: study-agent 정본 경로·활동 프로젝트 5개·훅 유지 근거(47세션 주입, 33세션 스킬 호출)를 기록
- [x] 검증: 세 파일 grep으로 문구 존재 확인

## 실측 (2026-09-02 12:40~13:20 KST)

- 작업 1: `C:/Users/goyan/CLAUDE.md` 활동 프로젝트 5개(study-agent·QuantPilot·Vault·aorch·책 만들기), `~/.claude/CLAUDE.md` 셸 원칙에 프로젝트 예외 한 문장. grep 검증 4·1.
- 작업 2: `settings.json` Trusted repo를 5개 경로로 갱신(백업 `~/.claude/backups/2026-09-02-usage-tuning/settings.json`). JSON 파싱 정상.
- 작업 3: `C:/dev/study-agent/CLAUDE.md` 신설(검증 명령·문서 포인터·electron 재시작 예외·하네스 파일 안내). `npm run verify` exit 0(typecheck+vitest+build 11.5초). git `?? CLAUDE.md`.
- 작업 4: QuantPilot CLAUDE.md "## Commands"에 PowerShell 관례 한 줄.
- 작업 5: `resume-work` 별칭 복원(description 원문, 본문 3줄), plan description에 "계획 문서로 정리"·"계획으로 만들어". 다음 프롬프트의 스킬 목록에 둘 다 반영된 것을 세션에서 확인.
- 작업 6: 프로젝트별 최근 50세션 스캔, 각 `&&`·`|`·`;` 세그먼트의 선행 명령 기준. 인터프리터(python·node)·셸(cmd)·`aorch decompose`·git 읽기(자동 허용)·타 프로젝트 npm 스크립트는 제외. 추가: study-agent 13(`npm run typecheck` 124회·`npm test` 36회·PowerShell Get-* 7종), Vault 6(naver-search 2·gutenberg 1·PowerShell 3), aorch 4(`npm run check` 61회), QuantPilot 8(PowerShell Get-ChildItem 120회 등·vault MCP 2), 책 만들기 3(`npm run book:check:*` 70회). 5파일 모두 JSON 유효, hooks 키 보존, `git push` 없음. 표기는 Claude Code 문서의 `:*` 접두 형식.
- 작업 7: 파일 39개 삭제. 빈 폴더 잠김(위 참조).
- 관찰: `C--dev-study-agent` 트랜스크립트 19개에는 도구 호출이 없고, study-agent 작업은 전부 OneDrive 스텁 폴더를 cwd로 연 세션에서 `cd C:/dev/study-agent`로 돌았다. 앞으로 `C:/dev/study-agent`에서 열면 새 CLAUDE.md와 allowlist가 적용된다.
