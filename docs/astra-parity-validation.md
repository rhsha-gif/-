# Astra · Claude/Codex 동등 지원 검증 기록

기준일: 2026-09-07. 구현과 검증은 아래 격리 워크트리에서 수행했다. 원래 checkout에 병합하거나 전역 설정을 갱신하지 않았다.

| 대상 | 구현 위치 | 기준 HEAD |
|---|---|---|
| aorch | `C:/Users/goyan/.codex/worktrees/astra-parity-aorch` | `3633f597878ce648c54bb4ee1b8e4cfacd2ddd0e` |
| QuantPilot | `C:/Users/goyan/.codex/worktrees/astra-parity-quantpilot` | `c6f172d490b46b6d542ca1508027d7b51bbb127f` |

두 브랜치 이름은 각각 `codex/astra-parity`다. 검증 종료 시점에는 커밋·push·병합을 수행하지 않았다. QuantPilot 원래 checkout의 미커밋 변경을 보존했으며, 파일 비교 후 기존 프로젝트 aorch 설정과 `vault-consult` 스킬을 작업 사본에 반영했다. 설정에는 Astra 프로필과 OpenAI 마지막 escalation 단계만 추가하고 기존 사용자 값을 유지했다. 설치 레지스트리는 각 프로젝트의 `.aorch/registry`에 격리했다.

## 구현 결과

- 최초 요청 수신자가 리드를 유지한다. 공통 절차는 `.aorch/workflow.md`, 도구·모델 상속 차이는 각 호스트 root skill에 둔다. 핵심 격리·변경 범위·receipt 검토·dispatch 중 commit 금지 규칙은 root skill에도 명시했다.
- native 분석·리뷰 및 격리된 low/standard 수정과 순차 CLI dispatch를 병용한다. native 소유 경로는 겹치지 않게 배정했다. high/critical 수정과 다른 provider 호출은 dispatch 경로를 사용한다. native 결과는 리드의 diff·테스트 검증으로 수락하고 자동 성과 관측으로 만들지 않았다.
- Astra는 `codex-astra-deep / gpt-6-astra / high` challenger다. 품질·자원 수치는 Sol prior를 재사용하며 실측으로 표시하지 않았다. 일반 후보 자격과 명시적 핀을 유지하되 정확한 품질·token·latency 동점에서는 stable 후보를 우선한다. critical challenger 제한과 부적격 escalation의 기존 실패 근거를 유지한다.
- 양쪽 native hook은 모델·effort를 추천할 뿐 모델 미지정·상속·사용자 핀을 차단하지 않는다. Windows 한글·공백 경로, Node 실행 파일 변경, 프로젝트 경로 대소문자 차이, 사용자 훅이 섞인 그룹과 재설치를 검증했다.
- Codex와 Claude 각각의 실제 `plugin list --json` 활성 목록을 사용한다. 정확한 ID·버전·provider 경로를 보존하고 비활성·캐시만 있는 패키지를 제외한다. Claude의 manifest 없는 활성 LSP 설치는 메타데이터로만 표시하며 실행 가능 도구를 추정하지 않는다. 활성 플러그인 탐색은 전역 설정·인증 파일을 직접 읽지 않는다. 추천용 classify는 실시간 플러그인 조회를 하지 않는다.
- QuantPilot의 Best-Fit·작업보드·점수표·양측 의무 참여·워커 자동 commit 규칙을 폐기했다. 역사 문서 본문은 유지하고 폐기 표식을 붙였다. 기존 시작·인계 명령은 aorch 진입점으로 바꿨다. 거래 안전·vault 조회·보안 게이트·필수 테스트를 유지했다.

## 실제 실행 순서와 경로

