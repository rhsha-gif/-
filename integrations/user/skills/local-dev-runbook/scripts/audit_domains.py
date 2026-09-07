#!/usr/bin/env python3
"""Report likely hard-coded local/prod domain and origin strings."""

from __future__ import annotations

import argparse
import re
from pathlib import Path

DEFAULT_PATTERNS = [
    r"localhost",
    r"127\.0\.0\.1",
    r"https?://",
    r"wss?://",
    r"\b5173\b",
    r"\b3000\b",
    r"\b4173\b",
    r"\b5174\b",
]

SKIP_DIRS = {
    ".git",
    ".next",
    ".nuxt",
    ".turbo",
    ".vercel",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "vendor",
}

SKIP_EXTS = {
    ".avif",
    ".bin",
    ".bmp",
    ".gif",
    ".ico",
    ".jpg",
    ".jpeg",
    ".lock",
    ".pdf",
    ".png",
    ".svg",
    ".webp",
    ".zip",
}


def iter_files(root: Path):
    for path in root.rglob("*"):
        if path.is_dir():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.suffix.lower() in SKIP_EXTS:
            continue
        yield path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", default=".", help="Repository root to scan.")
    parser.add_argument(
        "--domain",
        action="append",
        default=[],
        help="Known production/preview domain string to include in the scan.",
    )
    args = parser.parse_args()

    root = Path(args.root).resolve()
    patterns = DEFAULT_PATTERNS + [re.escape(domain) for domain in args.domain]
    needle = re.compile("|".join(f"({pattern})" for pattern in patterns), re.IGNORECASE)
    count = 0

    for path in iter_files(root):
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        except OSError as exc:
            print(f"warn: cannot read {path}: {exc}")
            continue

        for line_no, line in enumerate(text.splitlines(), start=1):
            for match in needle.finditer(line):
                count += 1
                rel = path.relative_to(root)
                snippet = line.strip()
                print(f"{rel}:{line_no}:{match.start() + 1}: {match.group(0)} | {snippet}")

    print(f"\n{count} match(es)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
