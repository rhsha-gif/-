#!/usr/bin/env python3
"""Extract pullback-trend thresholds and decisions without importing the target."""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path
from typing import Any


SCHEMAS_PATH = Path("quantpilot/packages/core/schemas.py")
PULLBACK_PATH = Path("quantpilot/packages/core/signals/pullback_trend.py")
PACKAGES_PATH = Path("quantpilot/packages")
BOUNDS = ("ge", "le", "gt", "lt")
MIN_DECISION_BRANCHES = 4


def _source_text(source: str, node: ast.AST) -> str:
    """Return a node's source with whitespace collapsed to one line."""

    segment = ast.get_source_segment(source, node)
    if segment is None:
        segment = ast.unparse(node)
    return " ".join(segment.split())


def _literal_or_source(source: str, node: ast.AST) -> Any:
    """Return a JSON-compatible literal, falling back to source text."""

    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError):
        return _source_text(source, node)


def _find_named_node(tree: ast.Module, node_type: type[ast.AST], name: str) -> ast.AST:
    matches = [
        node
        for node in ast.walk(tree)
        if isinstance(node, node_type) and getattr(node, "name", None) == name
    ]
    if len(matches) != 1:
        raise ValueError(f"expected exactly one {name}, found {len(matches)}")
    return matches[0]


def _is_field_call(node: ast.AST | None) -> bool:
    if not isinstance(node, ast.Call):
        return False
    return (
        isinstance(node.func, ast.Name)
        and node.func.id == "Field"
        or isinstance(node.func, ast.Attribute)
        and node.func.attr == "Field"
    )


def _repo_matches(repo: Path, name: str, definition_path: Path) -> list[str]:
    """Find Python files outside the schema definition that mention a field."""

    packages = repo / PACKAGES_PATH
    if not packages.is_dir():
        raise ValueError(f"packages directory not found: {packages}")
    pattern = re.compile(rf"\b{re.escape(name)}\b")
    matches: list[str] = []
    for path in sorted(packages.rglob("*.py")):
        if path == definition_path:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if pattern.search(text):
            matches.append(path.relative_to(repo).as_posix())
    return matches


def extract_thresholds(
    repo: Path, schemas_path: Path, evaluate_source: str, module_source: str = ""
) -> list[dict[str, Any]]:
    source = schemas_path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(schemas_path))
    class_node = _find_named_node(
        tree, ast.ClassDef, "PullbackTrendDecisionRules"
    )
    assert isinstance(class_node, ast.ClassDef)

    thresholds: list[dict[str, Any]] = []
    for statement in class_node.body:
        if (
            not isinstance(statement, ast.AnnAssign)
            or not isinstance(statement.target, ast.Name)
            or not _is_field_call(statement.value)
        ):
            continue
        call = statement.value
        assert isinstance(call, ast.Call)
        keywords = {keyword.arg: keyword.value for keyword in call.keywords if keyword.arg}
        default_node = keywords.get("default")
        if default_node is None and call.args:
            default_node = call.args[0]
        if default_node is None:
            raise ValueError(f"Field {statement.target.id} has no default")

        name = statement.target.id
        in_decision = re.search(rf"\b{re.escape(name)}\b", evaluate_source) is not None
        in_module = re.search(rf"\b{re.escape(name)}\b", module_source) is not None
        # The decision function reads some fields directly and others through the
        # indicator builders in the same module (window lengths); both count as
        # "used by evaluate" for the owner, but the table says which.
        used_by_evaluate = in_decision or in_module
        usage = "decision" if in_decision else ("indicator" if in_module else "elsewhere")
        bounds = {
            bound: _literal_or_source(source, keywords[bound])
            for bound in BOUNDS
            if bound in keywords
        }
        thresholds.append(
            {
                "name": name,
                "type": _source_text(source, statement.annotation),
                "default": _literal_or_source(source, default_node),
                "bounds": bounds,
                "used_by_evaluate": used_by_evaluate,
                "usage": usage,
                "used_elsewhere": (
                    []
                    if used_by_evaluate
                    else _repo_matches(repo, name, schemas_path)
                ),
            }
        )

    if not thresholds:
        raise ValueError("PullbackTrendDecisionRules contains no Field declarations")
    return thresholds


def _call_name(call: ast.Call) -> str | None:
    if isinstance(call.func, ast.Name):
        return call.func.id
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    return None


