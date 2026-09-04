#!/usr/bin/env python3
"""Render a self-contained algorithm map from trace and rule JSON files."""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from pathlib import Path
from typing import Any


TEMPLATE_PATH = Path(__file__).with_name("template.html")
BODY_PATTERN = re.compile(
    r"<!-- ARTIFACT_BODY_START -->(.*)<!-- ARTIFACT_BODY_END -->", re.DOTALL
)


def _text(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, bool):
        return "✓" if value else "✗"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return str(value)


def _cell(value: Any) -> str:
    return html.escape(_text(value), quote=True)


def _bounds(bounds: Any) -> str:
    if not isinstance(bounds, dict) or not bounds:
        return "—"
    return ", ".join(f"{key} {value}" for key, value in bounds.items())


def _threshold_rows(rules: dict[str, Any]) -> str:
    thresholds = rules.get("thresholds", [])
    if not isinstance(thresholds, list):
        thresholds = []
    groups = [
        ("결정 함수가 읽는 필드 (판정 조건에 직접 등장)", "decision"),
        ("지표 계산에 쓰는 필드 (같은 모듈, 창 길이)", "indicator"),
        ("이 알고리즘이 읽지 않는 필드 (다른 모듈에서 사용)", "elsewhere"),
    ]
    rows: list[str] = []
    for label, usage in groups:
        items = [
            item
            for item in thresholds
            if isinstance(item, dict)
            and (item.get("usage") or ("decision" if item.get("used_by_evaluate") else "elsewhere")) == usage
        ]
        used = usage != "elsewhere"
        if not items:
            continue
        rows.append(
            f'<tr class="table-group"><th colspan="5" scope="rowgroup">{label}</th></tr>'
        )
        for item in items:
            elsewhere = item.get("used_elsewhere", [])
            elsewhere_text = ", ".join(map(str, elsewhere)) if isinstance(elsewhere, list) else _text(elsewhere)
            rows.append(
                "<tr>"
                f"<td><code>{_cell(item.get('name'))}</code></td>"
                f"<td>{_cell(item.get('default'))}</td>"
                f"<td>{_cell(_bounds(item.get('bounds')))}</td>"
                f"<td class=\"boolean\">{'✓' if used else '✗'}</td>"
                f"<td>{_cell(elsewhere_text or '—')}</td>"
                "</tr>"
            )
    if not rows:
        rows.append('<tr><td colspan="5" class="empty">임계값 없음</td></tr>')
    return "\n".join(rows)


def _decision_rows(rules: dict[str, Any]) -> str:
    decisions = rules.get("decisions", [])
    if not isinstance(decisions, list):
        decisions = []
    rows = []
    for order, item in enumerate(decisions, 1):
        if not isinstance(item, dict):
            continue
        rows.append(
            "<tr>"
            f"<td>{order}</td><td><code>{_cell(item.get('condition'))}</code></td>"
            f"<td><span class=\"action-pill\">{_cell(item.get('action'))}</span></td>"
            f"<td>{_cell(item.get('reason_codes', []))}</td>"
            f"<td>{_cell(item.get('line'))}</td>"
            "</tr>"
        )
    return "\n".join(rows) or '<tr><td colspan="5" class="empty">결정 규칙 없음</td></tr>'


def _acceptance_rows(trace: dict[str, Any]) -> str:
    acceptance = trace.get("acceptance", {})
    checks = acceptance.get("checks", []) if isinstance(acceptance, dict) else []
    if not isinstance(checks, list):
        checks = []
    rows = []
    for item in checks:
        if not isinstance(item, dict):
            continue
        passed = item.get("passed")
        state = "통과" if passed is True else "실패" if passed is False else "미정"
        css = "pass" if passed is True else "fail" if passed is False else "unknown"
        rows.append(
            "<tr>"
            f"<td>{_cell(item.get('name'))}</td>"
            f"<td class=\"{css}\">{state}</td>"
            f"<td>{_cell(item.get('observed'))}</td>"
            f"<td>{_cell(item.get('threshold'))}</td>"
            f"<td>{_cell(item.get('detail'))}</td>"
            "</tr>"
        )
    return "\n".join(rows) or '<tr><td colspan="5" class="empty">수용성 검사 없음</td></tr>'


def _trade_markers(trace: dict[str, Any]) -> str:
    backtest = trace.get("backtest", {})
    trades = backtest.get("trades", []) if isinstance(backtest, dict) else []
    if not isinstance(trades, list):
        trades = []
    markers = []
    for item in trades:
        if not isinstance(item, dict) or item.get("status") != "filled":
            continue
        label = " ".join(
            str(item.get(key, "")) for key in ("symbol", "side", "fill_date")
        ).strip()
        markers.append(f'<li data-trade-marker>{_cell(label)}</li>')
    return "\n".join(markers)


def _json_for_script(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace(
        "</", "<\\/"
    )


def render_page(trace: dict[str, Any], rules: dict[str, Any], fragment: bool, protocol: dict[str, Any] | None = None) -> str:
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    meta = trace.get("meta", {})
    strategy_id = meta.get("strategy_id", "전략") if isinstance(meta, dict) else "전략"
    title = f"{strategy_id} 알고리즘 지도"
    replacements = {
        "{{TITLE}}": html.escape(title, quote=True),
        "{{TRACE_JSON}}": _json_for_script(trace),
        "{{RULES_JSON}}": _json_for_script(rules),
        "{{PROTOCOL_JSON}}": _json_for_script(protocol) if protocol is not None else "null",
        "{{THRESHOLD_ROWS}}": _threshold_rows(rules),
        "{{DECISION_ROWS}}": _decision_rows(rules),
        "{{ACCEPTANCE_ROWS}}": _acceptance_rows(trace),
        "{{TRADE_MARKERS}}": _trade_markers(trace),
        "{{MERMAID}}": html.escape(_text(rules.get("mermaid", "flowchart TD"))),
    }
    rendered = template
    for marker, replacement in replacements.items():
        rendered = rendered.replace(marker, replacement)
    if not fragment:
        return rendered
    match = BODY_PATTERN.search(rendered)
    if match is None:
        raise ValueError("template artifact body markers are missing")
    title_tag = f"<title>{html.escape(title, quote=True)}</title>\n"
    return title_tag + match.group(1).strip() + "\n"


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trace", required=True, type=Path)
    parser.add_argument("--rules", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--fragment", action="store_true")
    parser.add_argument("--protocol", type=Path, default=None, help="protocol-vs-implementation JSON (optional)")
    return parser.parse_args(argv)


def _load_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected a JSON object: {path}")
    return value


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        page = render_page(_load_object(args.trace), _load_object(args.rules), args.fragment, _load_object(args.protocol) if args.protocol else None)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(page, encoding="utf-8")
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"render.py: error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
