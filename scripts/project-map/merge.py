#!/usr/bin/env python3
"""Merge canned project analysis outputs into a validated ``map.json``.

This stage is intentionally side-effect free apart from writing its output. It
does not rerun repository analysis: every metric and dependency comes from the
raw JSON files produced by ``collect.py``.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import re
from datetime import datetime
from pathlib import Path, PurePosixPath


SEVERITY_ORDER = {"low": 0, "standard": 1, "high": 2, "critical": 3}
# Within one severity the owner reads hotspots first; orphans last.
CATEGORY_ORDER = {"hotspot": 0, "cycle": 1, "giant": 2, "untested": 3, "dead": 4, "orphan": 5}
FIX_COST_ORDER = {"low": 0, "standard": 1, "high": 2, "critical": 3}
TEST_SUFFIXES = (".test", ".spec")


class SchemaValidationError(ValueError):
    """Raised when a generated map does not satisfy the bundled schema."""


def _type_matches(value: object, expected: str) -> bool:
    """Return whether ``value`` has the requested JSON Schema primitive type."""

    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "null":
        return value is None
    raise SchemaValidationError(f"unsupported schema type: {expected}")


def validate_against_schema(value: object, schema: dict[str, object], path: str = "$") -> None:
    """Validate the schema features used by ``schema.json`` recursively.

    The project deliberately avoids a jsonschema dependency. This validator
    supports the closed-object, required-key, primitive type, array item, enum,
    minimum, string-length, and pattern constraints used by the bundled schema.
    """

    expected = schema.get("type")
    if isinstance(expected, str) and not _type_matches(value, expected):
        raise SchemaValidationError(f"{path}: expected {expected}")

    enum = schema.get("enum")
    if isinstance(enum, list) and value not in enum:
        raise SchemaValidationError(f"{path}: value {value!r} is not in enum {enum!r}")

    if isinstance(value, dict):
        required = schema.get("required", [])
        if isinstance(required, list):
            missing = [key for key in required if key not in value]
            if missing:
                raise SchemaValidationError(f"{path}: missing required keys {missing!r}")

        properties = schema.get("properties", {})
        if not isinstance(properties, dict):
            properties = {}
        additional = schema.get("additionalProperties", True)
        unknown = set(value) - set(properties)
        if additional is False and unknown:
            raise SchemaValidationError(f"{path}: unknown keys {sorted(unknown)!r}")

        for key, item in value.items():
            child_schema = properties.get(key)
            if child_schema is None and isinstance(additional, dict):
                child_schema = additional
            if isinstance(child_schema, dict):
                validate_against_schema(item, child_schema, f"{path}.{key}")

    if isinstance(value, list):
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                validate_against_schema(item, item_schema, f"{path}[{index}]")

    if isinstance(value, str):
        minimum_length = schema.get("minLength")
        if isinstance(minimum_length, int) and len(value) < minimum_length:
            raise SchemaValidationError(f"{path}: string is shorter than {minimum_length}")
        pattern = schema.get("pattern")
        if isinstance(pattern, str) and re.search(pattern, value) is None:
            raise SchemaValidationError(f"{path}: string does not match {pattern!r}")

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        minimum = schema.get("minimum")
        if isinstance(minimum, (int, float)) and value < minimum:
            raise SchemaValidationError(f"{path}: value is below minimum {minimum}")


def validate_map(payload: object, schema_path: Path | None = None) -> None:
    """Validate a map payload against the bundled project-map schema."""

    path = schema_path or Path(__file__).with_name("schema.json")
    schema = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(schema, dict):
        raise SchemaValidationError("schema root must be an object")
    validate_against_schema(payload, schema)


def _normalized(path: str) -> str:
    """Return a stable relative POSIX spelling for a collected path."""

    value = path.replace("\\", "/")
    while value.startswith("./"):
        value = value[2:]
    return value.strip("/")


def _is_under(path: str, directory: str) -> bool:
    """Return whether a normalized path lies in a normalized directory."""

    child = _normalized(path)
    parent = _normalized(directory)
    return child == parent or child.startswith(parent + "/")


def _load_json(path: Path) -> object:
    """Load one raw JSON file and reject collector failure receipts."""

    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict) and set(payload) == {"error"}:
        raise ValueError(f"collector failure in {path.name}: {payload['error']}")
    return payload


def _flatten_scc(payload: object) -> dict[str, tuple[int, int]]:
    """Index scc line and complexity metrics by repository-relative path."""

    if not isinstance(payload, list):
        raise ValueError("scc.json must contain language blocks")
    metrics: dict[str, tuple[int, int]] = {}
    for block in payload:
        if not isinstance(block, dict) or not isinstance(block.get("Files"), list):
            raise ValueError("scc language blocks must contain Files arrays")
        for record in block["Files"]:
            if not isinstance(record, dict):
                raise ValueError("scc file records must be objects")
            try:
                path = _normalized(str(record["Location"]))
                lines = int(record["Lines"])
                complexity = int(record["Complexity"])
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError("invalid scc file record") from error
            metrics[path] = (lines, complexity)
    return metrics


def _python_package(path: str, package_name: str) -> str:
    """Derive the display package from a Python repository path."""

    parts = list(PurePosixPath(_normalized(path)).parts)
    if parts:
        parts[-1] = PurePosixPath(parts[-1]).stem
    if parts and parts[-1] == "__init__":
        parts.pop()
    root_part = package_name.split(".", 1)[0]
    if parts and parts[0] == root_part:
        parts = parts[1:]
    if not parts:
        return root_part
    if parts[0] == "jobs":
        return "jobs"
    return "/".join(parts[:2])


def _ts_source(source: str, web_root: str) -> str:
    """Convert a dependency-cruiser source to a web-root-relative node id."""

    normalized = _normalized(source)
    prefix = _normalized(web_root)
    if normalized.startswith(prefix + "/"):
        return normalized[len(prefix) + 1 :]
    return normalized


def _test_basename(path: str) -> str:
    """Return a module basename with a conventional test suffix removed."""

    stem = PurePosixPath(path).stem
    for suffix in TEST_SUFFIXES:
        if stem.endswith(suffix):
            return stem[: -len(suffix)]
    return stem


def _ts_tested(source: str, all_sources: set[str], src_dir: str) -> bool:
    """Infer TS test coverage from dependency-cruiser's module inventory.

    A source is considered tested when a same-basename module appears below
    ``src/test`` or a ``__tests__`` directory. This deliberately simple rule
    avoids rescanning the repository during the merge stage.
    """

    basename = _test_basename(source)
    test_root = _normalized(src_dir) + "/test/"
    for candidate in all_sources:
        parts = PurePosixPath(candidate).parts
        is_test_location = candidate.startswith(test_root) or "__tests__" in parts
        if is_test_location and _test_basename(candidate) == basename:
            return True
    return False


def _entry_kinds(path: str, entry_points: dict[str, object]) -> list[str]:
    """Return all configured entry-point kinds whose glob matches ``path``."""

    candidate = PurePosixPath(_normalized(path))
    return sorted(
        kind
        for kind, pattern in entry_points.items()
        if isinstance(pattern, str) and candidate.match(_normalized(pattern))
    )


def _sanitize_problem_id(prefix: str, node_id: str) -> str:
    """Build a schema-safe problem id without changing the node id itself."""

    safe = re.sub(r"[^A-Za-z0-9._/-]", "-", node_id)
    return f"{prefix}-{safe}"


def _strong_components(node_ids: set[str], edges: list[dict[str, str]]) -> list[set[str]]:
    """Find strongly connected components with Tarjan's linear-time algorithm."""

    adjacency = {node_id: [] for node_id in node_ids}
    for edge in edges:
        if edge["from"] in adjacency and edge["to"] in adjacency:
            adjacency[edge["from"]].append(edge["to"])

    index = 0
    indices: dict[str, int] = {}
    lowlinks: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    components: list[set[str]] = []

    def visit(node_id: str) -> None:
        nonlocal index
        indices[node_id] = index
        lowlinks[node_id] = index
        index += 1
        stack.append(node_id)
        on_stack.add(node_id)

        for target in adjacency[node_id]:
            if target not in indices:
                visit(target)
                lowlinks[node_id] = min(lowlinks[node_id], lowlinks[target])
            elif target in on_stack:
                lowlinks[node_id] = min(lowlinks[node_id], indices[target])

        if lowlinks[node_id] == indices[node_id]:
            component: set[str] = set()
            while True:
                member = stack.pop()
                on_stack.remove(member)
                component.add(member)
                if member == node_id:
                    break
            components.append(component)

    for node_id in sorted(node_ids):
        if node_id not in indices:
            visit(node_id)
    return components