class _DecisionVisitor(ast.NodeVisitor):
    def __init__(self, source: str) -> None:
        self.source = source
        self.conditions: list[ast.If] = []
        self.return_depth = 0
        self.decisions: list[dict[str, Any]] = []
        self.seen_calls: set[int] = set()

    def visit_If(self, node: ast.If) -> None:  # noqa: N802
        self.conditions.append(node)
        for statement in node.body:
            self.visit(statement)
        for statement in node.orelse:
            self.visit(statement)
        self.conditions.pop()

    def visit_Return(self, node: ast.Return) -> None:  # noqa: N802
        self.return_depth += 1
        self.generic_visit(node)
        self.return_depth -= 1

    def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
        keywords = {keyword.arg: keyword.value for keyword in node.keywords if keyword.arg}
        is_decision_call = _call_name(node) == "_decision"
        is_action_return = self.return_depth > 0 and "action" in keywords
        if (is_decision_call or is_action_return) and id(node) not in self.seen_calls:
            self.seen_calls.add(id(node))
            self._record(node, keywords)
        self.generic_visit(node)

    def _record(self, node: ast.Call, keywords: dict[str, ast.AST]) -> None:
        action_node = keywords.get("action")
        if action_node is None:
            raise ValueError(f"decision branch at line {node.lineno} lacks action")
        if (
            not isinstance(action_node, ast.Attribute)
            or not isinstance(action_node.value, ast.Name)
            or action_node.value.id != "SignalAction"
        ):
            raise ValueError(
                f"decision branch at line {node.lineno} has unsupported action"
            )

        reason_codes_node = keywords.get("reason_codes")
        if isinstance(reason_codes_node, (ast.List, ast.Tuple)):
            reason_codes: Any = [
                _literal_or_source(self.source, item)
                for item in reason_codes_node.elts
            ]
        elif reason_codes_node is None:
            reason_codes = []
        else:
            reason_codes = _source_text(self.source, reason_codes_node)

        reason_node = keywords.get("reason")
        reason = (
            _literal_or_source(self.source, reason_node)
            if reason_node is not None
            else ""
        )
        condition_node = self.conditions[-1] if self.conditions else None
        self.decisions.append(
            {
                "action": action_node.attr,
                "reason_codes": reason_codes,
                "reason": reason,
                "condition": (
                    _source_text(self.source, condition_node.test)
                    if condition_node is not None
                    else "otherwise"
                ),
                "line": condition_node.lineno if condition_node is not None else node.lineno,
            }
        )


def extract_decisions(source: str, function_node: ast.FunctionDef) -> list[dict[str, Any]]:
    visitor = _DecisionVisitor(source)
    for statement in function_node.body:
        visitor.visit(statement)
    return visitor.decisions


def _mermaid_label(value: object) -> str:
    return str(value).replace("\\", "\\\\").replace('"', "'")


def build_mermaid(decisions: list[dict[str, Any]]) -> str:
    if len(decisions) * 2 > 20:
        raise ValueError("decision flow would exceed the 20-node Mermaid limit")
    lines = ["flowchart TD"]
    for index, decision in enumerate(decisions, start=1):
        condition = _mermaid_label(decision["condition"])
        reason_codes = decision["reason_codes"]
        if isinstance(reason_codes, list):
            reason_code = ", ".join(map(str, reason_codes)) or "no reason code"
        else:
            reason_code = str(reason_codes)
        leaf = _mermaid_label(f"{decision['action']} / {reason_code}")
        lines.append(f'  C{index}{{"{condition}"}}')
        lines.append(f'  C{index} -->|Yes| L{index}["{leaf}"]')
        if index < len(decisions):
            lines.append(f"  C{index} -->|No| C{index + 1}")
    return "\n".join(lines)


def extract_rules(repo: Path) -> dict[str, Any]:
    repo = repo.resolve()
    schemas_path = repo / SCHEMAS_PATH
    pullback_path = repo / PULLBACK_PATH
    if not schemas_path.is_file():
        raise ValueError(f"schemas file not found: {schemas_path}")
    if not pullback_path.is_file():
        raise ValueError(f"pullback file not found: {pullback_path}")

    pullback_source = pullback_path.read_text(encoding="utf-8")
    pullback_tree = ast.parse(pullback_source, filename=str(pullback_path))
    function_node = _find_named_node(
        pullback_tree, ast.FunctionDef, "evaluate_pullback_signal"
    )
    assert isinstance(function_node, ast.FunctionDef)
    function_source = ast.get_source_segment(pullback_source, function_node)
    if function_source is None or function_node.end_lineno is None:
        raise ValueError("could not recover evaluate_pullback_signal source")

    decisions = extract_decisions(pullback_source, function_node)
    return {
        "source": {
            "schemas_path": SCHEMAS_PATH.as_posix(),
            "pullback_path": PULLBACK_PATH.as_posix(),
            "function_lines": [function_node.lineno, function_node.end_lineno],
        },
        "thresholds": extract_thresholds(repo, schemas_path, function_source, pullback_source),
        "decisions": decisions,
        "mermaid": build_mermaid(decisions),
    }


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        payload = extract_rules(args.repo)
        decision_count = len(payload["decisions"])
        if decision_count < MIN_DECISION_BRANCHES:
            raise ValueError(
                f"found {decision_count} decision branches; "
                f"at least {MIN_DECISION_BRANCHES} are required"
            )
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    except (OSError, SyntaxError, ValueError) as error:
        print(f"rules.py: error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
