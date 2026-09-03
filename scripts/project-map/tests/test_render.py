"""Tests for the build-free project-map HTML renderer."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


PROJECT_MAP_DIR = Path(__file__).parents[1]
FIXTURES = Path(__file__).parent / "fixtures"
sys.path.insert(0, str(PROJECT_MAP_DIR))

import merge  # noqa: E402
import render  # noqa: E402


FONTS_URL = "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
ECHARTS_URL = "https://cdnjs.cloudflare.com/ajax/libs/echarts/6.1.0/echarts.min.js"


def _fixture_map() -> dict[str, object]:
    """Build a deterministic tiny map from the existing canned raw outputs."""

    config = json.loads((FIXTURES / "config-mini.json").read_text(encoding="utf-8"))
    payload = merge.build_map(
        config,
        FIXTURES / "raw-mini",
        generated_at="2026-09-03T12:00:00+09:00",
    )
    payload["problems"][0]["evidence"] += " literal </script> marker"
    return payload


def _embedded_map(document: str) -> dict[str, object]:
    """Extract the escaped JSON script as an HTML parser would expose its text."""

    match = re.search(
        r'<script id="map" type="application/json">(.*?)</script>',
        document,
        flags=re.DOTALL,
    )
    assert match is not None
    return json.loads(match.group(1).replace("<\\/", "</"))


def test_render_inlines_safe_map_title_rows_and_only_echarts(tmp_path: Path) -> None:
    payload = _fixture_map()
    map_path = tmp_path / "map.json"
    output_path = tmp_path / "dashboard.html"
    map_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    render.render_dashboard(map_path, output_path)
    document = output_path.read_text(encoding="utf-8")

    assert 'id="map"' in document
    assert ECHARTS_URL in document
    assert "mini 지도" in document
    assert document.count("data-problem-id=") == len(payload["problems"])
    external = re.findall(r"https?://[^\"'<>\s]+", document)
    assert external[0] == FONTS_URL and external[1:] == [ECHARTS_URL]
    assert _embedded_map(document) == payload
    assert "literal <\\/script> marker" in document


def test_render_accepts_an_empty_problem_list(tmp_path: Path) -> None:
    payload = _fixture_map()
    payload["problems"] = []
    map_path = tmp_path / "map.json"
    output_path = tmp_path / "dashboard.html"
    map_path.write_text(json.dumps(payload), encoding="utf-8")

    assert render.main(["--map", str(map_path), "--out", str(output_path)]) == 0
    document = output_path.read_text(encoding="utf-8")
    assert document.count("data-problem-id=") == 0
    assert _embedded_map(document)["problems"] == []


def test_fragment_mode_strips_document_wrappers(tmp_path: Path) -> None:
    map_path = tmp_path / "map.json"
    map_path.write_text(json.dumps(_fixture_map()), encoding="utf-8")
    output_path = tmp_path / "fragment.html"
    assert render.main(["--map", str(map_path), "--out", str(output_path), "--fragment"]) == 0
    fragment = output_path.read_text(encoding="utf-8")
    lowered = fragment.lower()
    for wrapper in ("<!doctype", "<html", "</html>", "<head>", "</head>", "<body", "</body>", "<meta charset", 'name="viewport"'):
        assert wrapper not in lowered
    assert fragment.lstrip().startswith("<title>")
    assert 'id="map"' in fragment and ECHARTS_URL in fragment

