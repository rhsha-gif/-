# colab-operator 2단계: 잡 드라이버 (2026-09-25)

## 배경

09-24 OCR 도그푸딩 3라운드는 OCR이 아니라 오케스트레이션 역학에서 실패했다: 동기 `colab exec`가 워커 셸 10분 제한에 걸림, 헤드리스 워커가 백그라운드 알림을 기다리다 종료, 세션 미종료, `.gitignore`와 신고 충돌. 현재 스킬은 규칙 문서라 워커가 매번 6단계를 손으로 조립한다. 정찰(09-25) 결과 파일형 입출력의 무거운 계산은 QuantPilot 백테스트·스윕과 수학 PDF OCR에 집중돼 있고, SecondBrain·study-agent·책 만들기는 지금 적합하지 않다.

## 인터뷰 결정 (09-25, 재제안 금지)

| # | 결정 | 근거 |
|---|---|---|
| 1 | 1차 사용자는 **헤드리스 워커 + 대화 중 리드 둘 다** | 같은 드라이버 명령, JSON 매니페스트, receipt 출력, 진행 로그는 stderr |
| 2 | **범용 파이썬 샌드박스만**. 워크로드 레시피(QuantPilot·OCR)는 이번 범위 밖 | 레시피는 각 프로젝트에서 필요할 때 만든다 |
| 3 | **잡마다 새 세션, 끝나면 정지**. 리스 없음 | 누수 0, 단순성 |
| 4 | 가속기는 매니페스트의 **후보 목록을 순서대로 시도**, 전부 거절되면 blocked. CPU는 목록에 명시해야만 사용 | A100 거절 실측 |
| 5 | 설치 시간 단축은 **로컬 휠 번들 업로드**로 포함(순수 파이썬 소형 패키지용). Drive 캐시는 제외 | drivemount가 대화형 |

## 가정 (되돌릴 수 있음)

- 드라이버는 `integrations/user/skills/colab-operator/scripts/colab_job.py`, 표준 라이브러리만 사용, Windows에서 `python`/`uv run python`으로 실행되며 PATH의 `colab` 셔틀(`--auth=adc` 고정)을 호출한다. `aorch update --user`가 네 제품 경로에 함께 배포한다.
- 워커 셸 제한을 넘는 잡을 위해 `run`은 `--max-wait`(기본 480초)로 **반환 가능**하고, 같은 매니페스트로 다시 부르면 상태 파일에서 **재개**한다(세션·잡 id 기억). 리드는 더 긴 대기나 백그라운드 실행을 쓸 수 있다.
- `colab run`은 실행 `--timeout` 기본 30초라 쓰지 않는다. 드라이버는 `new → install → upload → exec(nohup 분리) → poll → download → stop`를 직접 조립한다.

## 매니페스트 (`job.json`)

```json
{
  "name": "ocr-sample",
  "accelerators": ["T4", "cpu"],
  "high_mem": false,
  "packages": ["mineru[torch]>=4.0,<5"],
  "requirements": null,
  "wheels_dir": null,
  "uploads": [{ "local": "input/sample.pdf", "remote": "/content/sample.pdf" }],
  "script": "job.py",
  "args": ["--pages", "all"],
  "env": { "MINERU_LANG": "korean" },
  "timeout_minutes": 30,
  "poll_seconds": 20,
  "outputs": [{ "remote": "/content/out", "local": "out" }],
  "keep_on_failure": false
}
```

- `accelerators`: `"T4" | "L4" | "G4" | "H100" | "A100" | "v5e1" | "v6e1" | "cpu"`. 순서대로 `colab new` 시도, 거절 메시지는 receipt `attempts`에 남긴다.
- `wheels_dir`: 로컬 폴더의 `*.whl`을 `/content/wheels`로 올리고 `pip install --no-index --find-links`로 먼저 설치한 뒤 `packages`·`requirements`를 설치한다.
- `outputs.remote`가 디렉터리면 `colab ls`로 열거해 파일마다 `colab download`.

## 드라이버 명령

| 명령 | 동작 |
|---|---|
| `colab_job.py template` | 매니페스트 예시 출력 |
| `colab_job.py run job.json [--max-wait S] [--state DIR] [--dry-run]` | 전체 파이프라인. `--max-wait` 초과 시 `status: running`으로 반환하고 재호출로 재개 |
| `colab_job.py wait job.json [--max-wait S]` | 폴링만 (run과 같은 상태 파일) |
| `colab_job.py collect job.json` | 다운로드 + 정지 + receipt 확정 |
| `colab_job.py abort job.json` | 세션 정지, receipt `aborted` |
| `colab_job.py verify job-receipt.json` | receipt 상태 `ok`, 출력 파일 존재, `colab sessions`에 잡 세션 없음 → exit 0 |

- 모든 `colab` 호출은 argv·exit code·초를 receipt `commands`에 기록한다.
- 예외·타임아웃·후보 소진 시 `keep_on_failure`가 아니면 반드시 `colab stop`. 정지 실패는 receipt `unresolved`에 남기고 exit 3.
- 원격 실행은 `/content/.aorch-job/<id>/`에 `t_start`·`t_end`·`job.log`·`EXIT=`를 남기는 nohup 래퍼로 하고, 폴링은 짧은 `colab exec`로 로그 꼬리와 `nvidia-smi` 한 줄을 읽는다.

## receipt (`job-receipt.json`)

`status`(ok·failed·running·blocked·aborted), `session`, `accelerator_requested`·`accelerator_used`, `attempts[]`, `timings{new,install,upload,run,download,stop}`(초), `exit_code`, `log_tail`, `outputs[{local,bytes}]`, `commands[]`, `unresolved[]`.

## 구현 슬라이스와 완료 조건

1. **드라이버 + 단위 테스트**: `scripts/colab_job.py`, `scripts/tests/test_colab_job.py`(가짜 `colab` 실행 파일로 new 거절→다음 후보, max-wait 반환→재개, 실패 시 stop 호출, verify 판정을 검증). 완료 조건: `uv run python -m pytest scripts/tests` 통과, `python colab_job.py template | python -m json.tool` 성공.
2. **실기 도그푸딩**: `수학문제-md/_dogfood/colab-ocr/`에 `job.json`(MinerU basic, T4→cpu)을 두고 리드가 `run`으로 한 번, 그 다음 aorch dispatch 4라운드로 워커가 같은 명령을 부른다. 완료 조건: receipt `ok`, `verify` exit 0, dispatch `ok: true`, `colab sessions` 비어 있음, 벽시계가 09-24의 85초 수준.
3. **SKILL.md 재작성**: 드라이버 중심으로 줄이고(명령 표, 매니페스트, receipt 계약, 재개 규칙), 업스트림 규칙은 "드라이버가 못 하는 것"(콘솔 점검, 복구)만 남긴다. `aorch update --user` 반영, `npm run check` 통과.
4. **CHANGELOG·메모리**.

## 범위 밖 (이번에 안 함)

QuantPilot·OCR 레시피, 세션 리스·유휴 감시, Drive 캐시, aorch 라우터의 `remote-compute` 태그, compute unit 예산 가드(잔액 0에서도 T4가 되므로 지금은 판단 근거 없음).
