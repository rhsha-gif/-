#!/usr/bin/env python3
"""Render a self-contained project-map dashboard from ``map.json``.

The dashboard has no build step: this module substitutes the escaped project
title, serialized map payload, and initial problem rows into ``template.html``.
All interactive views are constructed by the template's inline JavaScript.
"""

from __future__ import annotations

import argparse
import html
import json
import re
from pathlib import Path


TITLE_TOKEN = "{{PROJECT_TITLE}}"
MAP_TOKEN = "{{MAP_JSON}}"
PROBLEM_ROWS_TOKEN = "{{PROBLEM_ROWS}}"
PROBLEM_COLUMNS = (
    "id",
    "severity",
    "fixCost",
    "axis",
    "location",
    "evidence",
    "proposal",
)


def _problem_rows(problems: object) -> str:
    """Return safely escaped initial table rows in the map's existing order."""

    if not isinstance(problems, list):
        raise ValueError("map problems must be an array")
    rows: list[str] = []
    for problem in problems:
        if not isinstance(problem, dict):
            raise ValueError("map problems must contain objects")
        problem_id = html.escape(str(problem.get("id", "")), quote=True)
        node_id = html.escape(str(problem.get("nodeId", "")), quote=True)
        cells = "".join(
            f"<td>{html.escape(str(problem.get(column, '')))}</td>"
            for column in PROBLEM_COLUMNS
        )
        rows.append(
            f'<tr data-problem-id="{problem_id}" data-node-id="{node_id}">{cells}</tr>'
        )
    return "\n".join(rows)


def to_fragment(document: str) -> str:
    """Strip the document wrappers so the page can be published as an artifact body.

    The Artifact host wraps the file in its own doctype/html/head/body skeleton and
    supplies charset and viewport metas; what stays is title, fonts link, style,
    the body content and the scripts, in that order.
    """

    fragment = re.sub(r"<!doctype[^>]*>\s*", "", document, flags=re.I)
    fragment = re.sub(r"</?html[^>]*>\s*", "", fragment, flags=re.I)
    fragment = re.sub(r"</?head>\s*", "", fragment, flags=re.I)
    fragment = re.sub(r"</?body[^>]*>\s*", "", fragment, flags=re.I)
    fragment = re.sub(r'<meta (?:charset|name="viewport")[^>]*>\s*', "", fragment, flags=re.I)
    return fragment.strip() + "\n"


def render_dashboard(
    map_path: Path,
    out_path: Path,
    *,
    template_path: Path | None = None,
    fragment: bool = False,
) -> None:
    """Inline one map payload into the dashboard template and write the result."""

    payload = json.loads(map_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("map root must be an object")
    meta = payload.get("meta")
    if not isinstance(meta, dict) or not isinstance(meta.get("project"), str):
        raise ValueError("map meta.project must be a string")

    source = template_path or Path(__file__).with_name("template.html")
    template = source.read_text(encoding="utf-8")
    for token in (TITLE_TOKEN, MAP_TOKEN, PROBLEM_ROWS_TOKEN):
        if template.count(token) != 1:
            raise ValueError(f"template must contain exactly one {token} token")

    title = html.escape(f"{meta['project']} 지도")
    map_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    map_json = map_json.replace("</", "<\\/")
    rendered = template.replace(TITLE_TOKEN, title)
    rendered = rendered.replace(MAP_TOKEN, map_json)
    rendered = rendered.replace(PROBLEM_ROWS_TOKEN, _problem_rows(payload.get("problems")))
    if fragment:
        rendered = to_fragment(rendered)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(rendered, encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser for the renderer."""

    parser = argparse.ArgumentParser(
        description="Render map.json as a self-contained HTML project dashboard."
    )
    parser.add_argument("--map", dest="map_path", type=Path, required=True, help="input map.json")
    parser.add_argument("--out", dest="out_path", type=Path, required=True, help="output HTML")
    parser.add_argument("--fragment", action="store_true", help="emit the page body without doctype/html/head/body wrappers (Artifact publishing)")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the project-map renderer CLI."""

    args = build_parser().parse_args(argv)
    render_dashboard(args.map_path, args.out_path, fragment=args.fragment)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
