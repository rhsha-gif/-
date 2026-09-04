"""Tests for static pullback rule extraction using only a miniature repository."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path


ALGO_MAP_DIR = Path(__file__).parents[1]
FIXTURE_REPO = Path(__file__).parent / "fixtures" / "mini_repo"
sys.path.insert(0, str(ALGO_MAP_DIR))

import rules  # noqa: E402


def test_extract_rules_reports_threshold_usage_decisions_and_flow() -> None:
    payload = rules.extract_rules(FIXTURE_REPO)

    assert [threshold["name"] for threshold in payload["thresholds"]] == [
        "entry_rsi_max",
        "exit_rsi_min",
        "min_volume_ratio",
        "hard_stop_loss_fraction",
        "max_candidates",
    ]
    used = [
        threshold["name"]
        for threshold in payload["thresholds"]
        if threshold["used_by_evaluate"]
    ]
    unused = {
        threshold["name"]: threshold["used_elsewhere"]
        for threshold in payload["thresholds"]
        if not threshold["used_by_evaluate"]
    }
    assert used == ["entry_rsi_max", "exit_rsi_min", "min_volume_ratio"]
    assert unused == {
        "hard_stop_loss_fraction": [
            "quantpilot/packages/risk/position_exit.py"
        ],
        "max_candidates": [],
    }
    assert payload["thresholds"][0] == {
        "name": "entry_rsi_max",
        "type": "float",
        "default": 35.0,
        "bounds": {"ge": 0.0, "le": 100.0},
        "used_by_evaluate": True,
        "usage": "decision",
        "used_elsewhere": [],
    }
    assert {
        threshold["name"]: threshold["usage"] for threshold in payload["thresholds"]
    } == {
        "entry_rsi_max": "decision",
        "exit_rsi_min": "decision",
        "min_volume_ratio": "decision",
        "hard_stop_loss_fraction": "elsewhere",
        "max_candidates": "elsewhere",
    }

    assert [decision["action"] for decision in payload["decisions"]] == [
        "blocked",
        "exit",
        "buy_ready",
    ]
    assert [decision["condition"] for decision in payload["decisions"]] == [
        "request.volume_ratio < rules.min_volume_ratio",
        "request.rsi >= rules.exit_rsi_min",
        "request.rsi <= rules.entry_rsi_max",
    ]
    assert [decision["line"] for decision in payload["decisions"]] == [
        3,
        9,
        15,
    ]
    assert payload["decisions"][0]["reason_codes"] == ["volume_too_low"]
    assert payload["decisions"][1]["reason_codes"] == "exit_reason_codes"
    assert payload["mermaid"].startswith("flowchart TD\n")
    assert payload["mermaid"].count('-->|Yes| L') == 3
    assert payload["mermaid"].count('-->|No| C') == 2


def test_cli_fails_closed_when_only_one_decision_branch(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "one-branch-repo"
    shutil.copytree(FIXTURE_REPO, repo)
    pullback = repo / rules.PULLBACK_PATH
    pullback.write_text(
        """def evaluate_pullback_signal(request, parameters):
    if request.blocked:
        return _decision(
            action=SignalAction.blocked,
            reason_codes=[\"blocked\"],
            reason=\"Blocked\",
        )
""",
        encoding="utf-8",
    )
    output = tmp_path / "rules.json"

    result = subprocess.run(
        [
            sys.executable,
            str(ALGO_MAP_DIR / "rules.py"),
            "--repo",
            str(repo),
            "--out",
            str(output),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )

    assert result.returncode == 1
    assert "found 1 decision branches; at least 4 are required" in result.stderr
    assert not output.exists()


def test_cli_fails_closed_when_a_decision_lacks_action(
    tmp_path: Path, capsys
) -> None:
    repo = tmp_path / "missing-action-repo"
    shutil.copytree(FIXTURE_REPO, repo)
    pullback = repo / rules.PULLBACK_PATH
    pullback.write_text(
        """def evaluate_pullback_signal(request, parameters):
    if request.blocked:
        return _decision(
            reason_codes=[\"blocked\"],
            reason=\"Blocked\",
        )
""",
        encoding="utf-8",
    )
    output = tmp_path / "rules.json"

    assert rules.main(["--repo", str(repo), "--out", str(output)]) == 1
    assert "decision branch at line 3 lacks action" in capsys.readouterr().err
    assert not output.exists()


def test_cli_writes_json_when_four_decisions_are_present(tmp_path: Path) -> None:
    repo = tmp_path / "four-branch-repo"
    shutil.copytree(FIXTURE_REPO, repo)
    pullback = repo / rules.PULLBACK_PATH
    source = pullback.read_text(encoding="utf-8")
    source += """
    if request.rsi > rules.entry_rsi_max:
        return _decision(
            action=SignalAction.hold,
            reason_codes=[\"waiting_for_pullback\"],
            reason=\"Waiting for entry RSI\",
        )
"""
    pullback.write_text(source, encoding="utf-8")
    output = tmp_path / "rules.json"

    assert rules.main(["--repo", str(repo), "--out", str(output)]) == 0
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert [decision["action"] for decision in payload["decisions"]] == [
        "blocked",
        "exit",
        "buy_ready",
        "hold",
    ]
