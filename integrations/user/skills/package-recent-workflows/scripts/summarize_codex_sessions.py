#!/usr/bin/env python3
"""Summarize recent local Codex sessions for workflow packaging."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import re
from collections import Counter, defaultdict


CATEGORIES = {
    "docs-agents-handoff": [
        "agents",
        "roadmap",
        "progress",
        "handoff",
        "prompt",
        "harness",
        "진행상황",
        "다음 작업",
        "프롬프트",
        "문서",
        "구조",
    ],
    "stabilize-refactor-optimize": [
        "stabilize",
        "optimize",
        "refactor",
        "audit",
        "polish",
        "clean up",
        "최적화",
        "개선",
        "안정",
        "부채",
    ],
    "frontend-ui-screenshots": [
        "ui",
        "dashboard",
        "screen",
        "calendar",
        "graph",
        "chart",
        "frontend",
        "screenshot",
        "화면",
        "대시보드",
        "달력",
        "스크린샷",
    ],
    "run-debug-verify": [
        "fix",
        "debug",
        "diagnose",
        "verify",
        "build",
        "test",
        "실행",
        "디버깅",
        "오류",
        "검토",
        "확인",
        "점검",
    ],
    "deploy-env-integrations": [
        "vercel",
        "supabase",
        "github",
        "env",
        "deploy",
        "배포",
        "환경변수",
        "연결",
    ],
    "market-trading": [
        "market",
        "stock",
        "ticker",
        "quantpilot",
        "broker",
        "backtest",
        "주식",
        "투자",
        "매매",
        "종목",
    ],
    "ocr-documents": [
        "ocr",
        "pdf",
        "book2markdown",
        "document",
        "dcinside",
        "원드라이브",
    ],
    "flutter-android": [
        "flutter",
        "android",
        "kotlin",
        "dart",
        "apk",
    ],
    "skills-packaging": [
        "skill",
        "workflow",
        "plugin",
        "스킬",
        "워크플로우",
        "플러그인",
    ],
}


def parse_date(value: str | None, default: dt.datetime) -> dt.datetime:
    if not value:
        return default
    return dt.datetime.fromisoformat(value)


def iter_index_rows(index_path: pathlib.Path):
    if not index_path.exists():
        return
    pattern = re.compile(r'"id":"([^"]+)".*"thread_name":"(.*)","updated_at":"([^"]+)"')
    for line in index_path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            row = json.loads(line)
            yield row.get("updated_at", ""), row.get("thread_name", ""), row.get("id", "")
            continue
        except json.JSONDecodeError:
            pass
        match = pattern.search(line)
        if match:
            session_id, title, updated_at = match.groups()
            yield updated_at, title, session_id


def in_range(timestamp: str, since: dt.datetime, until: dt.datetime) -> bool:
    try:
        parsed = dt.datetime.fromisoformat(timestamp.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return True
    return since <= parsed <= until


def classify(title: str) -> list[str]:
    lower = title.lower()
    return [
        category
        for category, terms in CATEGORIES.items()
        if any(term.lower() in lower for term in terms)
    ]


def count_session_files(codex_home: pathlib.Path, since: dt.datetime, until: dt.datetime) -> tuple[int, int]:
    sessions = codex_home / "sessions"
    count = 0
    total_bytes = 0
    if not sessions.exists():
        return count, total_bytes
    for path in sessions.rglob("*.jsonl"):
        modified = dt.datetime.fromtimestamp(path.stat().st_mtime)
        if since <= modified <= until:
            count += 1
            total_bytes += path.stat().st_size
    return count, total_bytes


def list_skills(codex_home: pathlib.Path) -> list[str]:
    skills_dir = codex_home / "skills"
    if not skills_dir.exists():
        return []
    return sorted(
        path.name
        for path in skills_dir.iterdir()
        if path.is_dir() and path.name != ".system" and (path / "SKILL.md").exists()
    )


def count_ambient(codex_home: pathlib.Path) -> int:
    ambient = codex_home / "ambient-suggestions"
    if not ambient.exists():
        return 0
    return len(list(ambient.rglob("ambient-suggestions.json")))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-home", default=str(pathlib.Path.home() / ".codex"))
    parser.add_argument("--since", help="Inclusive start date, YYYY-MM-DD")
    parser.add_argument("--until", help="Inclusive end date, YYYY-MM-DD")
    parser.add_argument("--limit", type=int, default=8, help="Example titles per category")
    args = parser.parse_args()

    codex_home = pathlib.Path(args.codex_home).expanduser()
    now = dt.datetime.now()
    since = parse_date(args.since, now - dt.timedelta(days=30))
    until = parse_date(args.until, now) + dt.timedelta(days=1)

    rows = [
        (updated_at, title, session_id)
        for updated_at, title, session_id in iter_index_rows(codex_home / "session_index.jsonl")
        if in_range(updated_at, since, until)
    ]

    category_counts: Counter[str] = Counter()
    examples: dict[str, list[str]] = defaultdict(list)
    uncategorized: list[str] = []
    for updated_at, title, _session_id in rows:
        matched = classify(title)
        if not matched:
            if len(uncategorized) < args.limit:
                uncategorized.append(f"{updated_at[:10]} {title}")
            continue
        for category in matched:
            category_counts[category] += 1
            if len(examples[category]) < args.limit:
                examples[category].append(f"{updated_at[:10]} {title}")

    file_count, total_bytes = count_session_files(codex_home, since, until)
    skills = list_skills(codex_home)

    print(f"# Codex Workflow Evidence Summary")
    print()
    print(f"- Codex home: `{codex_home}`")
    print(f"- Window: `{since.date()}` to `{(until - dt.timedelta(days=1)).date()}`")
    print(f"- Session index rows: {len(rows)}")
    print(f"- Session files in window: {file_count} ({total_bytes:,} bytes)")
    print(f"- Installed personal skills: {len(skills)}")
    print(f"- Ambient suggestion files: {count_ambient(codex_home)}")
    print()
    print("## Category Counts")
    for category, count in category_counts.most_common():
        print(f"- {category}: {count}")
        for example in examples[category]:
            print(f"  - {example}")
    if uncategorized:
        print()
        print("## Uncategorized Examples")
        for example in uncategorized:
            print(f"- {example}")
    print()
    print("## Installed Skills")
    for name in skills:
        print(f"- {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