def _mark_cycles(node_ids: set[str], edges: list[dict[str, str]]) -> None:
    """Relabel exactly the edges internal to cyclic components."""

    component_for: dict[str, int] = {}
    cyclic_components: set[int] = set()
    for number, component in enumerate(_strong_components(node_ids, edges)):
        for node_id in component:
            component_for[node_id] = number
        if len(component) >= 2:
            cyclic_components.add(number)

    for edge in edges:
        source = edge["from"]
        target = edge["to"]
        component = component_for.get(source)
        is_self_loop = source == target
        is_component_edge = component is not None and component == component_for.get(target)
        if is_self_loop or (is_component_edge and component in cyclic_components):
            edge["kind"] = "cycle"


def _problem(
    prefix: str,
    node: dict[str, object],
    severity: str,
    fix_cost: str,
    axis: str,
    evidence: str,
    proposal: str,
) -> dict[str, str]:
    """Create one schema-compatible problem record."""

    node_id = str(node["id"])
    return {
        "id": _sanitize_problem_id(prefix, node_id),
        "severity": severity,
        "fixCost": fix_cost,
        "axis": axis,
        "location": str(node["path"]),
        "evidence": evidence,
        "proposal": proposal,
        "nodeId": node_id,
    }


def _build_problems(
    nodes: list[dict[str, object]],
    edges: list[dict[str, str]],
    config: dict[str, object],
) -> list[dict[str, str]]:
    """Apply the six fixed project-map problem rules and sort their output."""

    thresholds = config["thresholds"]
    big_file_lines = int(thresholds["big_file_lines"])
    hotspot_top = int(thresholds["hotspot_top"])
    dead_confidence = int(thresholds["dead_confidence"])
    problems: list[dict[str, str]] = []

    generated_globs = [str(pattern) for pattern in config.get("generated", [])]

    def _is_generated(node: dict[str, object]) -> bool:
        return any(
            fnmatch.fnmatch(str(node[key]), pattern)
            for key in ("path", "id")
            for pattern in generated_globs
        )

    hotspots = sorted(
        (node for node in nodes if int(node["churn"]) > 0 and not _is_generated(node)),
        key=lambda node: (-int(node["lines"]) * int(node["churn"]), str(node["id"])),
    )[:hotspot_top]
    for node in hotspots:
        lines = int(node["lines"])
        churn = int(node["churn"])
        problems.append(
            _problem(
                "hotspot", node, "standard", "high", "overengineering",
                f"{lines} lines x {churn} changes = {lines * churn} hotspot score.",
                "Review this frequently changed large module and split responsibilities where useful.",
            )
        )

    source_dirs = [str(path) for path in config["python"]["src_dirs"]]
    cycle_counts: dict[str, int] = {}
    incoming_ts: dict[str, int] = {
        str(node["id"]): 0 for node in nodes if node["kind"] == "ts-module"
    }
    for edge in edges:
        if edge["kind"] == "cycle":
            cycle_counts[edge["from"]] = cycle_counts.get(edge["from"], 0) + 1
            cycle_counts[edge["to"]] = cycle_counts.get(edge["to"], 0) + 1
        if edge["to"] in incoming_ts and edge["from"] != edge["to"]:
            incoming_ts[edge["to"]] += 1

    for node in nodes:
        lines = int(node["lines"])
        if lines > big_file_lines and not _is_generated(node):
            problems.append(
                _problem(
                    "giant", node, "standard", "high", "overengineering",
                    f"{lines} lines exceeds the {big_file_lines}-line limit.",
                    "Split the module along its clearest responsibility boundary.",
                )
            )
        if (
            node["kind"] == "py-module"
            and any(_is_under(str(node["path"]), directory) for directory in source_dirs)
            and not bool(node["tested"])
            and PurePosixPath(str(node["path"])).name != "__init__.py"
        ):
            problems.append(
                _problem(
                    "untested", node, "standard", "standard", "correctness",
                    "0 upstream test modules were reported for this Python module.",
                    "Add a focused test that imports and exercises this module's behavior.",
                )
            )
        if str(node["id"]) in cycle_counts:
            count = cycle_counts[str(node["id"])]
            problems.append(
                _problem(
                    "cycle", node, "high", "standard", "overengineering",
                    f"{count} cycle-edge endpoints touch this module.",
                    "Break the import cycle by moving the shared dependency behind a lower-level boundary.",
                )
            )
        if node["dead"]:
            count = len(node["dead"])
            problems.append(
                _problem(
                    "dead", node, "low", "low", "correctness",
                    f"{count} unused names met the {dead_confidence}% confidence threshold.",
                    "Confirm the reported names are unused and remove them or document their dynamic use.",
                )
            )
        if (
            node["kind"] == "ts-module"
            and incoming_ts[str(node["id"])] == 0
            and "page" not in node["entry"]
            and not _is_ts_non_orphan_candidate(str(node["path"]))
        ):
            problems.append(
                _problem(
                    "orphan", node, "low", "low", "correctness",
                    "0 imports from other collected modules target this TypeScript module.",
                    "Remove the orphan or connect it from an intentional entry point.",
                )
            )

    return sorted(
        problems,
        key=lambda item: (
            -SEVERITY_ORDER[item["severity"]],
            CATEGORY_ORDER.get(item["id"].split("-", 1)[0], len(CATEGORY_ORDER)),
            FIX_COST_ORDER[item["fixCost"]],
            item["id"],
        ),
    )


