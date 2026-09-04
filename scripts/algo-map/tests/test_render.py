"""Tests for the standalone algorithm-map renderer and checker."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path


ALGO_MAP_DIR = Path(__file__).parents[1]
RENDER = ALGO_MAP_DIR / "render.py"
CHECK = ALGO_MAP_DIR.parent / "algo-map-check.mjs"
ECHARTS_URL = "https://cdnjs.cloudflare.com/ajax/libs/echarts/6.1.0/echarts.min.js"


def _trace() -> dict:
    bars = []
    for index in range(40):
        close = 100 + index * 0.5
        bar_date = date(2026, 1, 1) + timedelta(days=index)
        bars.append(
            {
                "symbol": "005930",
                "date": bar_date.isoformat(),
                "open": close - 0.2,
                "high": close + 1,
                "low": close - 1,
                "close": close,
                "volume": 1000 + index,
                "indicators": {
                    "sma20": close - 1,
                    "sma120": None,
                    "rsi": 30 + index,
                    "atr": 1.2,
                    "volume_ratio": 1.1,
                },
                "action": "exit" if index == 20 else "hold",
                "reason_codes": ["take_profit"] if index == 20 else ["waiting"],
                "reason": "literal </script> survives" if index == 0 else "대기",
                "current_weight_before": 0.2,
            }
        )
    return {
        "meta": {
            "strategy_id": "pullback_trend_v2",
            "recipe_version": "2",
            "parameters": {},
            "symbols": ["005930"],
            "bar_count": 40,
            "evaluated_bar_count": 25,
            "stubbed_gates": ["market_closed"],
        },
        "bars": bars,
        "signals": [],
        "backtest": {
            "equity_curve": [
                {"date": "2026-01-01", "equity": 1000},
                {"date": "2026-01-20", "equity": 1010},
                {"date": "2026-02-09", "equity": 1005},
            ],
            "trades": [
                {
                    "symbol": "005930",
                    "side": "buy",
                    "status": "filled",
                    "signal_date": "2026-01-04",
                    "fill_date": "2026-01-05",
                    "signal_price": 101.5,
                    "limit_price": 102,
                    "fill_price": 102,
                    "quantity": 2,
                },
                {
                    "symbol": "005930",
                    "side": "sell",
                    "status": "filled",
                    "signal_date": "2026-01-20",
                    "fill_date": "2026-01-21",
                    "signal_price": 110,
                    "limit_price": 110,
                    "fill_price": 110,
                    "quantity": 2,
                },
                {
                    "symbol": "005930",
                    "side": "buy",
                    "status": "blocked",
                    "signal_date": "2026-01-25",
                    "fill_date": None,
                    "signal_price": 112,
                    "reason": "market_closed",
                },
            ],
            "metrics": {"total_return": 0.005, "max_drawdown": -0.00495},
            "warnings": [],
            "assumptions": {},
        },
        "acceptance": {
            "checks": [
                {"name": "return", "passed": True, "observed": 0.005, "threshold": 0},
                {"name": "drawdown", "passed": False, "observed": -0.2, "threshold": -0.1},
            ]
        },
        "walk_forward": [
            {
                "window": {
                    "window_id": "w1",
                    "train_start": "2025-01-01",
                    "train_end": "2025-12-31",
                    "test_start": "2026-01-01",
                    "test_end": "2026-01-31",
                },
                "metrics": {"total_return": 0.005},
                "acceptance": {"checks": [{"name": "return", "passed": True}]},
            }
        ],
    }


def _rules() -> dict:
    return {
        "thresholds": [
            {
                "name": "entry_rsi_max",
                "default": 35,
                "bounds": {"ge": 0, "le": 100},
                "used_by_evaluate": True,
                "used_elsewhere": [],
            },
            {
                "name": "hard_stop_loss_fraction",
                "default": 0.08,
                "bounds": {"gt": 0, "lt": 1},
                "used_by_evaluate": False,
                "used_elsewhere": ["quantpilot/packages/risk/position_exit.py"],
            },
        ],
        "decisions": [
            {
                "condition": "request.rsi <= rules.entry_rsi_max",
                "action": "buy_ready",
                "reason_codes": ["rsi_pullback"],
                "line": 42,
            }
        ],
        "mermaid": "flowchart TD\n  A{RSI?} -->|Yes| B[buy_ready]",
    }


def _render(tmp_path: Path, fragment: bool = False) -> Path:
    trace_path = tmp_path / "trace.json"
    rules_path = tmp_path / "rules.json"
    output = tmp_path / ("fragment.html" if fragment else "page.html")
    trace_path.write_text(json.dumps(_trace(), ensure_ascii=False), encoding="utf-8")
    rules_path.write_text(json.dumps(_rules(), ensure_ascii=False), encoding="utf-8")
    command = [sys.executable, str(RENDER), "--trace", str(trace_path), "--rules", str(rules_path), "--out", str(output)]
    if fragment:
        command.append("--fragment")
    subprocess.run(command, check=True, capture_output=True, text=True, encoding="utf-8")
    return output


def test_render_full_page_and_checker(tmp_path: Path) -> None:
    output = _render(tmp_path)
    page = output.read_text(encoding="utf-8")

    assert "<title>pullback_trend_v2 알고리즘 지도</title>" in page
    assert "<h1>pullback_trend_v2 알고리즘 지도</h1>" in page
    assert re.findall(r'\b(?:src|href)=["\'](https?://[^"\']+)', page) == [ECHARTS_URL]
    assert page.count("data-trade-marker") == 2
    for name in ("thresholds", "decisions", "acceptance"):
        assert f'data-table="{name}"' in page
    assert "literal <\\/script> survives" in page
    assert "literal </script> survives" not in page

    checked = subprocess.run(
        ["node", str(CHECK), str(output)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert checked.returncode == 0, checked.stderr


def test_render_fragment_has_artifact_body_without_document_wrappers(tmp_path: Path) -> None:
    page = _render(tmp_path, fragment=True).read_text(encoding="utf-8")

    assert "pullback_trend_v2 알고리즘 지도" in page
    assert "https://cdnjs.cloudflare.com" in page
    assert "<html" not in page.lower()
    assert "</html>" not in page.lower()
    assert "<head" not in page.lower()
    assert "<body" not in page.lower()
    assert "<!doctype" not in page.lower()
    assert "<meta" not in page.lower()

    checked = subprocess.run(
        ["node", str(CHECK), str(_render(tmp_path, fragment=True))],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert checked.returncode == 0, checked.stderr
