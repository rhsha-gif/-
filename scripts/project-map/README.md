# project-map

한 저장소를 `map.json`(모듈 노드·import 엣지·파일별 지표·문제 목록)과 자체 완결 HTML 대시보드 한 장으로 바꾼다. 설계와 실측 원장은 `docs/plans/2026-09-03-project-map.md`.

```
collect.py  --config configs/<project>.json --out <snapshot>/raw     # 도구 5개 실행, raw/*.json
merge.py    --config configs/<project>.json --raw <snapshot>/raw --out <snapshot>/map.json
render.py   --map <snapshot>/map.json --out <snapshot>/dashboard.html
```

`<snapshot>` = `%USERPROFILE%/.local/share/aorch-tools/map/<project>/<YYYY-MM-DD>`. 저장소 안에는 아무것도 쓰지 않는다.

## 도구 환경 (저장소 밖, 2026-09-03 의존성 심사 통과 버전으로 고정)

```bash
# Python 도구 venv
uv venv "C:/Users/goyan/.local/share/aorch-tools/.venv" --python 3.11
uv pip install --python "C:/Users/goyan/.local/share/aorch-tools/.venv/Scripts/python.exe" "grimp==3.16" "vulture==2.16" pytest

# scc 4.0.0 (winget 매니페스트 SHA256이 GitHub checksums.txt와 일치 확인됨)
winget install --id BenBoyter.scc --exact
# 설치 경로: %LOCALAPPDATA%/Microsoft/WinGet/Packages/BenBoyter.scc_Microsoft.Winget.Source_8wekyb3d8bbwe/scc.exe (새 셸에서는 PATH에 있음)

# dependency-cruiser 18.2.0 — 무설치 실행. typescript는 대상 웹 프로젝트의 node_modules에서 NODE_PATH로 노출한다.
# (`npx -p typescript`로 같이 설치해도 dependency-cruiser가 자기 위치 기준 require라 못 찾는다 — 실측)
cd <web root> && NODE_PATH="$(pwd -W)/node_modules" npx -y -p dependency-cruiser@18.2.0 depcruise --info
```

제거: venv 디렉터리 삭제, `winget uninstall --id BenBoyter.scc --exact`, `npm cache clean --force`.

## 검증

```bash
TOOLS="C:/Users/goyan/.local/share/aorch-tools/.venv/Scripts/python.exe"
"$TOOLS" -m pytest -q -p no:cacheprovider scripts/project-map/tests
```

테스트는 도구를 실행하지 않고 `tests/fixtures/`의 canned 출력만 쓴다. 실제 수집은 리드가 대상 저장소에서 돌려 모듈 수를 `git ls-files`와 대조한다.

## 주의

- grimp는 기본으로 cwd에 `.grimp_cache/`를 만든다. `collect.py`는 `cache_dir`을 스냅샷 안으로 돌린다.
- dependency-cruiser는 기본으로 node_modules까지 따라간다(QuantPilot web: 1,107 모듈). `--do-not-follow node_modules --exclude node_modules`를 건다.
- scc `--by-file --format json`은 언어별 목록 안에 `Files[]`(Location·Lines·Code·Complexity)를 준다.