def _is_ts_non_orphan_candidate(path: str) -> bool:
    """Files nobody imports by design: tests, test setup, typings, the Vite bootstrap."""
    name = path.replace("\\", "/").rsplit("/", 1)[-1]
    return (
        "/test/" in path.replace("\\", "/")
        or "/__tests__/" in path.replace("\\", "/")
        or ".test." in name
        or ".spec." in name
        or name.endswith(".d.ts")
        or name in {"main.tsx", "main.ts", "setup.ts"}
    )


def build_map(
    config: dict[str, object],
    raw_dir: Path,
    *,
    generated_at: str | None = None,
) -> dict[str, object]:
    """Merge all raw collector files into a deterministic map payload."""

    scc = _flatten_scc(_load_json(raw_dir / "scc.json"))
    churn_payload = _load_json(raw_dir / "churn.json")
    grimp = _load_json(raw_dir / "grimp.json")
    vulture = _load_json(raw_dir / "vulture.json")
    depcruise = _load_json(raw_dir / "depcruise.json")
    versions = _load_json(raw_dir / "versions.json")
    if not isinstance(churn_payload, dict):
        raise ValueError("churn.json must be an object")
    if not isinstance(grimp, dict):
        raise ValueError("grimp.json must be an object")
    if not isinstance(vulture, list):
        raise ValueError("vulture.json must be an array")
    if not isinstance(depcruise, list):
        raise ValueError("depcruise.json must be an array")
    if not isinstance(versions, dict):
        raise ValueError("versions.json must be an object")

    churn = {_normalized(str(path)): int(count) for path, count in churn_payload.items()}
    dead_by_path: dict[str, list[str]] = {}
    threshold = int(config["thresholds"]["dead_confidence"])
    for finding in vulture:
        if not isinstance(finding, dict):
            raise ValueError("vulture findings must be objects")
        if int(finding.get("confidence", -1)) >= threshold:
            path = _normalized(str(finding.get("path", "")))
            dead_by_path.setdefault(path, []).append(str(finding.get("name", "")))

    module_paths = grimp.get("module_paths")
    modules = grimp.get("modules")
    if not isinstance(module_paths, dict) or not isinstance(modules, list):
        raise ValueError("grimp.json must contain modules and module_paths")

    nodes: list[dict[str, object]] = []
    for module_value in modules:
        module = str(module_value)
        if module not in module_paths:
            raise ValueError(f"missing module path for {module}")
        path = _normalized(str(module_paths[module]))
        lines, complexity = scc.get(path, (0, 0))
        raw_entry = grimp.get("entry_points", {}).get(module)
        entry = [str(raw_entry)] if isinstance(raw_entry, str) else []
        nodes.append(
            {
                "id": module,
                "kind": "py-module",
                "path": path,
                "lines": lines,
                "complexity": complexity,
                "churn": churn.get(path, 0),
                "tested": bool(grimp.get("test_upstream", {}).get(module, False)),
                "entry": entry,
                "dead": sorted(set(dead_by_path.get(path, []))),
                "package": _python_package(path, str(config["python"]["package"])),
            }
        )

    web_root = _normalized(str(config["web"]["root"]))
    web_src = _normalized(str(config["web"]["src"]))
    dep_modules = [item for item in depcruise if isinstance(item, dict)]
    all_ts_sources = {
        _ts_source(str(item["source"]), web_root)
        for item in dep_modules
        if isinstance(item.get("source"), str)
    }
    collected_ts_sources = {
        source for source in all_ts_sources if _is_under(source, web_src)
    }
    for source in sorted(collected_ts_sources):
        repo_path = _normalized(f"{web_root}/{source}")
        lines, complexity = scc.get(repo_path, (0, 0))
        relative_under_src = source[len(web_src) :].lstrip("/")
        package = PurePosixPath(relative_under_src).parts[0] if relative_under_src else web_src
        nodes.append(
            {
                "id": source,
                "kind": "ts-module",
                "path": repo_path,
                "lines": lines,
                "complexity": complexity,
                "churn": churn.get(repo_path, 0),
                "tested": _ts_tested(source, all_ts_sources, web_src),
                "entry": _entry_kinds(source, config["web"]["entry_points"]),
                "dead": sorted(set(dead_by_path.get(repo_path, []))),
                "package": package,
            }
        )

    node_ids = {str(node["id"]) for node in nodes}
    edge_keys: set[tuple[str, str]] = set()
    imports = grimp.get("imports", [])
    if not isinstance(imports, list):
        raise ValueError("grimp imports must be an array")
    for item in imports:
        if isinstance(item, list) and len(item) == 2:
            source, target = str(item[0]), str(item[1])
            if source in node_ids and target in node_ids:
                edge_keys.add((source, target))

    for item in dep_modules:
        source_value = item.get("source")
        dependencies = item.get("dependencies", [])
        if not isinstance(source_value, str) or not isinstance(dependencies, list):
            continue
        source = _ts_source(source_value, web_root)
        for dependency in dependencies:
            if not isinstance(dependency, dict) or not isinstance(dependency.get("resolved"), str):
                continue
            target = _ts_source(str(dependency["resolved"]), web_root)
            if source in node_ids and target in node_ids:
                edge_keys.add((source, target))

    edges = [
        {"from": source, "to": target, "kind": "import"}
        for source, target in sorted(edge_keys)
    ]
    _mark_cycles(node_ids, edges)
    nodes.sort(key=lambda node: str(node["id"]))
    problems = _build_problems(nodes, edges, config)

    return {
        "meta": {
            "project": str(config["project"]),
            "generated_at": generated_at or datetime.now().astimezone().isoformat(),
            "tool_versions": {str(key): str(value) for key, value in versions.items()},
        },
        "nodes": nodes,
        "edges": edges,
        "problems": problems,
    }


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser."""

    parser = argparse.ArgumentParser(
        description="Merge raw project analysis into a validated map.json."
    )
    parser.add_argument("--config", type=Path, required=True, help="project config JSON")
    parser.add_argument("--raw", type=Path, required=True, help="directory of raw JSON files")
    parser.add_argument("--out", type=Path, required=True, help="output map.json path")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the merge CLI and validate the payload before writing it."""

    args = build_parser().parse_args(argv)
    config = json.loads(args.config.read_text(encoding="utf-8"))
    if not isinstance(config, dict):
        raise ValueError("config must be a JSON object")
    payload = build_map(config, args.raw)
    validate_map(payload)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
