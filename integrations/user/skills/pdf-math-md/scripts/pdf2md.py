#!/usr/bin/env python3
"""pdf2md: deterministic tooling for the ``pdf-math-md`` skill.

The host agent (Claude Code / Antigravity) looks at one rendered page PNG at a
time and writes ``pages/NNN.json``.  This script owns everything that has to be
identical from page to page and from run to run:

* rendering (pypdfium2) and thumbnail sheets for page-range triage,
* run state and resume bookkeeping (``state.json``),
* schema validation plus code checks (LaTeX, numbering, continuation, bbox),
* prompt construction for a single page,
* deterministic assembly of the Markdown output tree.

Sections (in file order): constants, paths/state, rendering, schema
validator, checks, commands (state-level), prompt, assemble, CLI.

Only the standard library, ``pypdfium2`` and ``PIL`` are used.  The two
third-party modules are imported lazily inside the functions that need them
so that status/check/assemble-without-figures work without them.

Exit codes: 0 ok, 1 validation failure, 2 refusal (unknown slug, sha
mismatch, unconfirmed ranges, bad arguments).
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import re
import shutil
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any, Iterable

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

VERSION = "0.3.0"
SCRIPT_PATH = Path(__file__).resolve()
SCRIPT_DIR = SCRIPT_PATH.parent
SCHEMA_PATH = SCRIPT_DIR / "schema" / "page.schema.json"
PROMPT_PATH = SCRIPT_DIR / "prompt_page.md"
DEFAULT_OUT_ROOT = Path(r"C:\Users\goyan\OneDrive\문서\수학문제-md")

MAX_ATTEMPTS = 3
RANGE_KINDS = ("front", "problems", "solutions", "other")
TRANSCRIBE_KINDS = ("problems", "solutions")
PAGE_STATUSES = ("pending", "ok", "failed", "skipped")
THUMB_WIDTH = 300
THUMB_COLS = 3
THUMB_ROWS = 4
THUMBS_PER_SHEET = THUMB_COLS * THUMB_ROWS
CROP_PADDING = 0.015
PREV_TAIL_CHARS = 300
INDEX_BANNER = "> 자동 생성 파일 — 직접 편집하지 말고 볼트로 옮긴 뒤 편집한다."
NUMBER_RE = re.compile(r"^[0-9]+([.\-][0-9]+)*(\([a-z]\)|[a-z])?$")
PROOF_KO_TOKENS = ("증명", "보여라", "보이시오", "보이라", "보이세요")
PROOF_EN_RE = re.compile(r"\b(prove|show that|show)\b", re.I)
# Printed point labels: "(10점)", "(10 점)", "[15 pts]", "(20 points)", "(10 pt)", "5점", "10 pts".
POINTS_RE = re.compile(
    r"[\(\[（]\s*(\d+(?:\.\d+)?)\s*(?:점|pts?|points?)\s*[\)\]）]|(?<![\d.])(\d+(?:\.\d+)?)\s*(?:점|pts)(?![A-Za-z가-힣])",
    re.I,
)
# A printed number at the start of a statement whose ``number`` was left null.
LEADING_NUMBER_RE = re.compile(r"^\s*(?:\(\s*([0-9]{1,3}|[IVXLivxl]{1,7}|[①-⑳])\s*\)|([0-9]{1,3}|[IVXLivxl]{1,7}|[①-⑳])\s*[.)])\s+")
ROMAN_VALUES = {"i": 1, "v": 5, "x": 10, "l": 50}
SIMILARITY_THRESHOLD = 0.5
REVIEW_CONFIDENCE = 0.9
HANDWRITING_RE = re.compile(r"손글씨|필기|handwrit", re.I)

# Post-processing and sanitization constants
CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ufffd]")
PUA_RE = re.compile(r"[\ue000-\uf8ff]")
MATH_MARKERS_RE = re.compile(r"(\$|\\sum|\\frac|\\int|\\lim|\^|_\{)")
OPERATOR_LINEBREAK_RE = re.compile(r"\\(sum|int|lim|prod)\s*\n")
DANGLING_OPERATOR_RE = re.compile(r"[+\-=×·\\]\s*(\$|\$\$)?\s*$")
INSTRUCTION_KO_RE = re.compile(r"(구하여라|구하시오|증명하라|보여라|보이라|값은|무엇인가|대하여|다음|성립함을|동치임을|만족하는|구하라)")
INSTRUCTION_EN_RE = re.compile(r"\b(find|compute|prove|show|determine|evaluate|calculate|suppose|let|which|such that)\b", re.I)


class CLIError(Exception):
    """Raised by commands to stop with a message and an exit code."""

    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# Paths and state
# ---------------------------------------------------------------------------


def run_root() -> Path:
    """Directory holding one run directory per slug (outside OneDrive)."""
    env = os.environ.get("PDF2MD_RUN_ROOT")
    if env:
        return Path(env)
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "pdf2md"


def out_root() -> Path:
    """Directory holding one output directory per slug."""
    env = os.environ.get("PDF2MD_OUT_ROOT")
    return Path(env) if env else DEFAULT_OUT_ROOT


def slugify(text: str) -> str:
    """Lowercase, replace runs of non [a-z0-9가-힣] with '-', trim, max 60."""
    s = re.sub(r"[^a-z0-9가-힣]+", "-", text.lower()).strip("-")
    return s[:60].strip("-") or "pdf"


def run_dir(slug: str) -> Path:
    return run_root() / slug


def out_dir(slug: str) -> Path:
    """Per-slug output dir; a root stored in the run state (prepare/assemble --out-root, set-out-root) wins."""
    try:
        stored = (load_state(slug) or {}).get("out_root")
    except Exception:
        stored = None
    return (Path(stored) if stored else out_root()) / slug


def state_path(slug: str) -> Path:
    return run_dir(slug) / "state.json"


def page_png(slug: str, n: int) -> Path:
    return run_dir(slug) / "pages" / f"{n:03d}.png"


def page_json(slug: str, n: int) -> Path:
    return run_dir(slug) / "pages" / f"{n:03d}.json"


def merged_dir(slug: str, other: str) -> Path:
    return run_dir(slug) / "merged" / other


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_json_tolerant(path: Path) -> Any:
    """Read JSON tolerating a UTF-8 BOM and CRLF line endings."""
    text = path.read_bytes().decode("utf-8-sig").replace("\r\n", "\n")
    return json.loads(text, strict=False)


def roman_to_int(text: str) -> int | None:
    """``iv`` -> 4; None when the string is not a roman numeral (I..L range)."""
    s = text.lower()
    if not s or any(ch not in ROMAN_VALUES for ch in s):
        return None
    total = 0
    for i, ch in enumerate(s):
        v = ROMAN_VALUES[ch]
        if i + 1 < len(s) and v < ROMAN_VALUES[s[i + 1]]:
            total -= v
        else:
            total += v
    return total if total > 0 else None


def normalize_number(raw: Any) -> Any:
    """Map printed number variants onto the schema pattern.

    ``(3)``/``3)``/``3.`` -> ``3``, ``III``/``iii`` -> ``3``, ``①`` -> ``1``,
    ``문제 3``/``Q3``/``Problem 3`` -> ``3``. Strings already matching the
    pattern and non-strings are returned unchanged (schema validation reports them).
    """
    if not isinstance(raw, str):
        return raw
    s = raw.strip()
    if NUMBER_RE.match(s):
        return s
    s = re.sub(r"^(?:문제|problem|prob\.?|q)\s*", "", s, flags=re.I)
    s = re.sub(r"^[\(\[（]\s*|\s*[\)\]）]$", "", s)
    s = re.sub(r"\s*[.)]$", "", s)
    s = re.sub(r"\s+", "", s)
    if len(s) == 1 and "①" <= s <= "⑳":
        return str(ord(s) - 0x245F)
    m = re.fullmatch(r"([IVXLivxl]+)([.\-][0-9]+)*(\([a-z]\)|[a-z])?", s)
    if m:
        n = roman_to_int(m.group(1))
        if n is not None:
            return str(n) + s[len(m.group(1)):]
    return s if s else raw


def normalize_page_numbers(data: Any) -> list[str]:
    """Normalize every item ``number`` in place; returns notes for each change."""
    notes: list[str] = []
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        return notes
    for idx, it in enumerate(data["items"]):
        if not isinstance(it, dict):
            continue
        raw = it.get("number")
        new = normalize_number(raw)
        if new != raw:
            it["number"] = new
            notes.append(f"item[{idx}]: number {raw!r} normalized to {new!r}")
    return notes


def read_page_data(path: Path) -> tuple[Any, list[str]]:
    """Read a page JSON and normalize printed number variants; returns (data, notes)."""
    data = read_json_tolerant(path)
    return data, normalize_page_numbers(data)


def dump_json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write via ``.tmp`` then ``os.replace``; retry 3x for OneDrive locks."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    last: Exception | None = None
    for _ in range(3):
        try:
            os.replace(tmp, path)
            return
        except PermissionError as exc:  # pragma: no cover - OneDrive lock
            last = exc
            time.sleep(0.2)
    raise last  # type: ignore[misc]


def atomic_write_text(path: Path, text: str) -> None:
    atomic_write_bytes(path, text.encode("utf-8"))


def new_page_record() -> dict:
    return {
        "status": "pending",
        "attempts": 0,
        "errors": [],
        "warnings": [],
        "reason": None,
        "force_reason": None,
        "history": [],
        "json_sha256": None,
        "last_problem_after": None,
        "last_solution_after": None,
        "chapter_after": None,
        "group_after": 0,
        "solution_group_after": 0,
        "last_item": None,
    }


def new_state(slug: str, pdf_path: Path, sha: str, page_count: int, dpi: int) -> dict:
    return {
        "schema_version": 1,
        "slug": slug,
        "pdf_path": str(pdf_path),
        "pdf_sha256": sha,
        "page_count": page_count,
        "dpi": dpi,
        "ranges": {"spec": None, "confirmed": False, "kinds": {}},
        "pages": {str(i): new_page_record() for i in range(1, page_count + 1)},
        "merged": [],
    }


def load_state(slug: str) -> dict | None:
    p = state_path(slug)
    if not p.is_file():
        return None
    return read_json_tolerant(p)


def save_state(state: dict) -> None:
    atomic_write_text(state_path(state["slug"]), dump_json(state))


def load_state_guarded(slug: str) -> dict:
    """Load state and refuse when the source PDF changed since ``prepare``."""
    state = load_state(slug)
    if state is None:
        raise CLIError(2, f"unknown slug '{slug}': no state at {state_path(slug)}; run prepare first")
    pdf = Path(state["pdf_path"])
    if pdf.is_file():
        sha = sha256_file(pdf)
        if sha != state["pdf_sha256"]:
            raise CLIError(
                2,
                f"PDF changed since prepare: state sha {state['pdf_sha256']} != file sha {sha} "
                f"({pdf}); run `prepare <pdf> --slug {slug} --reset` to start over",
            )
    return state


def page_rec(state: dict, n: int) -> dict:
    return state["pages"][str(n)]


def page_numbers(state: dict) -> list[int]:
    return list(range(1, state["page_count"] + 1))


def page_kind(state: dict, n: int) -> str | None:
    return state["ranges"]["kinds"].get(str(n))


def prev_ok_page(state: dict, n: int) -> int | None:
    for p in range(n - 1, 0, -1):
        if page_rec(state, p)["status"] == "ok":
            return p
    return None


def next_page(state: dict) -> int | None:
    for p in page_numbers(state):
        rec = page_rec(state, p)
        if rec["status"] == "pending":
            return p
        if rec["status"] == "failed" and rec["attempts"] < MAX_ATTEMPTS:
            return p
    return None


def json_is_stale(slug: str, n: int, rec: dict) -> bool:
    jp = page_json(slug, n)
    if not jp.is_file() or not rec.get("json_sha256"):
        return False
    return sha256_file(jp) != rec["json_sha256"]


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def render_missing_pages(pdf_path: Path, slug: str, dpi: int) -> tuple[int, int]:
    """Render every page PNG that does not exist yet. Returns (count, rendered)."""
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(pdf_path))
    try:
        count = len(doc)
        rendered = 0
        for i in range(count):
            target = page_png(slug, i + 1)
            if target.is_file():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            page = doc[i]
            bitmap = page.render(scale=dpi / 72)
            img = bitmap.to_pil().convert("RGB")
            tmp = target.with_name(target.name + ".tmp")
            img.save(tmp, format="PNG")
            os.replace(tmp, target)
            rendered += 1
        return count, rendered
    finally:
        doc.close()


def build_thumb_sheets(slug: str, page_count: int) -> int:
    """Build 3x4 thumbnail sheets (page number top-left). Returns sheet count."""
    from PIL import Image, ImageDraw, ImageFont

    try:
        font = ImageFont.load_default(size=28)
    except TypeError:  # pragma: no cover - old Pillow
        font = ImageFont.load_default()
    sheets = (page_count + THUMBS_PER_SHEET - 1) // THUMBS_PER_SHEET
    tdir = run_dir(slug) / "thumbs"
    for s in range(sheets):
        target = tdir / f"sheet-{s + 1:02d}.png"
        if target.is_file():
            continue
        first = s * THUMBS_PER_SHEET + 1
        last = min(page_count, first + THUMBS_PER_SHEET - 1)
        thumbs: list[tuple[int, Image.Image]] = []
        for n in range(first, last + 1):
            with Image.open(page_png(slug, n)) as im:
                ratio = THUMB_WIDTH / im.width
                th = im.convert("RGB").resize((THUMB_WIDTH, max(1, round(im.height * ratio))))
            thumbs.append((n, th))
        cell_h = max(t.height for _, t in thumbs)
        gap = 10
        sheet = Image.new(
            "RGB",
            (THUMB_COLS * (THUMB_WIDTH + gap) + gap, THUMB_ROWS * (cell_h + gap) + gap),
            (200, 200, 200),
        )
        draw = ImageDraw.Draw(sheet)
        for k, (n, th) in enumerate(thumbs):
            col, row = k % THUMB_COLS, k // THUMB_COLS
            x = gap + col * (THUMB_WIDTH + gap)
            y = gap + row * (cell_h + gap)
            sheet.paste(th, (x, y))
            label = f"p{n:03d}"
            box = draw.textbbox((x + 4, y + 4), label, font=font)
            draw.rectangle((box[0] - 3, box[1] - 3, box[2] + 3, box[3] + 3), fill=(255, 255, 0))
            draw.text((x + 4, y + 4), label, fill=(0, 0, 0), font=font)
        tdir.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".tmp")
        sheet.save(tmp, format="PNG")
        os.replace(tmp, target)
    return sheets


# ---------------------------------------------------------------------------
# Schema validator (JSON Schema 2020-12 subset)
# ---------------------------------------------------------------------------


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def _type_name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def _is_type(value: Any, name: str) -> bool:
    actual = _type_name(value)
    if name == "number":
        return actual in ("integer", "number")
    return actual == name


def _child(path: str, key: str) -> str:
    return f"{path}.{key}" if path else key


def validate_schema(instance: Any, schema: dict, path: str = "") -> list[str]:
    """Validate ``instance`` against a schema subset; return error strings.

    Supported keywords: type (incl. list), const, enum, required, properties,
    additionalProperties:false, items, minimum, maximum, minItems, maxItems,
    minLength, maxLength, pattern.
    """
    errors: list[str] = []
    label = path or "$"
    t = schema.get("type")
    if t is not None:
        types = t if isinstance(t, list) else [t]
        if not any(_is_type(instance, x) for x in types):
            errors.append(f"{label}: expected {'|'.join(types)}, got {_type_name(instance)}")
            return errors
    if "const" in schema and instance != schema["const"]:
        errors.append(f"{label}: must be {json.dumps(schema['const'])}")
    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{label}: must be one of {', '.join(json.dumps(v) for v in schema['enum'])}")
    if isinstance(instance, dict):
        for req in schema.get("required", []):
            if req not in instance:
                errors.append(f"{_child(path, req)}: required property missing")
        props = schema.get("properties", {})
        for key in sorted(instance):
            if key in props:
                errors.extend(validate_schema(instance[key], props[key], _child(path, key)))
            elif schema.get("additionalProperties") is False:
                errors.append(f"{_child(path, key)}: additional property not allowed")
    elif isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{label}: needs at least {schema['minItems']} items")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            errors.append(f"{label}: needs at most {schema['maxItems']} items")
        if "items" in schema:
            for i, elem in enumerate(instance):
                errors.extend(validate_schema(elem, schema["items"], f"{path}[{i}]"))
    elif isinstance(instance, str):
        if "minLength" in schema and len(instance) < schema["minLength"]:
            errors.append(f"{label}: must not be shorter than {schema['minLength']} characters")
        if "maxLength" in schema and len(instance) > schema["maxLength"]:
            errors.append(f"{label}: must not be longer than {schema['maxLength']} characters")
        if "pattern" in schema and not re.search(schema["pattern"], instance):
            errors.append(f"{label}: does not match pattern {schema['pattern']}")
    elif isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            errors.append(f"{label}: must be >= {schema['minimum']}")
        if "maximum" in schema and instance > schema["maximum"]:
            errors.append(f"{label}: must be <= {schema['maximum']}")
    return errors


# ---------------------------------------------------------------------------
# Checks: LaTeX
# ---------------------------------------------------------------------------


def strip_code_fences(text: str) -> str:
    text = re.sub(r"```.*?```", "", text, flags=re.S)
    # An unclosed fence hides the rest of the text.
    return re.sub(r"```.*\Z", "", text, flags=re.S)


def _inline_span_blank_lines(text: str) -> bool:
    """True when some inline ``$...$`` span contains a blank line."""
    i, mode, start = 0, None, 0
    while i < len(text):
        ch = text[i]
        if ch == "\\":
            i += 2
            continue
        if text.startswith("$$", i):
            if mode == "display":
                mode = None
            elif mode is None:
                mode = "display"
            i += 2
            continue
        if ch == "$":
            if mode == "inline":
                if re.search(r"\n[ \t]*\n", text[start:i]):
                    return True
                mode = None
            elif mode is None:
                mode = "inline"
                start = i + 1
        i += 1
    return False


def check_latex(text: str) -> tuple[list[str], list[str]]:
    """Return (errors, warnings) for LaTeX delimiters in a Markdown string."""
    errors: list[str] = []
    warnings: list[str] = []
    t = strip_code_fences(text)
    if len(re.findall(r"(?<!\\)\$", t)) % 2:
        errors.append("unbalanced `$` (escape a literal dollar as `\\$`)")
    if len(re.findall(r"(?<!\\)\$\$", t)) % 2:
        errors.append("unbalanced `$$`")
    stripped = t.replace("\\\\", "").replace("\\{", "").replace("\\}", "")
    depth = 0
    for ch in stripped:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth < 0:
                break
    if depth != 0:
        errors.append("unbalanced braces `{}`")
    lefts = len(re.findall(r"\\left(?![A-Za-z])", t))
    rights = len(re.findall(r"\\right(?![A-Za-z])", t))
    if lefts != rights:
        errors.append(f"\\left count {lefts} != \\right count {rights}")
    stack: list[str] = []
    env_ok = True
    for m in re.finditer(r"\\(begin|end)\{([^}]*)\}", t):
        if m.group(1) == "begin":
            stack.append(m.group(2))
        elif not stack or stack.pop() != m.group(2):
            env_ok = False
            break
    if not env_ok or stack:
        errors.append("\\begin{X}/\\end{X} do not match")
    for line in t.splitlines():
        if "$$" in line and line.replace("$$", "").strip():
            warnings.append("`$$` shares a line with other text; put display math on its own lines")
            break
    if _inline_span_blank_lines(t):
        errors.append("inline `$...$` span contains a blank line")
    return errors, warnings


# ---------------------------------------------------------------------------
# Checks: numbering, continuation, figures, emptiness
# ---------------------------------------------------------------------------


def leading_int(number: str) -> int:
    m = re.match(r"[0-9]+", number)
    return int(m.group(0)) if m else 0


def bbox_is_degenerate(bbox: list[float]) -> bool:
    x0, y0, x1, y1 = bbox
    w, h = x1 - x0, y1 - y0
    return x0 >= x1 or y0 >= y1 or w < 0.02 or h < 0.02 or w * h > 0.9


def _md_fields(item: dict) -> Iterable[tuple[str, str]]:
    yield "statement_md", item.get("statement_md", "")
    yield "solution_md", item.get("solution_md", "")
    for j, part in enumerate(item.get("parts", [])):
        yield f"parts[{j}].statement_md", part.get("statement_md", "")
        yield f"parts[{j}].solution_md", part.get("solution_md", "")


def _tail(text: str) -> str:
    text = text.strip()
    return text[-PREV_TAIL_CHARS:] if text else ""


def run_page_checks(state: dict, n: int, data: dict) -> tuple[list[str], list[str], dict]:
    """Code checks after schema validation. Returns (errors, warnings, snapshot)."""
    errors: list[str] = []
    warnings: list[str] = []
    tag = f"P{n:03d}"
    items: list[dict] = data["items"]

    # 1. page number
    if data["page"] != n:
        errors.append(f"{tag}: page field is {data['page']}, expected {n}")

    prev = prev_ok_page(state, n)
    prev_rec = page_rec(state, prev) if prev else None
    last = dict(prev_rec["last_problem_after"]) if prev_rec and prev_rec["last_problem_after"] else None
    last_sol = dict(prev_rec["last_solution_after"]) if prev_rec and prev_rec["last_solution_after"] else None
    cur_chapter = prev_rec["chapter_after"] if prev_rec else None
    # Sheet groups: an exam sheet / exercise set whose numbering starts over. They carry no
    # name (problem-bank output); they only scope gap checks, solution matching and points.
    group = int(prev_rec.get("group_after", 0)) if prev_rec else 0
    sgroup = int(prev_rec.get("solution_group_after", 0)) if prev_rec else 0
    if prev is not None and page_kind(state, n) != page_kind(state, prev):
        group += 1  # a range-kind boundary (problems <-> solutions block) is a sheet boundary
        sgroup += 1
        last = None
        last_sol = None
    allow_gap = "allow-gap" in data.get("page_notes", "")
    heading_on_page = False

    for idx, it in enumerate(items):
        where = f"{tag}/item[{idx}]"
        kind = it["kind"]

        # 0. printed number left out / chapter invented
        if kind in ("problem", "solution") and it["number"] is None:
            m = LEADING_NUMBER_RE.match(it["statement_md"])
            if m:
                token = m.group(1) or m.group(2)
                errors.append(
                    f"{where}: number is null but the statement starts with the printed number {token!r}; "
                    f"put it in `number` (roman numerals, circled and parenthesized numbers are normalized by the tool)"
                )
        if kind != "heading" and it["chapter"] is not None and it["chapter"] != cur_chapter:
            errors.append(
                f"{where}: chapter {it['chapter']!r} was not introduced by a heading item (current: {cur_chapter!r}); "
                "transcribe the printed title as a `heading` item or leave chapter null. Never invent section names to pass checks"
            )
        if kind == "problem":
            first_line = md_first_line(it["statement_md"])
            if "$$" in first_line:
                errors.append(f"{where}: statement_md first line contains `$$`; the first line becomes the note title, move display math to the second line")

        # 2. LaTeX on every *_md
        for field, text in _md_fields(it):
            errs, warns = check_latex(text)
            errors.extend(f"{where}: {field}: {e}" for e in errs)
            warnings.extend(f"{where}: {field}: {w}" for w in warns)

        # 4. per-item continuation flags
        if it["continues_to_next"] and idx != len(items) - 1:
            errors.append(f"{where}: continues_to_next=true is only allowed on the last item")
        if kind == "continuation" and not it["continues_from_previous"]:
            errors.append(f"{where}: continuation items must have continues_from_previous=true")

        # 5. bbox degeneracy
        for j, fig in enumerate(it.get("figures", [])):
            if bbox_is_degenerate(fig["bbox_norm"]):
                warnings.append(f"{where}/figures[{j}]: degenerate bbox {fig['bbox_norm']}; no image will be cropped")

        # 6. emptiness
        parts = it.get("parts", [])
        if kind == "problem" and not it["statement_md"].strip() and not any(p["statement_md"].strip() for p in parts):
            errors.append(f"{where}: problem has empty statement_md and no parts")
        if kind == "solution" and not it["solution_md"].strip() and not any(p["solution_md"].strip() for p in parts):
            errors.append(f"{where}: solution has no solution text anywhere")

        # 3. numbering continuity within the current sheet group
        if kind == "heading":
            last = None
            last_sol = None
            group += 1
            sgroup += 1
            heading_on_page = True
            if it["chapter"] is not None:
                cur_chapter = it["chapter"]
            elif it["statement_md"].strip():
                cur_chapter = it["statement_md"].strip()
            continue
        number = it["number"]
        if kind == "problem" and number:
            nn = leading_int(number)
            if last is None:
                pass  # first problem of the group
            elif it["continues_from_previous"]:
                if nn != last["n"]:
                    errors.append(f"{where}: continues_from_previous but number {number} != previous {last['number']}")
            elif nn == last["n"] and number != last["number"]:
                pass  # 12-1 -> 12-2
            elif nn == last["n"] + 1:
                pass
            elif nn <= last["n"]:
                # Numbering starts over: a new sheet. No name is required (problem-bank output).
                group += 1
                if not heading_on_page:
                    warnings.append(
                        f"{where}: number {number} restarts after {last['number']} (page {last['page']}); treated as a new sheet. "
                        "If a printed title marks the new sheet, transcribe it as a heading item"
                    )
            elif not allow_gap:
                errors.append(
                    f"{where}: gap: number {number} after {last['number']} (page {last['page']}); "
                    "add `allow-gap` to page_notes if the print really skips numbers"
                )
            last = {"n": nn, "number": number, "page": n, "group": group}
        elif kind == "solution" and number:
            nn = leading_int(number)
            if last_sol is not None and not it["continues_from_previous"]:
                if nn == last_sol["n"] and number != last_sol["number"]:
                    pass
                elif nn <= last_sol["n"]:
                    sgroup += 1  # solutions of the next sheet start
            elif last_sol is not None and nn != last_sol["n"]:
                errors.append(f"{where}: continues_from_previous but solution number {number} != previous {last_sol['number']}")
            last_sol = {"n": nn, "number": number, "page": n, "group": sgroup}

    # 4. cross-page continuation
    strict = prev is not None and prev == n - 1
    sink = errors if strict else warnings
    first = items[0] if items else None
    prev_last = prev_rec["last_item"] if prev_rec else None
    if first is not None and (first["kind"] == "continuation" or first["continues_from_previous"]):
        if prev_rec is None:
            warnings.append(f"{tag}/item[0]: continues from previous but no earlier ok page exists")
            prev_last = None
        elif not strict:
            warnings.append(
                f"{tag}/item[0]: pages between {prev} and {n} are not ok; this continuation cannot be stitched "
                f"(it becomes an orphan in assemble) until they are"
            )
        if prev_rec is not None and not (prev_last and prev_last["continues_to_next"]):
            sink.append(
                f"{tag}/item[0]: page {prev} last item has continues_to_next=false; "
                f"re-examine page {prev}, edit its JSON, run check on {prev} then {n}"
            )
    elif prev_last and prev_last["continues_to_next"]:
        sink.append(
            f"{tag}/item[0]: page {prev} last item has continues_to_next=true but this page does not start with a "
            f"continuation; set kind continuation/continues_from_previous here or fix page {prev} and re-check it"
        )

    last_item = None
    if items:
        li = items[-1]
        text = li["solution_md"] if li["kind"] == "solution" or not li["statement_md"].strip() else li["statement_md"]
        last_item = {"kind": li["kind"], "continues_to_next": bool(li["continues_to_next"]), "tail": _tail(text)}
    snapshot = {
        "last_problem_after": last,
        "last_solution_after": last_sol,
        "chapter_after": cur_chapter,
        "group_after": group,
        "solution_group_after": sgroup,
        "last_item": last_item,
    }
    return errors, warnings, snapshot


def check_page(state: dict, n: int, *, force: bool = False, reason: str | None = None, count_attempt: bool = True) -> tuple[bool, list[str], list[str]]:
    """Validate ``pages/NNN.json`` and update the page record. Returns (ok, errors, warnings).

    A skipped page is only re-checked with ``force`` plus a human-given ``reason``
    (recorded in the page history), so an agent cannot silently undo a skip.
    """
    slug = state["slug"]
    rec = page_rec(state, n)
    jp = page_json(slug, n)
    if not jp.is_file():
        raise CLIError(1, f"no JSON for page {n}: {jp}")
    if rec["status"] == "skipped":
        if not force:
            raise CLIError(2, f"page {n} is skipped ({rec['reason']}); re-checking needs --force --reason \"<who asked and why>\"")
        reason_text = (reason or "").strip()
        if not reason_text:
            raise CLIError(2, f"page {n} is skipped; --force needs --reason \"<who asked and why>\" (a human decision, recorded in history)")
        rec.setdefault("history", []).append({"event": "force", "reason": reason_text, "at": time.strftime("%Y-%m-%dT%H:%M:%S")})
        rec["force_reason"] = reason_text
        rec["attempts"] = 0
        rec["reason"] = None
    raw = jp.read_bytes()
    errors: list[str] = []
    warnings: list[str] = []
    snapshot: dict | None = None
    try:
        data, notes = read_page_data(jp)
    except (ValueError, UnicodeDecodeError) as exc:
        errors.append(f"P{n:03d}: JSON parse error: {exc}")
    else:
        warnings.extend(f"P{n:03d}/{note}" for note in notes)
        errors = [f"P{n:03d}/{e}" for e in validate_schema(data, load_schema())]
        if not errors:
            errors, warns, snapshot = run_page_checks(state, n, data)
            warnings.extend(warns)
    rec["json_sha256"] = sha256_bytes(raw)
    rec["warnings"] = warnings
    if errors:
        rec["status"] = "failed"
        rec["errors"] = errors
        if count_attempt:
            rec["attempts"] += 1
            rec.setdefault("history", []).append(
                {"event": "failed", "attempt": rec["attempts"], "errors": errors[:5], "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
            )
            if rec["attempts"] >= MAX_ATTEMPTS:
                rec["status"] = "skipped"
                rec["reason"] = f"max-retries: {errors[0]}"
        return False, errors, warnings
    rec["status"] = "ok"
    rec["errors"] = []
    rec["reason"] = None
    assert snapshot is not None
    rec.update(snapshot)
    return True, errors, warnings


def check_all(state: dict) -> dict[int, tuple[bool, list[str], list[str]]]:
    """Re-check every non-skipped page that has a JSON, in page order.

    Does not count attempts: this is a rebuild pass, not a new transcription
    attempt, so repeated ``assemble`` runs cannot push pages into ``skipped``.
    """
    results: dict[int, tuple[bool, list[str], list[str]]] = {}
    for n in page_numbers(state):
        rec = page_rec(state, n)
        if rec["status"] == "skipped" or not page_json(state["slug"], n).is_file():
            continue
        results[n] = check_page(state, n, count_attempt=False)
    return results


# ---------------------------------------------------------------------------
# Ranges
# ---------------------------------------------------------------------------


def parse_ranges(spec: str, page_count: int) -> dict[str, str]:
    """Parse ``1-2:front,3-40:problems`` into {"1": "front", ...}; must cover 1..N once."""
    kinds: dict[str, str] = {}
    for part in [p.strip() for p in spec.split(",") if p.strip()]:
        if ":" not in part:
            raise CLIError(1, f"bad range segment '{part}': expected START[-END]:KIND")
        rng, kind = part.rsplit(":", 1)
        kind = kind.strip()
        if kind not in RANGE_KINDS:
            raise CLIError(1, f"bad range kind '{kind}' in '{part}'; expected one of {', '.join(RANGE_KINDS)}")
        m = re.fullmatch(r"\s*(\d+)\s*(?:-\s*(\d+))?\s*", rng)
        if not m:
            raise CLIError(1, f"bad page range '{rng}' in '{part}'")
        a = int(m.group(1))
        b = int(m.group(2)) if m.group(2) else a
        if a < 1 or b > page_count or a > b:
            raise CLIError(1, f"range {a}-{b} is outside 1..{page_count} or reversed")
        for p in range(a, b + 1):
            if str(p) in kinds:
                raise CLIError(1, f"page {p} is covered twice (overlap in '{part}')")
            kinds[str(p)] = kind
    missing = [p for p in range(1, page_count + 1) if str(p) not in kinds]
    if missing:
        raise CLIError(1, f"ranges do not cover pages: {', '.join(map(str, missing))}")
    return kinds


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------


def build_prompt(state: dict, n: int) -> str:
    slug = state["slug"]
    if not state["ranges"]["confirmed"]:
        raise CLIError(2, "ranges are not confirmed; run set-ranges then confirm-ranges before transcribing")
    kind = page_kind(state, n)
    if kind not in TRANSCRIBE_KINDS:
        raise CLIError(2, f"page {n} has range kind '{kind}'; only problems/solutions pages are transcribed")
    rec = page_rec(state, n)
    prev = prev_ok_page(state, n)
    prev_rec = page_rec(state, prev) if prev else None
    chapter = (prev_rec or {}).get("chapter_after") or "없음"
    last = (prev_rec or {}).get("last_problem_after")
    last_number = last["number"] if last else "없음"
    prev_last = (prev_rec or {}).get("last_item") or {}
    prev_kind = prev_last.get("kind") or "없음"
    prev_tail = prev_last.get("tail") or "없음"
    prev_continues = "true" if prev_last.get("continues_to_next") else "false"
    if rec["status"] == "failed" and rec["errors"]:
        errors = "\n".join(f"- {e}" for e in rec["errors"])
    else:
        errors = "없음"
    fills = {
        "page": str(n),
        "png_path": str(page_png(slug, n)),
        "json_path": str(page_json(slug, n)),
        "range_kind": kind,
        "schema": SCHEMA_PATH.read_text(encoding="utf-8").rstrip(),
        "chapter": chapter,
        "last_number": last_number,
        "prev_kind": prev_kind,
        "prev_tail": prev_tail,
        "prev_continues": prev_continues,
        "errors": errors,
    }
    template = PROMPT_PATH.read_text(encoding="utf-8")
    return re.sub(r"\{\{(\w+)\}\}", lambda m: fills.get(m.group(1), m.group(0)), template)


# ---------------------------------------------------------------------------
# Assemble: stitching
# ---------------------------------------------------------------------------


def _label_index(label: Any) -> int:
    """Page ordinal of a stream label: int for the main run, ``p NNN`` suffix otherwise."""
    if isinstance(label, int):
        return label
    m = re.search(r"p(\d+)$", str(label))
    return int(m.group(1)) if m else 0


def _new_record(kind: str, it: dict, label: Any, idx: int, chapter: str | None, group: Any) -> dict:
    return {
        "kind": kind,
        "raw_chapter": it["chapter"],
        "chapter": chapter,
        "group": group,
        "number": it["number"],
        "statement_md": it["statement_md"],
        "solution_md": it["solution_md"],
        "parts": [dict(p) for p in it["parts"]],
        "points": it.get("points"),
        "figures": [],
        "pages": [label],
        "confidence": it["confidence"],
        "start": (label, idx),
        "continues_to_next": bool(it["continues_to_next"]),
        "solution": None,
        "from_solution": False,
    }


def _append_to_open(open_rec: dict, it: dict, label: Any) -> None:
    for field in ("statement_md", "solution_md"):
        if it[field].strip():
            open_rec[field] = (open_rec[field].rstrip() + "\n\n" + it[field].strip()) if open_rec[field].strip() else it[field]
    by_label = {p["label"]: p for p in open_rec["parts"]}
    for part in it["parts"]:
        if part["label"] in by_label:
            tgt = by_label[part["label"]]
            for field in ("statement_md", "solution_md"):
                if part[field].strip():
                    tgt[field] = (tgt[field].rstrip() + "\n\n" + part[field].strip()) if tgt[field].strip() else part[field]
        else:
            open_rec["parts"].append(dict(part))
            by_label[part["label"]] = open_rec["parts"][-1]
    if label not in open_rec["pages"]:
        open_rec["pages"].append(label)
    open_rec["confidence"] = min(open_rec["confidence"], it["confidence"])
    open_rec["continues_to_next"] = bool(it["continues_to_next"])


def stitch_stream(pages: list[tuple[Any, int | None, dict]], kinds: dict | None = None, stream: str = "") -> tuple[list[dict], list[dict], dict]:
    """Stitch items of one page stream.

    ``pages`` is a list of (label, png_page, data) in page order; ``label`` is
    an int for the main run and ``"<other>:pNNN"`` for merged runs, ``png_page``
    the page number whose PNG can be cropped (None for merged runs).  ``kinds``
    maps label -> range kind (a new problems block after solutions starts a new
    sheet group).  Returns (records, orphans, page_entries) where page_entries
    maps label -> list of ("heading"|"other"|"record"|"cont", payload) for the
    whole-PDF file.  Every record carries ``group`` = (stream, kind, n): sheet
    groups restart with a heading item, a numbering restart or a new block.
    """
    records: list[dict] = []
    orphans: list[dict] = []
    page_entries: dict[Any, list] = {}
    open_rec: dict | None = None
    cur_chapter: str | None = None
    prev_index: int | None = None
    prev_kind: str | None = None
    groups = {"problem": 0, "solution": 0}
    last_n: dict[str, Any] = {"problem": None, "solution": None}
    for label, png_page, data in pages:
        entries: list = []
        page_entries[label] = entries
        last_on_page: dict | None = None
        fig_k = 0
        # A missing (skipped/failed) page between two ok pages breaks the chain:
        # whatever was open cannot be continued across the hole.
        this_index = _label_index(label)
        if prev_index is not None and this_index != prev_index + 1:
            open_rec = None
        prev_index = this_index
        this_kind = (kinds or {}).get(str(label))
        if this_kind is not None and prev_kind is not None and this_kind != prev_kind:
            for k in groups:
                groups[k] += 1
                last_n[k] = None
        if this_kind is not None:
            prev_kind = this_kind
        for idx, it in enumerate(data["items"]):
            kind = it["kind"]
            figs = []
            for fig in it["figures"]:
                fig_k += 1
                figs.append(
                    {
                        "page": label,
                        "png_page": png_page,
                        "k": fig_k,
                        "bbox": list(fig["bbox_norm"]),
                        "caption": fig["caption"],
                        "description": fig["description"],
                        "degenerate": bbox_is_degenerate(fig["bbox_norm"]),
                        "file": None,
                    }
                )
            if kind == "heading":
                if it["chapter"] is not None:
                    cur_chapter = it["chapter"]
                elif it["statement_md"].strip():
                    cur_chapter = it["statement_md"].strip()
                entries.append(("heading", {"chapter": cur_chapter, "text": it["statement_md"].strip()}))
                open_rec = None
                for k in groups:
                    groups[k] += 1
                    last_n[k] = None
                continue
            if it["chapter"] is not None:
                cur_chapter = it["chapter"]
            if kind == "continuation" or (kind in ("problem", "solution") and it["continues_from_previous"]):
                if open_rec is None:
                    orphans.append({"page": label, "idx": idx, "kind": kind, "number": it["number"], "text": _tail(it["statement_md"] or it["solution_md"])})
                    entries.append(("cont", None))
                    continue
                _append_to_open(open_rec, it, label)
                open_rec["figures"].extend(figs)
                entries.append(("cont", None))
                last_on_page = open_rec
                if not it["continues_to_next"]:
                    open_rec = None
                continue
            if kind == "figure_only":
                target = open_rec or last_on_page
                if target is None:
                    orphans.append({"page": label, "idx": idx, "kind": kind, "number": None, "text": "; ".join(f["caption"] for f in figs)})
                else:
                    target["figures"].extend(figs)
                continue
            if kind == "other":
                entries.append(("other", it["statement_md"].strip() or it["solution_md"].strip()))
                open_rec = None
                continue
            if it["number"]:
                nn = leading_int(it["number"])
                prev_n = last_n[kind]
                if prev_n is not None and nn <= prev_n and not (nn == prev_n and it["number"] != last_n[kind + "_str"]):
                    groups[kind] += 1  # numbering starts over: next sheet
                last_n[kind] = nn
                last_n[kind + "_str"] = it["number"]
            rec = _new_record(kind, it, label, idx, cur_chapter, (stream, kind, groups[kind]))
            rec["figures"].extend(figs)
            records.append(rec)
            entries.append(("record", rec))
            last_on_page = rec
            open_rec = rec if it["continues_to_next"] else None
    return records, orphans, page_entries


# ---------------------------------------------------------------------------
# Assemble: matching, cropping, rendering
# ---------------------------------------------------------------------------


def statement_text(rec: dict) -> str:
    """Problem statement plus part statements (what a restated solution would repeat)."""
    parts = " ".join(p.get("statement_md", "") for p in rec.get("parts", []))
    return (rec.get("statement_md", "") + " " + parts).strip()


def text_tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9가-힣]+", text.lower()))


def similarity(a: str, b: str) -> float:
    """Token Jaccard similarity in [0, 1]; 0 when either side has no tokens."""
    ta, tb = text_tokens(a), text_tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def _rec_order(rec: dict) -> tuple:
    label, idx = rec["start"]
    return (0 if isinstance(label, int) else 1, str(rec["group"][0]), _label_index(label), idx)


def _pair_groups(problems: list[dict], solutions: list[dict]) -> dict[tuple, tuple]:
    """Map each solution group to the problem group at the same position in the preceding problems block.

    Groups are ordered by first appearance. Walking them in page order, a run of
    problem groups is followed by a run of solution groups; the k-th solution
    group of the run pairs with the k-th problem group of the run before it.
    Merged-run solutions (other stream) are never paired positionally.
    """
    firsts: dict[tuple, tuple] = {}
    for rec in problems + solutions:
        key = rec["group"]
        order = _rec_order(rec)
        if key not in firsts or order < firsts[key]:
            firsts[key] = order
    ordered = sorted(firsts, key=lambda g: firsts[g])
    pairing: dict[tuple, tuple] = {}
    pending: list[tuple] = []
    k = 0
    after_solutions = False
    for g in ordered:
        if g[0] != "":
            continue
        if g[1] == "problem":
            if after_solutions:
                pending, k, after_solutions = [], 0, False
            pending.append(g)
        else:
            after_solutions = True
            if k < len(pending):
                pairing[g] = pending[k]
            k += 1
    return pairing


def match_solutions(problems: list[dict], solutions: list[dict]) -> list[dict]:
    """Attach solutions to problems; return the unmatched solutions.

    A solution that restates its problem is matched by text similarity among
    problems with the same number (the positional sheet group wins ties). A
    bare solution matches by number inside its positional sheet group only, or,
    for merged runs, when the number is unique across all problems. Anything
    else stays unmatched (restated ones become problem notes in ``assemble``).
    """
    by_number: dict[str, list[dict]] = {}
    for p in problems:
        if p["number"]:
            by_number.setdefault(p["number"], []).append(p)
    pairing = _pair_groups(problems, solutions)
    unmatched: list[dict] = []
    for s in solutions:
        target = None
        cands = by_number.get(s["number"] or "", [])
        positional = pairing.get(s["group"])
        restated = statement_text(s)
        if restated and cands:
            scored = [(similarity(restated, statement_text(p)), 0 if p["group"] == positional else 1, i, p) for i, p in enumerate(cands)]
            scored.sort(key=lambda t: (-t[0], t[1], t[2]))
            if scored[0][0] >= SIMILARITY_THRESHOLD:
                target = scored[0][3]
        elif not restated and cands:
            if positional is not None:
                same = [p for p in cands if p["group"] == positional]
                if len(same) == 1:
                    target = same[0]
            elif s["group"][0] != "" and len(cands) == 1:
                target = cands[0]
        if target is not None and target["solution"] is None:
            target["solution"] = s
        else:
            unmatched.append(s)
    return unmatched


def restated_as_problem(s: dict) -> dict:
    """A problem record built from a solution item that restates the problem."""
    rec = dict(s)
    rec["kind"] = "problem"
    rec["parts"] = [dict(p) for p in s["parts"]]
    rec["figures"] = list(s["figures"])
    rec["solution"] = None
    rec["from_solution"] = True
    return rec


# ---------------------------------------------------------------------------
# Assemble: points and importance
# ---------------------------------------------------------------------------


def parse_points(text: str) -> float | None:
    """Points printed in a label such as ``(10점)`` or ``15 pts``; None when absent."""
    m = POINTS_RE.search(text or "")
    if not m:
        return None
    value = float(m.group(1) or m.group(2))
    return int(value) if value.is_integer() else value


def strip_points_label(text: str) -> str:
    """Remove printed point labels (they live in frontmatter ``points``)."""
    out = POINTS_RE.sub("", text or "")
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r" +([.,;:)\]])", r"\1", out)
    return out.strip()


def resolve_points(rec: dict) -> float | None:
    """Explicit ``points`` first, then a label on the first line, then the sum of part labels."""
    if rec.get("points") is not None:
        return rec["points"]
    p = parse_points(md_first_line(rec["statement_md"]))
    if p is not None:
        return p
    part_points = [pp.get("points") if pp.get("points") is not None else parse_points(md_first_line(pp["statement_md"])) for pp in rec["parts"]]
    known = [x for x in part_points if x is not None]
    if known and len(known) == len(part_points):
        total = sum(known)
        return int(total) if float(total).is_integer() else total
    return None


def assign_importance(problems: list[dict]) -> None:
    """``importance`` = share of the sheet's total points x number of scored problems (1.0 = average)."""
    by_group: dict[tuple, list[dict]] = {}
    for rec in problems:
        rec["points"] = resolve_points(rec)
        by_group.setdefault(rec["group"], []).append(rec)
    for recs in by_group.values():
        scored = [r for r in recs if r["points"] is not None]
        total = sum(float(r["points"]) for r in scored)
        for r in recs:
            r["importance"] = round(float(r["points"]) / total * len(scored), 2) if r["points"] is not None and total > 0 else None


