#!/usr/bin/env python3
"""Collect raw repository metrics for the project-map pipeline.

The collector deliberately stores each tool's native data with minimal
transformation. Later pipeline stages can then merge the datasets without
having to rerun expensive repository analysis.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath


VULTURE_LINE = re.compile(
    r"^(?P<path>.+):(?P<line>\d+): unused (?P<kind>[^']+?) "
    r"'(?P<name>[^']+)' \((?P<confidence>\d+)% confidence\)$"
)


def count_churn(git_log: str) -> dict[str, int]:
    """Count changed-file occurrences in ``git log --name-only`` output."""

    counts: dict[str, int] = {}
    for raw_path in git_log.splitlines():
        path = raw_path.strip().replace("\\", "/")
        if path:
            counts[path] = counts.get(path, 0) + 1
    return counts


def parse_vulture_line(line: str) -> dict[str, object] | None:
    """Parse one supported vulture finding, returning ``None`` otherwise."""

    match = VULTURE_LINE.fullmatch(line.strip())
    if match is None:
        return None
    return {
        "path": match.group("path").replace("\\", "/"),
        "line": int(match.group("line")),
        "kind": match.group("kind"),
        "name": match.group("name"),
        "confidence": int(match.group("confidence")),
    }


def match_entry_point(path: str, entry_points: dict[str, str]) -> str | None:
    """Return the kind whose configured glob matches a repository path."""

    candidate = PurePosixPath(path.replace("\\", "/"))
    for kind, pattern in entry_points.items():
        if candidate.match(pattern.replace("\\", "/")):
            return kind
    return None


def resolve_module_path(module: str, root: Path) -> str | None:
    """Resolve a dotted Python module to a repository-relative source path."""

    base = root.joinpath(*module.split("."))
    candidates = (base.with_suffix(".py"), base / "__init__.py")
    for candidate in candidates:
        if candidate.is_file():
            return candidate.relative_to(root).as_posix()
    return None


def flatten_scc_files(payload: object) -> list[dict[str, object]]:
    """Flatten validated ``scc --by-file`` language blocks into file records."""

    if not isinstance(payload, list):
        raise ValueError("scc output must be a list of language blocks")
    files: list[dict[str, object]] = []
    for block in payload:
        if not isinstance(block, dict) or not isinstance(block.get("Files"), list):
            raise ValueError("each scc language block must contain a Files array")
        for file_record in block["Files"]:
            if not isinstance(file_record, dict):
                raise ValueError("each scc Files entry must be an object")
            required = ("Location", "Lines", "Code", "Complexity")
            if any(key not in file_record for key in required):
                raise ValueError("scc file entry is missing a required metric")
            files.append(file_record)
    return files


def _run(
    argv: list[str],
    *,
    cwd: Path,
    accepted_codes: tuple[int, ...] = (0,),
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run a tool without a shell and reject unexpected exit codes."""

    result = subprocess.run(
        argv,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=False,
        check=False,
    )
    if result.returncode not in accepted_codes:
        detail = result.stderr.strip() or result.stdout.strip() or "no output"
        raise RuntimeError(f"exit {result.returncode}: {detail}")
    return result


def _load_json_output(output: str, tool: str) -> object:
    """Decode a tool's stdout as JSON with a concise contextual error."""

    try:
        return json.loads(output)
    except json.JSONDecodeError as error:
        raise ValueError(f"{tool} returned invalid JSON: {error.msg}") from error


def _path_is_under(path: str, directories: list[str]) -> bool:
    """Return whether a normalized repository path is within a directory."""

    normalized = path.replace("\\", "/").rstrip("/")
    return any(
        normalized == directory.replace("\\", "/").rstrip("/")
        or normalized.startswith(directory.replace("\\", "/").rstrip("/") + "/")
        for directory in directories
    )


def collect_scc(config: dict[str, object], root: Path, executable: str) -> tuple[object, int]:
    """Run scc and return its validated native JSON plus its file count."""

    python_config = config["python"]
    web_config = config["web"]
    targets = list(python_config["src_dirs"])
    targets.append(str(PurePosixPath(web_config["root"]) / web_config["src"]))
    result = _run(
        [executable, "--format", "json", "--by-file", *targets], cwd=root
    )
    payload = _load_json_output(result.stdout, "scc")
    return payload, len(flatten_scc_files(payload))


def collect_churn(config: dict[str, object], root: Path) -> tuple[dict[str, int], int]:
    """Run git log and count changes per repository-relative path."""

    days = int(config["churn_days"])
    result = _run(
        ["git", "log", f"--since={days}.days", "--name-only", "--format="],
        cwd=root,
    )
    counts = count_churn(result.stdout)
    return counts, len(counts)


