"""Shared fixtures: isolated run/out roots, in-process CLI, page JSON builders."""
from __future__ import annotations

import contextlib
import io
import json
import sys
import types
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import pdf2md  # noqa: E402

FIXTURE_PDF = Path(__file__).resolve().parent / "fixtures" / "fixture-2p.pdf"


@pytest.fixture(autouse=True)
def isolate_roots(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF2MD_RUN_ROOT", str(tmp_path / "run"))
    monkeypatch.setenv("PDF2MD_OUT_ROOT", str(tmp_path / "out"))
    yield


def run_cli(argv) -> tuple[int, str]:
    """Run ``pdf2md.main`` in-process; returns (exit code, captured stdout+stderr)."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        code = pdf2md.main([str(a) for a in argv])
    return code, buf.getvalue()


def item(kind: str, **overrides) -> dict:
    """A page item with every required field filled; non-empty text per kind."""
    base = {
        "kind": kind,
        "chapter": None,
        "number": None,
        "statement_md": "",
        "solution_md": "",
        "parts": [],
        "figures": [],
        "continues_from_previous": False,
        "continues_to_next": False,
        "confidence": 0.9,
    }
    if kind == "problem" and "statement_md" not in overrides:
        base["statement_md"] = f"Compute the value for problem {overrides.get('number', '')}.".strip()
    if kind == "solution" and "solution_md" not in overrides:
        base["solution_md"] = f"Solution text for {overrides.get('number', '')}.".strip()
    if kind == "heading" and "statement_md" not in overrides:
        base["statement_md"] = overrides.get("chapter") or "Heading"
    if kind == "continuation" and "continues_from_previous" not in overrides:
        base["continues_from_previous"] = True
    base.update(overrides)
    return base


def part(label: str, statement_md: str = "", solution_md: str = "") -> dict:
    return {"label": label, "statement_md": statement_md, "solution_md": solution_md}


def figure(bbox, caption="그림", description="설명 문단") -> dict:
    return {"bbox_norm": list(bbox), "caption": caption, "description": description}


def page(n: int, items: list, layout: str = "single", notes: str = "") -> dict:
    return {"schema_version": 1, "page": n, "layout": layout, "page_notes": notes, "items": items}


def make_run(slug: str = "t", n: int = 3, spec=None, confirm: bool = True, size=(100, 140)) -> str:
    """Create a run without pypdfium2: fake PDF bytes, blank PNGs, state.json."""
    from PIL import Image

    root = pdf2md.run_root()
    root.mkdir(parents=True, exist_ok=True)
    pdf = root / f"{slug}.pdf"
    pdf.write_bytes(b"%PDF-1.4 fake\n" + slug.encode("utf-8"))
    state = pdf2md.new_state(slug, pdf, pdf2md.sha256_file(pdf), n, 72)
    for p in range(1, n + 1):
        png = pdf2md.page_png(slug, p)
        png.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", size, "white").save(png, format="PNG")
    pdf2md.save_state(state)
    if spec is None:
        spec = f"1-{n}:problems"
    if spec:
        code, out = run_cli(["set-ranges", slug, "--spec", spec])
        assert code == 0, out
        if confirm:
            code, out = run_cli(["confirm-ranges", slug])
            assert code == 0, out
    return slug


def write_page(slug: str, data: dict, n: int | None = None) -> Path:
    n = n or data["page"]
    path = pdf2md.page_json(slug, n)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def check(slug: str, n: int, force: bool = False) -> tuple[int, str]:
    argv = ["check", slug, "--page", n]
    if force:
        argv.append("--force")
    return run_cli(argv)


def check_ok(slug: str, *datas: dict) -> None:
    for data in datas:
        write_page(slug, data)
        code, out = check(slug, data["page"])
        assert code == 0, out


def state(slug: str) -> dict:
    return pdf2md.load_state(slug)


def out_dir(slug: str) -> Path:
    return pdf2md.out_dir(slug)


def tree_bytes(root: Path) -> dict[str, bytes]:
    return {str(p.relative_to(root)).replace("\\", "/"): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


@pytest.fixture
def h():
    return types.SimpleNamespace(
        pdf2md=pdf2md,
        FIXTURE_PDF=FIXTURE_PDF,
        run_cli=run_cli,
        item=item,
        part=part,
        figure=figure,
        page=page,
        make_run=make_run,
        write_page=write_page,
        check=check,
        check_ok=check_ok,
        state=state,
        out_dir=out_dir,
        tree_bytes=tree_bytes,
    )
