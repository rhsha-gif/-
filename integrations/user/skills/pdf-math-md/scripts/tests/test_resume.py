"""Resume behaviour: idempotent prepare, attempts, sha guard, reset, stale flag."""
import shutil


def test_prepare_is_idempotent_and_keeps_state(h, tmp_path):
    code, out = h.run_cli(["prepare", h.FIXTURE_PDF, "--dpi", 72])
    assert code == 0, out
    assert "slug: fixture-2p" in out and "pages: 2 (rendered 2" in out
    slug = "fixture-2p"
    png = h.pdf2md.page_png(slug, 1)
    sheet = h.pdf2md.run_dir(slug) / "thumbs" / "sheet-01.png"
    assert png.is_file() and h.pdf2md.page_png(slug, 2).is_file() and sheet.is_file()
    before = (png.stat().st_mtime_ns, sheet.stat().st_mtime_ns)
    assert h.run_cli(["set-ranges", slug, "--spec", "1-2:problems"])[0] == 0
    code, out = h.run_cli(["prepare", h.FIXTURE_PDF, "--dpi", 72])
    assert code == 0 and "rendered 0" in out
    assert (png.stat().st_mtime_ns, sheet.stat().st_mtime_ns) == before
    assert h.state(slug)["ranges"]["spec"] == "1-2:problems"
    code, out = h.run_cli(["paths", slug])
    assert code == 0 and "sheet-NN.png" in out and "NNN.json" in out


def test_three_failed_attempts_skip_the_page_and_force_recovers(h):
    slug = h.make_run(n=2)
    h.check_ok(slug, h.page(1, [h.item("problem", number="1")]))
    h.write_page(slug, h.page(2, [h.item("problem", number="9")]))
    for attempt in (1, 2):
        code, out = h.check(slug, 2)
        assert code == 1
        assert h.state(slug)["pages"]["2"]["status"] == "failed"
        assert h.state(slug)["pages"]["2"]["attempts"] == attempt
        assert h.run_cli(["next", slug])[1].strip() == "2"
    code, out = h.check(slug, 2)
    rec = h.state(slug)["pages"]["2"]
    assert rec["status"] == "skipped" and rec["attempts"] == 3 and rec["reason"].startswith("max-retries: P002/item[0]: gap")
    assert h.run_cli(["next", slug])[1].strip() == "done"
    code, out = h.check(slug, 2)
    assert code == 2 and "--force" in out
    h.write_page(slug, h.page(2, [h.item("problem", number="2")]))
    code, out = h.check(slug, 2, force=True)
    assert code == 2 and "--reason" in out, "force without a human reason is refused"
    code, out = h.check(slug, 2, force=True, reason="user re-read the scan and asked for a retry")
    assert code == 0, out
    rec = h.state(slug)["pages"]["2"]
    assert rec["status"] == "ok" and rec["attempts"] == 0 and rec["reason"] is None
    assert rec["force_reason"] == "user re-read the scan and asked for a retry"
    events = [e["event"] for e in rec["history"]]
    assert events == ["failed", "failed", "failed", "force"], "first-failure errors survive the later ok"
    assert rec["history"][0]["attempt"] == 1 and "gap" in rec["history"][0]["errors"][0]


def test_prompt_shows_last_errors_for_failed_page(h):
    slug = h.make_run(n=1)
    h.write_page(slug, h.page(1, [h.item("problem", number="1", statement_md="$x")]))
    assert h.check(slug, 1)[0] == 1
    code, out = h.run_cli(["prompt", slug, "--page", 1])
    assert code == 0
    assert "- P001/item[0]: statement_md: unbalanced `$`" in out


def test_changed_pdf_is_refused_with_both_hashes_and_reset_hint(h):
    slug = h.make_run(n=1)
    old_sha = h.state(slug)["pdf_sha256"]
    pdf = h.pdf2md.run_root() / f"{slug}.pdf"
    pdf.write_bytes(pdf.read_bytes() + b"\n%changed")
    new_sha = h.pdf2md.sha256_file(pdf)
    for argv in (["status", slug], ["next", slug], ["check", slug, "--page", 1]):
        code, out = h.run_cli(argv)
        assert code == 2, argv
        assert old_sha in out and new_sha in out and "--reset" in out
    pdf.unlink()
    assert h.run_cli(["next", slug])[0] == 0, "assemble/status keep working when the PDF is gone"


def test_prepare_reset_replaces_run_dir_but_never_touches_out_dir(h, tmp_path):
    changed = tmp_path / "changed.pdf"
    shutil.copy(h.FIXTURE_PDF, changed)
    assert h.run_cli(["prepare", changed, "--slug", "fx", "--dpi", 72])[0] == 0
    assert h.run_cli(["set-ranges", "fx", "--spec", "1-2:problems"])[0] == 0
    keep = h.out_dir("fx") / "keep.txt"
    keep.parent.mkdir(parents=True)
    keep.write_text("user data", encoding="utf-8")
    changed.write_bytes(changed.read_bytes() + b"\n%trailing comment")
    code, out = h.run_cli(["prepare", changed, "--slug", "fx", "--dpi", 72])
    assert code == 2 and "--reset" in out
    code, out = h.run_cli(["prepare", changed, "--slug", "fx", "--dpi", 72, "--reset"])
    assert code == 0, out
    st = h.state("fx")
    assert st["pdf_sha256"] == h.pdf2md.sha256_file(changed)
    assert st["ranges"]["spec"] is None
    assert keep.read_text(encoding="utf-8") == "user data"


def test_status_flags_json_edited_after_check_as_stale(h):
    slug = h.make_run(n=2)
    h.check_ok(slug, h.page(1, [h.item("problem", number="1")]))
    code, out = h.run_cli(["status", slug])
    assert code == 0 and "ok 1" in out and "pending 1" in out
    path = h.write_page(slug, h.page(1, [h.item("problem", number="1", statement_md="edited later")]))
    code, out = h.run_cli(["status", slug])
    assert code == 0
    line = next(l for l in out.splitlines() if l.strip().startswith("1  problems"))
    assert "yes" in line
    code, out = h.run_cli(["status", slug, "--json"])
    assert code == 0
    import json

    data = json.loads(out)
    assert data["pages"][0]["stale"] is True and data["pages"][1]["stale"] is False
    assert data["next"] == 2
    assert path.is_file()