def crop_figure(png_path: Path, bbox: list[float], target: Path) -> None:
    from PIL import Image

    with Image.open(png_path) as im:
        w, h = im.size
        x0, y0, x1, y1 = bbox
        box = (
            max(0, round((x0 - CROP_PADDING) * w)),
            max(0, round((y0 - CROP_PADDING) * h)),
            min(w, round((x1 + CROP_PADDING) * w)),
            min(h, round((y1 + CROP_PADDING) * h)),
        )
        crop = im.convert("RGB").crop(box)
    tmp = target.with_name(target.name + ".tmp")
    target.parent.mkdir(parents=True, exist_ok=True)
    crop.save(tmp, format="PNG")
    os.replace(tmp, target)


def sanitize_name(text: str) -> str:
    s = re.sub(r"[.() ]", "-", text)
    s = re.sub(r"[^0-9A-Za-z가-힣_\-]", "-", s)
    return re.sub(r"-+", "-", s).strip("-")


def md_first_line(text: str) -> str:
    for line in text.splitlines():
        if line.strip():
            return line.strip()
    return ""


def md_rest(text: str) -> str:
    """Everything after the first non-empty line (the part the heading did not already show)."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.strip():
            return "\n".join(lines[i + 1:]).strip()
    return ""


def is_proof(statement: str, parts: list[dict] | None = None) -> bool:
    """Proof problem: the statement (any line) or a part asks to prove/show."""
    text = statement + " " + " ".join(p.get("statement_md", "") for p in parts or [])
    if PROOF_EN_RE.search(text):
        return True
    return any(tok in text for tok in PROOF_KO_TOKENS)


def blockquote(text: str, prefix: str | None = None) -> list[str]:
    lines = text.splitlines() or [""]
    out = []
    for i, line in enumerate(lines):
        body = f"{prefix} {line}" if i == 0 and prefix else line
        out.append(("> " + body).rstrip())
    return out


def fmt_bbox(bbox: list[float]) -> str:
    return ", ".join(f"{v:.3f}" for v in bbox)


def page_label(label: Any) -> str:
    return f"p{label:03d}" if isinstance(label, int) else str(label)


def _render_figures(figs: list[dict], img_prefix: str, quoted: bool) -> list[str]:
    lines: list[str] = []
    for fig in figs:
        if fig["file"]:
            block = [f"![]({img_prefix}{fig['file']})", f"*{fig['caption'].strip()}*", "", fig["description"].strip()]
        else:
            block = [f"> [!warning] 그림 추출 실패 (bbox {fmt_bbox(fig['bbox'])})", f"> {fig['caption'].strip()}", f"> {fig['description'].strip()}"]
        if quoted:
            lines.append(">")
            lines.extend(("> " + b).rstrip() for b in block)
        else:
            lines.extend(block)
            lines.append("")
    return lines


# ---------------------------------------------------------------------------
# Post-processing and Quality Audit
# ---------------------------------------------------------------------------


def clean_unicode_text(text: str, *, legacy_ocr_fixes: bool = False) -> str:
    """Normalize unicode to NFC, strip control and PUA characters, clean trailing spaces."""
    if not text:
        return text
    # 1. NFC normalization
    text = unicodedata.normalize("NFC", text)
    # 2. Control characters removal (keep \t and \n, discard \x00-\x08, \x0b, \x0c, \x0e-\x1f, etc.)
    text = CONTROL_CHARS_RE.sub("", text)
    # 3. PUA characters removal
    if legacy_ocr_fixes:
        text = PUA_RE.sub("", text)
    # 4. Clean trailing whitespace per line
    lines = [line.rstrip() for line in text.splitlines()]
    cleaned = "\n".join(lines)
    # 5. Compress 3+ consecutive newlines to 2
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned


def normalize_math_tokens(text: str) -> str:
    """Deterministic math token normalizations based on audited patterns."""
    if not text:
        return text

    # 1. Alternating sign exponents
    text = re.sub(r"\(-1\)n\+1\b", r"(-1)^{n+1}", text)
    text = re.sub(r"\(-1\)n\b", r"(-1)^n", text)
    text = re.sub(r"(\(-1\)\^\{?[^\}]*\}?)\s*(\d+)n\b", r"\1 \2^n", text)

    # 2. Subscripts
    text = re.sub(r"\\sqrt\{([abcrs])n\+1\}", r"\\sqrt{\1_{n+1}}", text)
    text = re.sub(r"\\sqrt\{([abcrs])n\}", r"\\sqrt{\1_n}", text)
    text = re.sub(r"\b([abcrs])\{n\}", r"\1_n", text)
    text = re.sub(r"\b([abcrs])n\+1\b", r"\1_{n+1}", text)
    text = re.sub(r"\b([abcrs])n\b", r"\1_n", text)

    # 3. Disambiguated power on parens
    text = re.sub(r"\((\d+n\s*[+\-]\s*\d+)\)\s*(\d+)n\b", r"(\1)\2^n", text)
    text = re.sub(r"\(([a-zA-Z0-9+\-\s]+)\)(\d+)n\b", r"(\1)\2^n", text)
    text = re.sub(r"\(([^\)]+)\)([sp])\b", r"(\1)^{\2}", text)
    text = re.sub(r"\((?!-1\))([^\)]+)\)n\b", r"(\1)^n", text)
    text = re.sub(r"\(([^\)]+)\)(\d+)(?![0-9^_\w])", r"(\1)^{\2}", text)

    # 4. Variable powers
    text = re.sub(r"\bxn\+1\b", r"x^{n+1}", text)
    text = re.sub(r"\bxn\b", r"x^n", text)
    text = re.sub(r"\b([xyzt])(\d+)\b", r"\1^{\2}", text)

    # 5. Index/Letter powers
    text = re.sub(r"\bn2n\b", r"n\\,2^n", text)
    text = re.sub(r"\bnen\b", r"n e^n", text)
    text = re.sub(r"\ben\b", r"e^n", text)
    text = re.sub(r"\be-n\b", r"e^{-n}", text)
    text = re.sub(r"\b3n\+1\b", r"3^{n+1}", text)
    text = re.sub(r"\b2012n\b", r"2012^n", text)
    text = re.sub(r"\bn(\d+)\b", r"n^{\1}", text)
    text = re.sub(r"\bn([ps])\b", r"n^{\1}", text)
    text = re.sub(r"\bnn\b", r"n^n", text)

    # 6. Trig functions with 1/n
    text = re.sub(r"\\(sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan)\s+1\s*/?\s*n\b", r"\\\1\\frac{1}{n}", text)

    # 7. Curve notation
    text = re.sub(r"\\sum\(t\)", r"X(t)", text)

    return text


def audit_math_syntax(text: str) -> list[str]:
    """Detect syntax defects like unbalanced $, broken tokens, operator linebreaks."""
    issues: list[str] = []
    if not text:
        return issues
    if PUA_RE.search(text):
        issues.append("PUA 문자 보존: 원문 확인 필요")
    if normalize_math_tokens(text) != text:
        issues.append("OCR 수식 표기 의심: 자동 변경 없이 원문 확인 필요")
    stripped = re.sub(r"\\\$", "", text)
    stripped_for_single = re.sub(r"\$\$", "", stripped)
    if stripped_for_single.count("$") % 2 != 0:
        issues.append("미닫힘 수식 구분자($)")
    if stripped.count("$$") % 2 != 0:
        issues.append("미닫힘 디스플레이 수식 구분자($$)")
    if re.search(r"(_|\^)\{\s*\$\$", text) or re.search(r"(_|\^)\$\$", text):
        issues.append("손상된 수식 토큰(_{$$} 등)")
    if OPERATOR_LINEBREAK_RE.search(text):
        issues.append("수식 연산자 줄바꿈 분절(\\sum\\n 등)")
    if DANGLING_OPERATOR_RE.search(text.strip()):
        issues.append("수식 연산자로 비정상 종결")
    return issues


def assess_record_quality(rec: dict, notes_by_page: dict[int, str] | None = None) -> tuple[str, bool, list[str]]:
    """Determine text_quality ('good' | 'poor' | 'broken'), instruction_lost, and notes."""
    notes: list[str] = []
    stmt = rec.get("statement_md", "").strip()
    sol = rec.get("solution_md", "").strip()
    parts = rec.get("parts", [])
    full_text = stmt + " " + sol + " " + " ".join(p.get("statement_md", "") + " " + p.get("solution_md", "") for p in parts)

    # Check instruction lost
    instruction_lost = False
    if rec.get("kind") == "problem":
        if not stmt and not any(p.get("statement_md", "").strip() for p in parts):
            instruction_lost = True
            notes.append("문제 본문 완전 결손")
        elif len(stmt) < 20 and not INSTRUCTION_KO_RE.search(stmt) and not INSTRUCTION_EN_RE.search(stmt):
            if not any(INSTRUCTION_KO_RE.search(p.get("statement_md", "")) or INSTRUCTION_EN_RE.search(p.get("statement_md", "")) for p in parts):
                instruction_lost = True
                notes.append("질의 지시문 결손 의심")

    # Math syntax issues
    syntax_issues = audit_math_syntax(full_text)
    if syntax_issues:
        notes.extend(syntax_issues)

    # Confidence check
    conf = float(rec.get("confidence", 1.0))
    if conf < 0.8:
        notes.append(f"낮은 신뢰도({conf:.2f})")

    # Handwriting check
    labels = list(rec.get("pages", [])) + (list(rec["solution"]["pages"]) if rec.get("solution") else [])
    main_pages = sorted({p for p in labels if isinstance(p, int)})
    if notes_by_page:
        hand = [p for p in main_pages if HANDWRITING_RE.search(notes_by_page.get(p, ""))]
        if hand:
            notes.append("손글씨 " + ", ".join(f"p{p:03d}" for p in hand))

    # Classify text_quality
    if instruction_lost or any("미닫힘" in n or "손상된" in n for n in notes):
        text_quality = "broken"
    elif conf < 0.8 or any("손글씨" in n for n in notes):
        text_quality = "poor"
    else:
        text_quality = "good"

    return text_quality, instruction_lost, notes


def transform_text(text: str, *, legacy_ocr_fixes: bool = False,
                   changes: list | None = None, field: str = "") -> str:
    cleaned = clean_unicode_text(text, legacy_ocr_fixes=legacy_ocr_fixes)
    result = normalize_math_tokens(cleaned) if legacy_ocr_fixes else cleaned
    if legacy_ocr_fixes and result != text:
        if changes is None:
            raise ValueError("legacy OCR fixes require a change log")
        changes.append({"field": field, "before": text, "after": result})
    return result


def write_legacy_changes(slug: str, changes: list) -> None:
    if changes:
        target = run_dir(slug) / "legacy-ocr-fixes.jsonl"
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a", encoding="utf-8") as handle:
            for change in changes:
                handle.write(json.dumps(change, ensure_ascii=False) + "\n")


def postprocess_record(rec: dict, notes_by_page: dict[int, str] | None = None, *,
                       legacy_ocr_fixes: bool = False, changes: list | None = None) -> dict:
    """Normalize presentation while preserving ambiguous math by default."""
    def visit(obj: dict, prefix: str) -> None:
        for key in ("statement_md", "solution_md"):
            if key in obj:
                obj[key] = transform_text(obj[key], legacy_ocr_fixes=legacy_ocr_fixes,
                                          changes=changes, field=f"{prefix}.{key}")
        for i, part in enumerate(obj.get("parts", [])):
            visit(part, f"{prefix}.parts[{i}]")
        if obj.get("solution"):
            visit(obj["solution"], f"{prefix}.solution")
    visit(rec, str(rec.get("number", "?")))
    tq, inst_lost, notes = assess_record_quality(rec, notes_by_page)
    rec["text_quality"] = tq
    rec["instruction_lost"] = inst_lost
    rec["quality_notes"] = notes
    return rec


def postprocess_file_content(content: str, *, legacy_ocr_fixes: bool = False) -> tuple[str, dict]:
    """Post-process markdown content (split frontmatter and body, unwrap headers, clean text)."""
    if content.startswith("---\n"):
        parts = content.split("\n---\n", 1)
        if len(parts) == 2:
            fm_text, body = parts[0][4:], parts[1]
        else:
            fm_text, body = "", content
    else:
        fm_text, body = "", content

    # Clean body
    changes: list = []
    body = transform_text(body, legacy_ocr_fixes=legacy_ocr_fixes, changes=changes, field="body")

    # Unwrap header-trapped lines: ### N. Some statement -> ### N.\n\nSome statement
    body = re.sub(r"^###\s+([0-9]+)\.[ \t]+(?![\(\>])(.+)$", r"### \1.\n\n\2", body, flags=re.M)

    # Clean fm_text
    fm_lines = [clean_unicode_text(l) for l in fm_text.splitlines()]

    # Check syntax issues
    syntax_issues = audit_math_syntax(body)

    # Assess instruction lost
    instruction_lost = False
    clean_body_for_inst = re.sub(r"^###\s+.*$", "", body, flags=re.M).strip()
    if "> [!solution]" in clean_body_for_inst:
        clean_body_for_inst = clean_body_for_inst.split("> [!solution]")[0].strip()
    if clean_body_for_inst and len(clean_body_for_inst) < 30:
        if not INSTRUCTION_KO_RE.search(clean_body_for_inst) and not INSTRUCTION_EN_RE.search(clean_body_for_inst):
            instruction_lost = True

    if instruction_lost or any("미닫힘" in s or "손상된" in s for s in syntax_issues):
        text_quality = "broken"
    elif any("손글씨" in l for l in fm_lines) or any("confidence: 0." in l and float(l.split("confidence:")[1].strip()) < 0.8 for l in fm_lines):
        text_quality = "poor"
    else:
        text_quality = "good"

    # Update frontmatter
    new_fm_lines = []
    has_tq = False
    has_inst_lost = False
    for line in fm_lines:
        if line.startswith("text_quality:"):
            new_fm_lines.append(f"text_quality: {yaml_scalar(text_quality)}")
            has_tq = True
        elif line.startswith("instruction_lost:"):
            new_fm_lines.append(f"instruction_lost: {yaml_scalar(instruction_lost)}")
            has_inst_lost = True
        else:
            new_fm_lines.append(line)
    if fm_lines and not has_tq:
        new_fm_lines.append(f"text_quality: {yaml_scalar(text_quality)}")
    if fm_lines and not has_inst_lost:
        new_fm_lines.append(f"instruction_lost: {yaml_scalar(instruction_lost)}")

    if new_fm_lines:
        new_content = "---\n" + "\n".join(new_fm_lines) + "\n---\n" + body.lstrip("\n")
    else:
        new_content = body

    info = {
        "text_quality": text_quality,
        "instruction_lost": instruction_lost,
        "syntax_issues": syntax_issues,
        "legacy_changes": changes,
    }
    return new_content, info


def render_record_body(rec: dict, img_prefix: str, title_number: Any = None) -> str:
    """Markdown body of a stitched problem (or solution) record.

    ``title_number`` (the bank number) replaces the printed number in the
    heading of problem notes; the whole-PDF file keeps printed numbers.
    """
    lines: list[str] = []
    number = rec["number"] or "?"
    if rec["kind"] == "solution":
        lines.append(f"### {number}. (해설)")
        lines.append("")
        body = rec["solution_md"].strip()
        if body:
            lines.append(body)
            lines.append("")
        for part in rec["parts"]:
            if part["solution_md"].strip():
                lines.append(f"**{part['label']}** {part['solution_md'].strip()}")
                lines.append("")
        lines.extend(_render_figures(rec["figures"], img_prefix, quoted=False))
        return "\n".join(lines).rstrip() + "\n"
    heading_number = number if title_number is None else title_number
    lines.append(f"### {heading_number}.")
    lines.append("")
    stmt = strip_points_label(rec["statement_md"]).strip()
    if stmt:
        lines.append(stmt)
        lines.append("")
    for part in rec["parts"]:
        if part["statement_md"].strip():
            lines.append(f"**{part['label']}** {strip_points_label(part['statement_md'].strip())}")
            lines.append("")
    lines.extend(_render_figures(rec["figures"], img_prefix, quoted=False))
    sol = rec["solution"]
    own_solution = rec["solution_md"].strip() or any(p["solution_md"].strip() for p in rec["parts"])
    if sol is not None or own_solution:
        tag = "**pf)**" if is_proof(rec["statement_md"], rec["parts"]) else "**Sol)**"
        lines.append("> [!solution]- 해설")
        src = sol if sol is not None else rec
        main = src["solution_md"].strip()
        if main:
            lines.extend(blockquote(main, tag))
        else:
            lines.append(f"> {tag}")
        for part in src["parts"]:
            if part["solution_md"].strip():
                lines.append(">")
                lines.extend(blockquote(part["solution_md"].strip(), f"**{part['label']}**"))
        if sol is not None:
            lines.extend(_render_figures(sol["figures"], img_prefix, quoted=True))
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def yaml_scalar(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return json.dumps(value)
    return json.dumps(str(value), ensure_ascii=False)


def has_solution(rec: dict) -> bool:
    return rec["solution"] is not None or bool(rec["solution_md"].strip()) or any(p["solution_md"].strip() for p in rec["parts"])


def solution_pages(rec: dict) -> list:
    """Pages the attached solution came from (``<other>:pNNN`` for merged runs)."""
    if rec["solution"] is not None:
        return list(rec["solution"]["pages"])
    return list(rec["pages"]) if has_solution(rec) else []


def render_problem_file(rec: dict, slug: str, source: str, bank_number: int) -> str:
    pages = ", ".join(yaml_scalar(p) for p in rec["pages"])
    sol_pages = ", ".join(yaml_scalar(p) for p in solution_pages(rec))
    text_quality = rec.get("text_quality", "good")
    instruction_lost = bool(rec.get("instruction_lost", False))
    fm = [
        "---",
        f"source: {yaml_scalar(source)}",
        f"pages: [{pages}]",
        f"source_number: {yaml_scalar(rec['number'])}",
        f"tags: [math, problem, {slug}]",
        f"points: {yaml_scalar(rec.get('points'))}",
        f"importance: {yaml_scalar(rec.get('importance'))}",
        f"has_solution: {yaml_scalar(has_solution(rec))}",
        f"solution_pages: [{sol_pages}]",
        f"from_solution: {yaml_scalar(bool(rec.get('from_solution')))}",
        f"confidence: {yaml_scalar(round(float(rec['confidence']), 3))}",
        f"text_quality: {yaml_scalar(text_quality)}",
        f"instruction_lost: {yaml_scalar(instruction_lost)}",
        "---",
        "",
    ]
    return "\n".join(fm) + render_record_body(rec, "../img/", title_number=bank_number)


def _load_ok_pages(state: dict) -> list[tuple[Any, int | None, dict]]:
    slug = state["slug"]
    pages = []
    for n in page_numbers(state):
        if page_rec(state, n)["status"] == "ok":
            pages.append((n, n, read_page_data(page_json(slug, n))[0]))
    return pages


def review_reasons(rec: dict, state: dict, notes_by_page: dict[int, str]) -> list[str]:
    """Why a human should look at this problem: retries, handwriting, low confidence."""
    reasons: list[str] = []
    labels = list(rec["pages"]) + (list(rec["solution"]["pages"]) if rec["solution"] else [])
    main_pages = sorted({p for p in labels if isinstance(p, int)})
    retried = [p for p in main_pages if page_rec(state, p).get("attempts", 0) >= 2]
    if retried:
        reasons.append("재시도 " + ", ".join(f"p{p:03d}" for p in retried))
    hand = [p for p in main_pages if HANDWRITING_RE.search(notes_by_page.get(p, ""))]
    if hand:
        reasons.append("손글씨 " + ", ".join(f"p{p:03d}" for p in hand))
    if float(rec["confidence"]) < REVIEW_CONFIDENCE:
        reasons.append(f"신뢰도 {float(rec['confidence']):.2f}")
    return reasons


def _load_merged_streams(state: dict) -> list[tuple[str, list[tuple[Any, int | None, dict]]]]:
    streams = []
    for entry in sorted(state.get("merged", []), key=lambda e: e["slug"]):
        other = entry["slug"]
        pages = []
        for n in sorted(entry["pages"]):
            jp = merged_dir(state["slug"], other) / f"{n:03d}.json"
            if jp.is_file():
                pages.append((f"{other}:p{n:03d}", None, read_json_tolerant(jp)))
        streams.append((other, pages))
    return streams


def assemble(state: dict, *, legacy_ocr_fixes: bool = False) -> dict:
    """Build the output tree deterministically. Returns the summary dict."""
    slug = state["slug"]
    if not state["ranges"]["confirmed"]:
        raise CLIError(2, "ranges are not confirmed; run set-ranges then confirm-ranges before assemble")
    odir = out_dir(slug)
    source = Path(state["pdf_path"]).name

    ok_pages = _load_ok_pages(state)
    notes_by_page = {n: data.get("page_notes", "") for n, _png, data in ok_pages}
    records, orphans, page_entries = stitch_stream(ok_pages, kinds=state["ranges"]["kinds"])
    merged_records: list[dict] = []
    for other, pages in _load_merged_streams(state):
        recs, orph, _entries = stitch_stream(pages, stream=other)
        merged_records.extend(recs)
        orphans.extend(orph)
    problems = [r for r in records if r["kind"] == "problem"]
    solutions = [r for r in records if r["kind"] == "solution"] + [r for r in merged_records if r["kind"] == "solution"]
    unmatched = match_solutions(problems, solutions)
    # A solution that restates its problem but matches nothing is a problem in its own right
    # (model answers, handwritten solutions of sheets whose problem pages are absent).
    restated = [s for s in unmatched if statement_text(s)]
    unmatched = [s for s in unmatched if not statement_text(s)]
    problems.extend(restated_as_problem(s) for s in restated)
    problems.sort(key=_rec_order)
    assign_importance(problems)

    changes: list = []
    # Post-process all problem and solution records
    for rec in problems:
        postprocess_record(rec, notes_by_page, legacy_ocr_fixes=legacy_ocr_fixes, changes=changes)
    for rec in solutions:
        postprocess_record(rec, notes_by_page, legacy_ocr_fixes=legacy_ocr_fixes, changes=changes)

    write_legacy_changes(slug, changes)

    # figures: crop for problems and their attached solutions
    generated: set[Path] = set()
    missing_figs: list[tuple[dict, dict]] = []
    for rec in problems:
        fig_sets = [rec["figures"]] + ([rec["solution"]["figures"]] if rec["solution"] else [])
        for figs in fig_sets:
            figs.sort(key=lambda f: (page_label(f["page"]), f["k"]))
            for fig in figs:
                if fig["degenerate"] or fig["png_page"] is None:
                    fig["file"] = None
                    missing_figs.append((rec, fig))
                    continue
                png = page_png(slug, fig["png_page"])
                if not png.is_file():
                    fig["file"] = None
                    missing_figs.append((rec, fig))
                    continue
                fig["file"] = f"p{fig['png_page']:03d}-{fig['k']}.png"
                target = odir / "img" / fig["file"]
                crop_figure(png, fig["bbox"], target)
                generated.add(target.resolve())

    # problem files
    rows: list[dict] = []
    for i, rec in enumerate(problems, start=1):
        name = sanitize_name(f"{i:03d}-{slug}") + ".md"
        rec["file"] = name
        rec["bank_number"] = i
        rec["review"] = review_reasons(rec, state, notes_by_page)
        target = odir / "problems" / name
        atomic_write_text(target, render_problem_file(rec, slug, source, i))
        generated.add(target.resolve())
        rows.append(rec)

    # stale files
    for sub in ("problems", "img"):
        d = odir / sub
        if d.is_dir():
            for f in sorted(d.iterdir()):
                if f.is_file() and f.resolve() not in generated:
                    f.unlink()

    # whole-PDF file
    whole: list[str] = [f"# {slug}", ""]
    for n in page_numbers(state):
        rec_n = page_rec(state, n)
        kind = page_kind(state, n)
        if kind not in TRANSCRIBE_KINDS:
            continue
        whole.append(f"<!-- page {n:03d} -->")
        whole.append(f"## p.{n:03d}")
        whole.append("")
        if rec_n["status"] != "ok":
            whole.append(f"({rec_n['status']}: {rec_n['reason'] or (rec_n['errors'][0] if rec_n['errors'] else '')})".rstrip())
            whole.append("")
            continue
        entries = page_entries.get(n, [])
        started = False
        for kind_e, payload in entries:
            if kind_e == "heading":
                title = f"## {payload['chapter']} {payload['text']}" if payload["chapter"] and not payload["text"].startswith(payload["chapter"]) else f"## {payload['text'] or payload['chapter']}"
                whole.append(title.rstrip())
                whole.append("")
                started = True
            elif kind_e == "other":
                whole.extend(blockquote(payload))
                whole.append("")
                started = True
            elif kind_e == "record":
                whole.append(render_record_body(payload, "img/"))
                started = True
        if not started:
            whole.append("(앞 페이지에서 이어짐)")
            whole.append("")
    atomic_write_text(odir / f"{slug}.md", "\n".join(whole).rstrip() + "\n")

    # index
    idx: list[str] = [INDEX_BANNER, "", f"# {slug} index", "", "| # | 파일 | 페이지 | 원번호 | 배점 | 중요도 | 해설 | 신뢰도 |", "|---|---|---|---|---|---|---|---|"]
    for i, rec in enumerate(rows, start=1):
        sol_cell = "아니오"
        if has_solution(rec):
            sol_cell = "예 (" + ", ".join(page_label(p) for p in solution_pages(rec)) + ")"
        points = "" if rec.get("points") is None else str(rec["points"])
        importance = "" if rec.get("importance") is None else f"{rec['importance']:.2f}"
        idx.append(
            f"| {i} | [{rec['file']}](problems/{rec['file']}) | {', '.join(page_label(p) for p in rec['pages'])} | "
            f"{rec['number'] or ''} | {points} | {importance} | {sol_cell} | {float(rec['confidence']):.2f} |"
        )
    idx.append("")
    idx.append("## 텍스트 품질 요약")
    tq_counts = {"good": 0, "poor": 0, "broken": 0}
    for r in rows:
        tq = r.get("text_quality", "good")
        tq_counts[tq] = tq_counts.get(tq, 0) + 1
    idx.append(f"- 양호(good): {tq_counts.get('good', 0)}개, 미흡(poor): {tq_counts.get('poor', 0)}개, 결손(broken): {tq_counts.get('broken', 0)}개")
    quality_issues = [r for r in rows if r.get("text_quality") != "good" or r.get("quality_notes")]
    if quality_issues:
        for r in quality_issues:
            notes_str = "; ".join(r.get("quality_notes", [])) or r.get("text_quality", "")
            idx.append(f"- {r['bank_number']} [{r['file']}](problems/{r['file']}) ({r.get('text_quality')}): {notes_str}")
    else:
        idx.append("- 특이사항 없음 (전 문항 양호)")

    idx.append("")
    idx.append("## 검토 권장")
    review_rows = [r for r in rows if r["review"]]
    idx.extend(f"- {r['bank_number']} [{r['file']}](problems/{r['file']}): {'; '.join(r['review'])}" for r in review_rows)
    if not review_rows:
        idx.append("없음")
    idx.append("")
    idx.append("## 해설에서 만든 문제")
    from_sol = [r for r in rows if r.get("from_solution")]
    idx.extend(f"- {r['bank_number']} [{r['file']}](problems/{r['file']}): {page_label(r['pages'][0])} 해설 {r['number'] or '?'}" for r in from_sol)
    if not from_sol:
        idx.append("없음")
    idx.append("")
    idx.append("## 미매칭 해설")
    idx.extend(f"- {page_label(s['pages'][0])} 해설 {s['number'] or '?'} (문제 재진술 없음)" for s in unmatched)
    if not unmatched:
        idx.append("없음")
    idx.append("")
    idx.append("## 고아 조각")
    idx.extend(f"- {page_label(o['page'])} item[{o['idx']}] {o['kind']} {o['number'] or ''}: {o['text'][:80]}".rstrip() for o in orphans)
    if not orphans:
        idx.append("없음")
    idx.append("")
    idx.append("## 실패·건너뜀 페이지")
    bad = []
    for n in page_numbers(state):
        r = page_rec(state, n)
        if r["status"] == "ok" or (r["status"] == "skipped" and str(r["reason"] or "").startswith("range:")):
            continue
        detail = r["reason"] or (r["errors"][0] if r["errors"] else "")
        bad.append(f"- p{n:03d}: {r['status']} (attempts {r['attempts']}) {detail}".rstrip())
    idx.extend(bad or ["없음"])
    idx.append("")
    idx.append("## 그림 미추출")
    idx.extend(f"- {page_label(f['page'])} 그림 {f['k']} (문제 {r['number'] or '?'}): bbox {fmt_bbox(f['bbox'])}" for r, f in missing_figs)
    if not missing_figs:
        idx.append("없음")
    atomic_write_text(odir / "index.md", "\n".join(idx) + "\n")

    counts = {s: 0 for s in PAGE_STATUSES}
    for n in page_numbers(state):
        counts[page_rec(state, n)["status"]] += 1
    summary = {
        "slug": slug,
        "pdf_sha256": state["pdf_sha256"],
        "page_count": state["page_count"],
        "run_dir": str(run_dir(slug)),
        "counts": counts,
        "problems": [r["file"] for r in rows],
        "from_solution": [r["file"] for r in rows if r.get("from_solution")],
        "review": {r["file"]: r["review"] for r in rows if r["review"]},
        "text_quality": tq_counts,
        "quality_issues": {r["file"]: r["quality_notes"] for r in rows if r.get("quality_notes")},
        "unmatched_solutions": [f"{page_label(s['pages'][0])}:{s['number'] or '?'}" for s in unmatched],
        "orphans": [f"{page_label(o['page'])}[{o['idx']}]" for o in orphans],
    }
    atomic_write_text(odir / ".pdf2md.json", dump_json(summary))
    return summary



# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_prepare(args: argparse.Namespace) -> int:
    pdf = Path(args.pdf).resolve()
    if not pdf.is_file():
        raise CLIError(2, f"PDF not found: {pdf}")
    sha = sha256_file(pdf)
    slug = args.slug or slugify(pdf.stem)
    rdir = run_dir(slug)
    state = load_state(slug)
    if state is not None and state["pdf_sha256"] != sha:
        if not args.reset:
            raise CLIError(
                2,
                f"run '{slug}' was prepared from a different PDF: state sha {state['pdf_sha256']} != new sha {sha}; "
                "pass --reset to delete the run directory (the output directory is never touched)",
            )
        shutil.rmtree(rdir)
        state = None
    elif args.reset and rdir.exists():
        shutil.rmtree(rdir)
        state = None
    dpi = state["dpi"] if state is not None else args.dpi
    if state is not None and args.dpi != dpi:
        print(f"note: keeping dpi {dpi} from the existing run (requested {args.dpi})")
    count, rendered = render_missing_pages(pdf, slug, dpi)
    sheets = build_thumb_sheets(slug, count)
    if state is None:
        state = new_state(slug, pdf, sha, count, dpi)
    else:
        state["pdf_path"] = str(pdf)
    if getattr(args, "out_root", None):
        state["out_root"] = str(Path(args.out_root).resolve())
    save_state(state)
    print(f"slug: {slug}")
    print(f"run dir: {rdir}")
    print(f"out dir: {out_dir(slug)}")
    print(f"pages: {count} (rendered {rendered}, thumb sheets {sheets})")
    return 0


def cmd_paths(args: argparse.Namespace) -> int:
    state = load_state_guarded(args.slug)
    slug = state["slug"]
    print(f"run dir: {run_dir(slug)}")
    print(f"out dir: {out_dir(slug)}")
    print(f"png: {run_dir(slug) / 'pages' / 'NNN.png'}")
    print(f"json: {run_dir(slug) / 'pages' / 'NNN.json'}")
    print(f"thumbs: {run_dir(slug) / 'thumbs' / 'sheet-NN.png'}")
    return 0


def status_rows(state: dict) -> list[dict]:
    rows = []
    for n in page_numbers(state):
        rec = page_rec(state, n)
        rows.append(
            {
                "page": n,
                "kind": page_kind(state, n),
                "status": rec["status"],
                "attempts": rec["attempts"],
                "stale": json_is_stale(state["slug"], n, rec),
                "first_error": rec["errors"][0] if rec["errors"] else (rec["reason"] or ""),
                "history": rec.get("history", []),
            }
        )
    return rows


def cmd_status(args: argparse.Namespace) -> int:
    state = load_state_guarded(args.slug)
    rows = status_rows(state)
    counts = {s: 0 for s in PAGE_STATUSES}
    for r in rows:
        counts[r["status"]] += 1
    nxt = next_page(state)
    if args.json:
        print(dump_json({"slug": state["slug"], "counts": counts, "ranges": state["ranges"], "next": nxt, "pages": rows, "merged": state["merged"]}), end="")
        return 0
    print(f"slug: {state['slug']}")
    print(f"pdf: {state['pdf_path']}")
    print(f"pages: {state['page_count']}  " + "  ".join(f"{k} {v}" for k, v in counts.items()))
    print(f"ranges: {state['ranges']['spec'] or '(none)'}  confirmed={str(state['ranges']['confirmed']).lower()}")
    print(f"next: {nxt if nxt is not None else 'done'}")
    print("")
    print(f"{'page':>4}  {'kind':<9} {'status':<8} {'att':>3}  {'stale':<5} first error")
    for r in rows:
        print(f"{r['page']:>4}  {(r['kind'] or '-'):<9} {r['status']:<8} {r['attempts']:>3}  {('yes' if r['stale'] else '-'):<5} {r['first_error']}".rstrip())
    return 0


def cmd_set_ranges(args: argparse.Namespace) -> int:
    state = load_state_guarded(args.slug)
    kinds = parse_ranges(args.spec, state["page_count"])
    state["ranges"] = {"spec": args.spec, "confirmed": False, "kinds": kinds}
    for n in page_numbers(state):
        rec = page_rec(state, n)
        if rec["status"] == "skipped" and str(rec["reason"] or "").startswith("range:"):
            rec["status"] = "pending"
            rec["reason"] = None
    save_state(state)
    summary = {}
    for k in kinds.values():
        summary[k] = summary.get(k, 0) + 1
    print("ranges stored (unconfirmed): " + ", ".join(f"{k} {v}" for k, v in sorted(summary.items())))
    print("show the status table to the user, then run confirm-ranges")
    return 0


def cmd_confirm_ranges(args: argparse.Namespace) -> int:
    state = load_state_guarded(args.slug)
    if not state["ranges"]["spec"]:
        raise CLIError(2, "no ranges set; run set-ranges first")
    state["ranges"]["confirmed"] = True
    skipped = 0
    for n in page_numbers(state):
        kind = page_kind(state, n)
        rec = page_rec(state, n)
        if kind not in TRANSCRIBE_KINDS and rec["status"] != "ok":
            rec["status"] = "skipped"
            rec["reason"] = f"range:{kind}"
            skipped += 1
    save_state(state)
    print(f"ranges confirmed; {skipped} pages skipped by range; next: {next_page(state) or 'done'}")
    return 0


def cmd_next(args: argparse.Namespace) -> int:
    state = load_state_guarded(args.slug)
    nxt = next_page(state)
    print("done" if nxt is None else str(nxt))
    return 0


def cmd_skip(args: argparse.Namespace) -> int:
    state = load_state_guarded(args.slug)
    if not 1 <= args.page <= state["page_count"]:
        raise CLIError(2, f"page {args.page} is outside 1..{state['page_count']}")
    rec = page_rec(state, args.page)
    rec["status"] = "skipped"
    rec["reason"] = args.reason
    save_state(state)
    print(f"page {args.page} skipped: {args.reason}")
    return 0


def cmd_prompt(args: argparse.Namespace) -> int:
    state = load_state_guarded(args.slug)
    if not 1 <= args.page <= state["page_count"]:
        raise CLIError(2, f"page {args.page} is outside 1..{state['page_count']}")
    print(build_prompt(state, args.page), end="")
    return 0


def _print_check_result(n: int, ok: bool, errors: list[str], warnings: list[str], rec: dict) -> None:
    if ok:
        print(f"P{n:03d} ok" + (f" ({len(warnings)} warnings)" if warnings else ""))
    else:
        print(f"P{n:03d} {rec['status']} (attempts {rec['attempts']})")
        for e in errors:
            print(f"  error: {e}")
    for w in warnings:
        print(f"  warning: {w}")
    if rec["status"] == "skipped":
        print(f"  skipped: {rec['reason']}")


def cmd_check(args: argparse.Namespace) -> int:
    state = load_state_guarded(args.slug)
    if args.all:
        results = check_all(state)
        save_state(state)
        failed = 0
        for n, (ok, errors, warnings) in results.items():
            _print_check_result(n, ok, errors, warnings, page_rec(state, n))
            failed += 0 if ok else 1
        print(f"checked {len(results)} pages, {failed} failed")
        return 1 if failed else 0
    if args.page is None:
        raise CLIError(2, "check needs --page N or --all")
    if not 1 <= args.page <= state["page_count"]:
        raise CLIError(2, f"page {args.page} is outside 1..{state['page_count']}")
    ok, errors, warnings = check_page(state, args.page, force=args.force, reason=args.reason)
    save_state(state)
    _print_check_result(args.page, ok, errors, warnings, page_rec(state, args.page))
    return 0 if ok else 1


def cmd_merge_solutions(args: argparse.Namespace) -> int:
    state = load_state_guarded(args.slug)
    other = args.from_slug
    if other == state["slug"]:
        raise CLIError(2, "cannot merge a run into itself")
    other_state = load_state(other)
    if other_state is None:
        raise CLIError(2, f"unknown run '{other}'; prepare and transcribe it first")
    if not other_state["ranges"]["confirmed"]:
        raise CLIError(2, f"run '{other}' has unconfirmed ranges")
    copied: list[int] = []
    for n in page_numbers(other_state):
        if page_rec(other_state, n)["status"] != "ok":
            continue
        src = page_json(other, n)
        if not src.is_file():
            continue
        data = read_json_tolerant(src)
        if not any(it["kind"] == "solution" for it in data["items"]):
            continue
        atomic_write_bytes(merged_dir(state["slug"], other) / f"{n:03d}.json", src.read_bytes())
        copied.append(n)
    entry = {"slug": other, "pdf_sha256": other_state["pdf_sha256"], "pages": copied}
    state["merged"] = [m for m in state["merged"] if m["slug"] != other] + [entry]
    state["merged"].sort(key=lambda m: m["slug"])
    save_state(state)
    print(f"merged {len(copied)} solution pages from '{other}': {', '.join(map(str, copied)) or '-'}")
    return 0


def cmd_set_out_root(args: argparse.Namespace) -> int:
    state = load_state_guarded(args.slug)
    state["out_root"] = str(Path(args.out_root).resolve())
    save_state(state)
    print(f"out root stored: {state['out_root']}")
    print(f"out dir: {out_dir(state['slug'])}")
    return 0


def cmd_assemble(args: argparse.Namespace) -> int:
    state = load_state_guarded(args.slug)
    if getattr(args, "out_root", None):
        state["out_root"] = str(Path(args.out_root).resolve())
        save_state(state)
    results = check_all(state)
    save_state(state)
    failed = [n for n, (ok, _e, _w) in results.items() if not ok]
    if failed:
        print(f"check --all: {len(failed)} failed pages ({', '.join(map(str, failed))}); assembling ok pages only")
    summary = assemble(state, legacy_ocr_fixes=getattr(args, "legacy_ocr_fixes", False))
    print(f"out dir: {out_dir(state['slug'])}")
    print(f"problems: {len(summary['problems'])}  unmatched solutions: {len(summary['unmatched_solutions'])}  orphans: {len(summary['orphans'])}")
    print("counts: " + "  ".join(f"{k} {v}" for k, v in summary["counts"].items()))
    tq = summary.get("text_quality", {})
    print(f"text quality: good={tq.get('good', 0)}  poor={tq.get('poor', 0)}  broken={tq.get('broken', 0)}")
    return 0


def cmd_postprocess(args: argparse.Namespace) -> int:
    slug = args.slug
    odir = out_dir(slug)
    if not odir.is_dir():
        raise CLIError(2, f"output directory not found: {odir}; run assemble first")

    state = load_state(slug)
    if state and state.get("ranges", {}).get("confirmed"):
        assemble(state, legacy_ocr_fixes=getattr(args, "legacy_ocr_fixes", False))
        print(f"postprocess: re-assembled '{slug}' with latest quality metrics")
        return 0

    pdir = odir / "problems"
    modified = 0
    tq_counts = {"good": 0, "poor": 0, "broken": 0}

    if pdir.is_dir():
        for f in sorted(pdir.glob("*.md")):
            orig = f.read_text(encoding="utf-8")
            new_c, info = postprocess_file_content(orig, legacy_ocr_fixes=getattr(args, "legacy_ocr_fixes", False))
            tq = info["text_quality"]
            tq_counts[tq] = tq_counts.get(tq, 0) + 1
            if new_c != orig:
                write_legacy_changes(slug, [{"file": str(f), **c} for c in info["legacy_changes"]])
                atomic_write_text(f, new_c)
                modified += 1

    slug_md = odir / f"{slug}.md"
    if slug_md.is_file():
        orig = slug_md.read_text(encoding="utf-8")
        new_c, _info = postprocess_file_content(orig, legacy_ocr_fixes=getattr(args, "legacy_ocr_fixes", False))
        if new_c != orig:
            write_legacy_changes(slug, [{"file": str(slug_md), **c} for c in _info["legacy_changes"]])
            atomic_write_text(slug_md, new_c)
            modified += 1

    print(f"postprocess: updated {modified} files on disk for '{slug}'")

    print(f"text quality: good={tq_counts.get('good', 0)}  poor={tq_counts.get('poor', 0)}  broken={tq_counts.get('broken', 0)}")
    return 0


def cmd_audit(args: argparse.Namespace) -> int:
    slug = args.slug
    odir = out_dir(slug)
    if not odir.is_dir():
        raise CLIError(2, f"output directory not found: {odir}; run assemble first")

    pdir = odir / "problems"
    if not pdir.is_dir():
        print("no problems directory found")
        return 0

    tq_counts = {"good": 0, "poor": 0, "broken": 0}
    pua_count = 0
    ctrl_count = 0
    syntax_errors = []
    header_trapped = []

    files = sorted(pdir.glob("*.md"))
    for f in files:
        c = f.read_text(encoding="utf-8")
        pua_matches = PUA_RE.findall(c)
        if pua_matches:
            pua_count += len(pua_matches)
        ctrl_matches = CONTROL_CHARS_RE.findall(c)
        if ctrl_matches:
            ctrl_count += len(ctrl_matches)
        if re.search(r"^###\s+[0-9]+\.[ \t]+(?![\(\>])\S+", c, flags=re.M):
            header_trapped.append(f.name)
        errs = audit_math_syntax(c)
        if errs:
            syntax_errors.append((f.name, errs))
        tq_match = re.search(r"^text_quality:\s*\"?([a-z]+)\"?", c, flags=re.M)
        tq = tq_match.group(1) if tq_match else "unknown"
        tq_counts[tq] = tq_counts.get(tq, 0) + 1

    print(f"=== Quality Audit for '{slug}' ({len(files)} problems) ===")
    print(f"  Text Quality: good={tq_counts.get('good', 0)}, poor={tq_counts.get('poor', 0)}, broken={tq_counts.get('broken', 0)}")
    print(f"  PUA Characters: {pua_count}")
    print(f"  Ghost Control Characters: {ctrl_count}")
    print(f"  Header-trapped Problems: {len(header_trapped)}")
    if header_trapped:
        print(f"    Sample: {', '.join(header_trapped[:5])}")
    print(f"  LaTeX Syntax Issues: {len(syntax_errors)}")
    for fn, errs in syntax_errors[:5]:
        print(f"    - {fn}: {'; '.join(errs)}")
    return 1 if (tq_counts.get("broken", 0) > 0 or pua_count > 0 or ctrl_count > 0 or syntax_errors) else 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="pdf2md", description="pdf-math-md helper: render, check, assemble")
    parser.add_argument("--version", action="version", version=f"pdf2md {VERSION} {SCRIPT_PATH}")
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("prepare", help="render pages + thumbnail sheets, create state")
    p.add_argument("pdf")
    p.add_argument("--slug")
    p.add_argument("--dpi", type=int, default=200)
    p.add_argument("--reset", action="store_true")
    p.add_argument("--out-root", help="parent folder for this run's output dir (persisted; e.g. a subject folder)")
    p.set_defaults(func=cmd_prepare)

    for name, func, help_ in (
        ("paths", cmd_paths, "print run/out paths"),
        ("next", cmd_next, "print the next page to transcribe or 'done'"),
        ("confirm-ranges", cmd_confirm_ranges, "confirm ranges; skip front/other pages"),
    ):
        p = sub.add_parser(name, help=help_)
        p.add_argument("slug")
        p.set_defaults(func=func)

    p = sub.add_parser("assemble", help="check --all then build the Markdown output tree")
    p.add_argument("slug")
    p.add_argument("--out-root", help="parent folder for the output dir (persisted in state)")
    p.add_argument("--legacy-ocr-fixes", action="store_true", help="apply historical ambiguous OCR substitutions with a before/after log")
    p.set_defaults(func=cmd_assemble)

    p = sub.add_parser("postprocess", help="apply text/math normalizations and quality assessment to assembled files")
    p.add_argument("slug")
    p.add_argument("--legacy-ocr-fixes", action="store_true", help="apply historical ambiguous OCR substitutions with a before/after log")
    p.set_defaults(func=cmd_postprocess)

    p = sub.add_parser("audit", help="inspect assembled markdown files for quality defects and print summary")
    p.add_argument("slug")
    p.set_defaults(func=cmd_audit)

    p = sub.add_parser("set-out-root", help="store the output root for a run (e.g. a subject folder)")
    p.add_argument("slug")
    p.add_argument("--out-root", required=True)
    p.set_defaults(func=cmd_set_out_root)

    p = sub.add_parser("status", help="progress table")
    p.add_argument("slug")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("set-ranges", help="store page ranges, e.g. 1-2:front,3-40:problems")
    p.add_argument("slug")
    p.add_argument("--spec", required=True)
    p.set_defaults(func=cmd_set_ranges)

    p = sub.add_parser("skip", help="mark a page skipped")
    p.add_argument("slug")
    p.add_argument("--page", type=int, required=True)
    p.add_argument("--reason", required=True)
    p.set_defaults(func=cmd_skip)

    p = sub.add_parser("prompt", help="print the per-page transcription prompt")
    p.add_argument("slug")
    p.add_argument("--page", type=int, required=True)
    p.set_defaults(func=cmd_prompt)

    p = sub.add_parser("check", help="validate pages/NNN.json")
    p.add_argument("slug")
    p.add_argument("--page", type=int)
    p.add_argument("--all", action="store_true")
    p.add_argument("--force", action="store_true", help="re-check a skipped page; needs --reason")
    p.add_argument("--reason", help="who asked to re-check the skipped page and why (recorded in history)")
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("merge-solutions", help="copy solution pages from another run")
    p.add_argument("slug")
    p.add_argument("--from", dest="from_slug", required=True)
    p.set_defaults(func=cmd_merge_solutions)
    return parser



def _reconfigure_streams() -> None:
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(AttributeError, ValueError):
            stream.reconfigure(encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    """Entry point; returns the exit code instead of calling ``sys.exit``."""
    _reconfigure_streams()
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "--version":
        # Printed directly: argparse's version action wraps long paths.
        print(f"pdf2md {VERSION} {SCRIPT_PATH}")
        return 0
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:  # --version / --help / argparse errors
        return int(exc.code or 0)
    if not getattr(args, "command", None):
        parser.print_help()
        return 2
    try:
        return int(args.func(args))
    except CLIError as exc:
        print(f"error: {exc.message}", file=sys.stderr)
        return exc.code


if __name__ == "__main__":
    sys.exit(main())