| 단계 | 리드/실행 모델·effort | 경로와 결과 |
|---|---|---|
| aorch 최초 구현 | Codex 워커 `gpt-6-astra/high` | 순차 dispatch. 20분 제한 전에 receipt를 내지 못해 실패. 실제 diff는 남았으며 리드가 후속 수정·검증했다. 자동 구현 성공으로 기록하지 않았다. |
| QuantPilot Q1 규약 전환 | Codex Desktop 리드, native `aorch_worker` | 독립 워크트리의 Markdown 소유 경로만 수정. 실제 diff와 역사 본문 보존을 리드가 확인. |
| Q1 독립 리뷰 | Claude `opus/xhigh` | dispatch. 공유 설정의 머신 경로 훅과 반복 실패 진단 규칙 누락을 찾아 로컬 설정 이전·규칙 복원 후 검증. |
| aorch 보완 | Codex native 역할 및 리드 | inventory, installer, routing/error-reporting을 서로 다른 파일 소유권으로 수정. focused tests와 전체 check로 수락. native 자동 관측 없음. |
| aorch 독립 리뷰 | Claude `opus/xhigh` | dispatch. 실제 diff와 전체 check를 검토하고 10개 finding을 기록. 동점 선택·Claude 활성 목록·재설치·오류 근거·문서 불일치를 수정했다. 머신 간 설정 이식과 잘못된 설정의 fail-open은 지원으로 주장하지 않았다. |
| QuantPilot Q2 검사기 개발 | 별도 Claude root `claude-opus-5`, 요청 effort `high` | 원래 Claude 리드가 직접 분해·구현하고 Codex 리뷰를 호출. CLI 결과의 modelUsage로 실제 모델을 확인했다. |
| Q2 독립 리뷰 2회 | Codex `gpt-6-astra/high` | Claude 리드가 두 번 실제 dispatch. 두 prior revision에서 각각 10개·8개 결함을 찾았고 change guard는 모두 통과했다. 해당 reject receipt를 최종 승인으로 바꾸지 않았다. |
| Q2 최종 수락 | Codex Desktop native `aorch_reviewer` 및 리드 | 마지막 8개 수정의 독립 확인에서 shared-modal 회귀 1개를 추가 발견. 재현 테스트를 먼저 실패시킨 뒤 수정했고, 6개 독립 probe와 최종 suite로 수락했다. |
| aorch 수정 후 교차 리뷰 | Claude `opus/xhigh` | `.aorch/behavior-review.json`. 86개 focused tests와 실제 hook·inventory·classify 확인. 추가 ladder 키가 검사 입력을 덮어쓰는 low 오류 1건을 찾아 마지막 수정·검증으로 연결. 다른 검토 항목은 통과. |

마지막 에스컬레이션 수정은 profileId·effort만 명시적으로 전달하도록 제한했다. task·catalog·observations·now 추가 키를 각각 주입한 네 회귀 사례는 수정 전에 실패했고 수정 후 통과했다. 독립 Desktop aorch_reviewer가 실제 diff와 네 테스트를 검토해 PASS를 기록했다. 이 수락은 native 리뷰이며 과거 dispatch의 reject receipt를 변경하거나 새 dispatch 성공으로 표시하지 않았다.

각 CLI 부분은 기존 JSON 계획 계약으로 검증·dry-run 후 실행했다. 전체 실행 순서와 native/CLI 경로는 이 기록과 `.aorch/lead-evidence.md`에 남겼다. 워커의 재귀 위임은 사용하지 않았다.

## Desktop · 신규 CLI 확인

Desktop 현재 세션에서 설치된 root skill/common workflow를 실제로 읽고 `aorch_reviewer` native 역할을 실행했다. `/root/desktop_native_acceptance`의 실행 metadata에서 `gpt-6-astra/high`를 확인했다. 역할 지침이 주입됐지만 Desktop은 shell/edit 도구를 여전히 노출하므로 읽기 전용 역할을 강제 sandbox의 증거로 표현하지 않는다.

신규 Codex CLI에서도 실제 native `aorch_reviewer` 자식을 생성하고 완료 결과를 받았다. 첫 `--ephemeral --ignore-user-config` 시도는 정책상 읽기 거부와 `no thread with id` 오류로 실패했다. 일반 지속 세션에서는 사용자 설정을 변경하지 않고 정상 실행됐다. 두 번째 세션 `01a07c17-658e-76e2-9167-eb6530bd7863`과 자식 `01a07c18-74db-73d3-9715-af437d241f21`의 metadata에서 모두 `gpt-6-astra/high`를 확인해 모델·effort 생략 시 상속을 입증했다.

공통 지침 문구를 보완한 뒤 새 CLI 세션 `01a07c39-fea9-73d1-ab98-e9ddc0194655`에서 다시 실제 native 생성·대기·결과 수신을 수행했고, 다섯 정책 불변식에 누락이 없다는 결과를 받았다. 마지막 원시 이벤트와 결과는 `.aorch/cli-native-events.jsonl`, `.aorch/cli-native-final.txt`, 모델·호출 필드만 추린 증거는 `.aorch/native-runtime-proof.json`에 있다. 이전 시도는 `cli-native-attempt1-*`, `cli-native-attempt2-*`로 보존했다. CLI subprocess 실행 성공만으로 Desktop 확인을 대체하지 않았다.

## 검증 결과

