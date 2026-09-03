"""Tests for deterministic project-map merging using only canned raw data."""

from __future__ import annotations

import copy
import json
import re
import sys
from pathlib import Path

import pytest


PROJECT_MAP_DIR = Path(__file__).parents[1]
FIXTURES = Path(__file__).parent / "fixtures"
sys.path.insert(0, str(PROJECT_MAP_DIR))

import merge  # noqa: E402


def _fixture_map() -> dict[str, object]:
    config = json.loads((FIXTURES / "config-mini.json").read_text(encoding="utf-8"))
    return merge.build_map(
        config,
        FIXTURES / "raw-mini",
        generated_at="2026-09-03T12:00:00+09:00",
    )


def test_merge_builds_expected_nodes_edges_and_problems() -> None:
    payload = _fixture_map()

    assert len(payload["nodes"]) == 7
    cycle_edges = {
        (edge["from"], edge["to"])
        for edge in payload["edges"]
        if edge["kind"] == "cycle"
    }
    assert cycle_edges == {
        ("quantpilot.packages.core.alpha", "quantpilot.packages.core.beta"),
        ("quantpilot.packages.core.beta", "quantpilot.packages.core.alpha"),
    }
    assert [
        problem["nodeId"]
        for problem in payload["problems"]
        if problem["id"].startswith("untested-")
    ] == ["quantpilot.jobs.lonely"]

    problem_ids = [problem["id"] for problem in payload["problems"]]
    assert [item for item in problem_ids if item.startswith("hotspot-")] == [
        "hotspot-quantpilot.packages.core.alpha",
        "hotspot-src/pages/index.tsx",
    ]
    assert {item.split("-", 1)[0] for item in problem_ids} == {
        "hotspot", "giant", "untested", "cycle", "dead", "orphan"
    }
    pattern = re.compile(r"^(hotspot|giant|untested|cycle|dead|orphan)-[A-Za-z0-9._/-]+$")
    assert all(pattern.fullmatch(problem_id) for problem_id in problem_ids)
    merge.validate_map(payload)


def test_problem_sort_order_is_severity_then_category_then_cost_then_id() -> None:
    payload = _fixture_map()
    expected = sorted(
        payload["problems"],
        key=lambda item: (
            -merge.SEVERITY_ORDER[item["severity"]],
            merge.CATEGORY_ORDER.get(item["id"].split("-", 1)[0], len(merge.CATEGORY_ORDER)),
            merge.FIX_COST_ORDER[item["fixCost"]],
            item["id"],
        ),
    )

    assert payload["problems"] == expected


def test_validator_rejects_unknown_key_and_bad_enum() -> None:
    payload = _fixture_map()
    unknown = copy.deepcopy(payload)
    unknown["nodes"][0]["surprise"] = True
    bad_enum = copy.deepcopy(payload)
    bad_enum["edges"][0]["kind"] = "calls"

    with pytest.raises(merge.SchemaValidationError, match="unknown keys"):
        merge.validate_map(unknown)
    with pytest.raises(merge.SchemaValidationError, match="not in enum"):
        merge.validate_map(bad_enum)


def test_cli_writes_a_schema_valid_map(tmp_path: Path) -> None:
    output = tmp_path / "map.json"

    assert merge.main([
        "--config", str(FIXTURES / "config-mini.json"),
        "--raw", str(FIXTURES / "raw-mini"),
        "--out", str(output),
    ]) == 0
    payload = json.loads(output.read_text(encoding="utf-8"))
    merge.validate_map(payload)
    assert payload["meta"]["project"] == "mini"
