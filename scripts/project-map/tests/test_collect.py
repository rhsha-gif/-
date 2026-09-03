"""Unit tests for project-map collection helpers.

These tests deliberately exercise canned text and temporary files only. They do
not invoke any of the external analysis tools used by the collector CLI.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


PROJECT_MAP_DIR = Path(__file__).parents[1]
FIXTURES = Path(__file__).parent / "fixtures"
sys.path.insert(0, str(PROJECT_MAP_DIR))

import collect  # noqa: E402


def test_count_churn_normalizes_and_counts_paths() -> None:
    git_log = (FIXTURES / "git-log.txt").read_text(encoding="utf-8")

    assert collect.count_churn(git_log) == {
        "quantpilot/packages/core.py": 2,
        "quantpilot/services/api.py": 2,
    }


def test_parse_vulture_line_accepts_supported_records() -> None:
    lines = (FIXTURES / "vulture.txt").read_text(encoding="utf-8").splitlines()

    assert collect.parse_vulture_line(lines[0]) == {
        "path": "quantpilot/packages/core.py",
        "line": 7,
        "kind": "function",
        "name": "helper",
        "confidence": 60,
    }
    assert collect.parse_vulture_line(lines[1]) == {
        "path": "quantpilot/services/models.py",
        "line": 12,
        "kind": "class",
        "name": "LegacyModel",
        "confidence": 100,
    }
    assert collect.parse_vulture_line(lines[2]) is None


def test_match_entry_point_uses_configured_globs() -> None:
    entry_points = {
        "job": "quantpilot/jobs/*.py",
        "router": "quantpilot/services/api/routers/*.py",
    }

    assert collect.match_entry_point("quantpilot/jobs/nightly.py", entry_points) == "job"
    assert (
        collect.match_entry_point(
            "quantpilot/services/api/routers/orders.py", entry_points
        )
        == "router"
    )
    assert collect.match_entry_point("quantpilot/packages/core.py", entry_points) is None


def test_resolve_module_path_handles_modules_and_packages(tmp_path: Path) -> None:
    package = tmp_path / "sample"
    subpackage = package / "nested"
    subpackage.mkdir(parents=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "worker.py").write_text("", encoding="utf-8")
    (subpackage / "__init__.py").write_text("", encoding="utf-8")

    assert collect.resolve_module_path("sample", tmp_path) == "sample/__init__.py"
    assert collect.resolve_module_path("sample.worker", tmp_path) == "sample/worker.py"
    assert (
        collect.resolve_module_path("sample.nested", tmp_path)
        == "sample/nested/__init__.py"
    )
    assert collect.resolve_module_path("sample.missing", tmp_path) is None


def test_flatten_scc_files_combines_language_blocks() -> None:
    payload = json.loads((FIXTURES / "scc.json").read_text(encoding="utf-8"))

    assert collect.flatten_scc_files(payload) == [
        {
            "Location": "quantpilot/packages/core.py",
            "Lines": 20,
            "Code": 15,
            "Complexity": 3,
        },
        {
            "Location": "quantpilot/apps/web/src/pages/index.tsx",
            "Lines": 12,
            "Code": 10,
            "Complexity": 1,
        },
    ]


def test_main_attempts_every_collector_and_writes_failure_receipt(
    tmp_path: Path, monkeypatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"root": str(tmp_path)}), encoding="utf-8")
    calls: list[str] = []

    def success(name: str):
        def collect_stub(*_args):
            calls.append(name)
            return {"tool": name}, 1

        return collect_stub

    def fail_grimp(*_args):
        calls.append("grimp")
        raise RuntimeError("canned grimp failure")

    monkeypatch.setattr(collect, "collect_scc", success("scc"))
    monkeypatch.setattr(collect, "collect_churn", success("churn"))
    monkeypatch.setattr(collect, "collect_grimp", fail_grimp)
    monkeypatch.setattr(collect, "collect_vulture", success("vulture"))
    monkeypatch.setattr(collect, "collect_depcruise", success("depcruise"))
    monkeypatch.setattr(
        collect,
        "collect_versions",
        lambda *_args: {"scc": "test", "grimp": "test", "vulture": "test"},
    )

    assert collect.main(["--config", str(config_path), "--out", str(tmp_path)]) == 1
    assert calls == ["scc", "churn", "grimp", "vulture", "depcruise"]
    raw_dir = tmp_path / "raw"
    assert json.loads((raw_dir / "grimp.json").read_text(encoding="utf-8")) == {
        "error": "canned grimp failure"
    }
    assert json.loads((raw_dir / "versions.json").read_text(encoding="utf-8"))[
        "scc"
    ] == "test"
    assert {
        path.name for path in raw_dir.iterdir()
    } == {
        "scc.json",
        "churn.json",
        "grimp.json",
        "vulture.json",
        "depcruise.json",
        "versions.json",
    }


def test_grimp_direction_tests_are_downstream_and_entries_reach_upstream(tmp_path, monkeypatch):
    """Lock grimp's naming: importers are downstream, imported modules are upstream."""
    import sys
    import grimp

    pkg = tmp_path / "pkgx"
    (pkg / "src").mkdir(parents=True)
    (pkg / "tests").mkdir()
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "src" / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "src" / "core.py").write_text("X = 1\n", encoding="utf-8")
    (pkg / "src" / "job.py").write_text("from pkgx.src import core\n", encoding="utf-8")
    (pkg / "tests" / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "tests" / "test_core.py").write_text("from pkgx.src import core\n", encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))
    graph = grimp.build_graph("pkgx", include_external_packages=False, cache_dir=str(tmp_path / ".grimp_cache"))

    assert "pkgx.tests.test_core" in graph.find_downstream_modules("pkgx.src.core")
    assert "pkgx.src.core" in graph.find_upstream_modules("pkgx.src.job")
    assert "pkgx.tests.test_core" not in graph.find_upstream_modules("pkgx.src.core")