| 검증 | 최종 결과 |
|---|---|
| aorch `npm run check` | 최종 수정 후 358개 중 357개 통과, 실패 0, skip 1. 기존 npm bin symlink 검사는 Windows symlink 권한 부족으로 skip. `.aorch/full-check-final.log`. |
| Astra 선택·핀·critical·escalation·limits와 기존 guard/receipt 회귀 | 전체 check에 포함. 새 테스트는 실제 router/run-loop를 사용하고 워커 I/O만 fixture로 대체. |
| Windows hook 실행·상속 입력·사용자 훅 보존·재설치 | 전체 check에 포함. 실제 host shell에서 생성한 명령 실행. |
| 실제 활성 plugin inventory | Codex 45개/45개. Claude 4개 활성(일반 2개 + manifest 없는 LSP 2개), disabled 2개 제외. `.aorch/live-inventory-final.json`. 실행 기능의 성공 검사는 아님. |
| QuantPilot 검사기 unittest | 최종 91개 통과. 독립 tempfile fixture 사용. |
| QuantPilot `python scripts/check_aorch_integration.py --project .` | 오류 0, 경고 0. |
| Q1 fixture/mock smoke | exit 0, broker mock, live false, signals 7, fixture fills 3. |
| Q2 최종 fixture/mock smoke | exit 0, broker mock, live false, signals 7, fixture fills 3. |
| 최종 diff 검사 | 두 프로젝트 `git diff --check` 통과. QuantPilot 공유 `.claude/settings.json`의 diff 없음. |

Smoke는 `.pytest_tmp/astra_smoke.py`가 허용한 환경 변수와 fixture/mock·안전 플래그만 전달한 자식 프로세스에서 실행했다. 실거래·외부 주문은 수행하지 않았다. 거래 backend와 frontend 코드는 수정하지 않았으므로 전체 backend pytest 및 frontend 테스트/빌드 조건은 발생하지 않았다. 해당 필수 명령은 프로젝트 지침에 유지했다.

## 수정 범위와 사용

aorch 변경은 `config/aorch.config.json`, `src/{router,run-loop,task-runner,inventory,capabilities,install,cli}.js`, provider 공통 프롬프트, 호스트별 integrations, shared workflow, 관련 tests, README/CHANGELOG/DESIGN에 한정된다. task·receipt JSON schema와 CLI 명령 계약을 바꾸지 않았다.

QuantPilot은 AGENTS/CLAUDE, `.codex/README.md`, 기존 시작·인계 명령과 관련 skills, 역사 문서 세 개 및 roadmap acceptance를 전환했다. 새 실행 파일은 `scripts/check_aorch_integration.py`, 테스트는 `scripts/tests/test_aorch_integration.py`, 사용 안내는 `docs/aorch_integration.md`다. 생성된 `.aorch`, Claude 로컬 설정, Codex hook 설정은 git에서 제외한다. 다른 OS·머신에는 절대 경로가 담긴 생성 훅을 복사하지 않고 새 로컬 설정을 설치한다. 다른 프로젝트를 가리키는 훅은 설치기가 자동 삭제하지 않는다.

## 개입과 검증 한계

추가 사용자 확인이나 전역 설정 변경 없이 진행했다. 리드 개입 원인은 첫 워커의 receipt 시간 초과, 실제 활성 메타데이터 형식 차이, 경로·동점·실패 근거·검사기 회귀 수정이었다. 첫 native 구현·수정 모델의 exact telemetry가 별도로 수집되지 않은 단계는 실행 모델을 추정해 기록하지 않았다.

Codex CLI의 읽기 전용 리뷰 sandbox는 임시 파일 생성이 막혀 unittest 본문을 실행하지 못했다. 리뷰는 in-memory 재현과 파일 검토를 수행했고, 최종 91개 테스트는 Desktop의 쓰기 가능한 임시 fixture 환경에서 실제 실행했다. 이 차이를 숨기거나 과거 reject receipt를 성공으로 바꾸지 않았다.

검사기의 운영 규약 검사는 명시한 파일 목록과 제한된 문장 패턴을 대상으로 하며 모든 자연어 규칙을 증명하지 않는다. 설치 검사도 파일별 읽기이므로 동시 설치 변경 중의 단일 snapshot을 보증하지 않는다. 실제 hook 실행은 호스트의 신뢰·활성 설정에도 달려 있으며, 단위 테스트나 설치 파일 존재만으로 자동 주입을 주장하지 않는다. Astra는 challenger로 유지하며 자동 stable 승격이나 성능 우위·비용 절감 실측을 주장하지 않는다.

양쪽 호스트의 aorch 스킬·역할 파일도 QuantPilot 프로젝트에 설치했다. 기존 `vault-consult` 스킬은 원본과 동일한 사본을 보존했다.

최종 판정: 두 격리 워크트리에서 구현과 전환 검증을 완료했다. 마지막 low 오류 수정은 독립 native 리뷰를 통과했고, 최종 전체 check도 실패 없이 종료했다. Codex 리드와 Claude 리드의 실제 개발·독립 리뷰·수정·fixture/mock smoke, Desktop 및 신규 CLI의 실제 native 역할 실행을 모두 확인했다. 기존 reject receipt를 성공 receipt로 수정하지 않았다. 검증 종료 시점에는 원래 checkout으로의 병합·커밋·push를 수행하지 않았다.