def collect_grimp(
    config: dict[str, object], root: Path, cache_dir: Path
) -> tuple[dict[str, object], int]:
    """Build the Python import graph and derive entry/test annotations.

    QuantPilot's dependencies need not be imported: grimp statically examines
    modules after the repository root is made importable on ``sys.path``.
    """

    import grimp

    python_config = config["python"]
    package = str(python_config["package"])
    sys.path.insert(0, str(root))
    try:
        graph = grimp.build_graph(
            package,
            include_external_packages=False,
            cache_dir=str(cache_dir),
        )
    finally:
        if sys.path and sys.path[0] == str(root):
            sys.path.pop(0)

    modules = sorted(graph.modules)
    module_paths: dict[str, str] = {}
    for module in modules:
        path = resolve_module_path(module, root)
        if path is None:
            raise ValueError(f"could not resolve module path for {module}")
        module_paths[module] = path

    imports = [
        [importer, imported]
        for importer in modules
        for imported in sorted(graph.find_modules_directly_imported_by(importer))
    ]
    entry_points = {
        module: kind
        for module, path in module_paths.items()
        if (kind := match_entry_point(path, python_config["entry_points"])) is not None
    }
    # grimp naming: find_upstream_modules(m) = modules m imports (transitively);
    # find_downstream_modules(m) = modules that import m. "downstream" in this
    # payload means "reachable from the entry point through its imports".
    downstream = {
        module: sorted(graph.find_upstream_modules(module))
        for module in entry_points
    }

    test_prefixes = [
        directory.replace("\\", "/").strip("/").replace("/", ".")
        for directory in python_config["test_dirs"]
    ]
    source_modules = [
        module
        for module, path in module_paths.items()
        if _path_is_under(path, python_config["src_dirs"])
    ]
    test_upstream = {
        module: any(
            upstream == prefix or upstream.startswith(prefix + ".")
            for upstream in graph.find_downstream_modules(module)
            for prefix in test_prefixes
        )
        for module in source_modules
    }

    payload = {
        "modules": modules,
        "imports": imports,
        "entry_points": entry_points,
        "downstream": downstream,
        "test_upstream": test_upstream,
        "module_paths": module_paths,
    }
    return payload, len(modules)


def collect_vulture(config: dict[str, object], root: Path) -> tuple[list[dict[str, object]], int]:
    """Run vulture and parse its supported unused-code finding format."""

    source_dirs = list(config["python"]["src_dirs"])
    result = _run(
        [sys.executable, "-m", "vulture", *source_dirs, "--min-confidence", "60"],
        cwd=root,
        accepted_codes=(0, 3),
    )
    nonempty_lines = [line for line in result.stdout.splitlines() if line.strip()]
    findings = [
        finding
        for line in nonempty_lines
        if (finding := parse_vulture_line(line)) is not None
    ]
    if nonempty_lines and not findings:
        raise ValueError("vulture output contained no parseable findings")
    return findings, len(findings)


def collect_depcruise(config: dict[str, object], root: Path) -> tuple[list[object], int]:
    """Run dependency-cruiser and return its native modules array."""

    web_config = config["web"]
    web_root = root / str(web_config["root"])
    environment = os.environ.copy()
    environment["NODE_PATH"] = str((web_root / "node_modules").resolve())
    npx = "npx.cmd" if os.name == "nt" else "npx"
    result = _run(
        [
            npx,
            "-y",
            "-p",
            "dependency-cruiser@18.2.0",
            "depcruise",
            "--no-config",
            "--output-type",
            "json",
            "--ts-config",
            str(web_config.get("ts_config", "tsconfig.json")),
            "--do-not-follow",
            "node_modules",
            "--exclude",
            "node_modules",
            str(web_config["src"]),
        ],
        cwd=web_root,
        env=environment,
    )
    payload = _load_json_output(result.stdout, "dependency-cruiser")
    if not isinstance(payload, dict) or not isinstance(payload.get("modules"), list):
        raise ValueError("dependency-cruiser output must contain a modules array")
    modules = payload["modules"]
    return modules, len(modules)


def _write_json(path: Path, payload: object) -> None:
    """Write deterministic, human-readable UTF-8 JSON."""

    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def collect_versions(scc_executable: str, root: Path) -> dict[str, str]:
    """Return cheap version metadata without running repository analysis."""

    import grimp
    import vulture

    try:
        scc_version = _run([scc_executable, "--version"], cwd=root).stdout.strip()
    except (OSError, RuntimeError) as error:
        scc_version = f"unknown ({error})"
    return {
        "scc": scc_version,
        "grimp": str(getattr(grimp, "__version__", "unknown")),
        "vulture": str(getattr(vulture, "__version__", "unknown")),
        "dependency-cruiser": "18.2.0",
    }


def load_config(path: Path) -> dict[str, object]:
    """Load the collector configuration as a JSON object."""

    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("config must be a JSON object")
    return payload


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser."""

    parser = argparse.ArgumentParser(
        description="Collect raw inputs for a project-map snapshot."
    )
    parser.add_argument("--config", type=Path, required=True, help="project config JSON")
    parser.add_argument("--out", type=Path, required=True, help="snapshot output directory")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run all collectors, recording every failure before returning status 1."""

    args = build_parser().parse_args(argv)
    config = load_config(args.config)
    root = Path(str(config["root"]))
    raw_dir = args.out / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    scc_executable = os.environ.get("PROJECT_MAP_SCC", "scc")

    collectors = (
        ("scc", raw_dir / "scc.json", lambda: collect_scc(config, root, scc_executable)),
        ("churn", raw_dir / "churn.json", lambda: collect_churn(config, root)),
        (
            "grimp",
            raw_dir / "grimp.json",
            lambda: collect_grimp(config, root, args.out / ".grimp_cache"),
        ),
        ("vulture", raw_dir / "vulture.json", lambda: collect_vulture(config, root)),
        ("depcruise", raw_dir / "depcruise.json", lambda: collect_depcruise(config, root)),
    )

    failures: list[str] = []
    for name, output_path, collector in collectors:
        try:
            payload, count = collector()
        except Exception as error:  # Each tool must fail independently and visibly.
            failures.append(name)
            _write_json(output_path, {"error": str(error)})
            print(f"{name}: failed ({error})", file=sys.stderr)
        else:
            _write_json(output_path, payload)
            print(f"{name}: {count}")

    _write_json(raw_dir / "versions.json", collect_versions(scc_executable, root))
    if failures:
        print(f"failed tools: {', '.join(failures)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
