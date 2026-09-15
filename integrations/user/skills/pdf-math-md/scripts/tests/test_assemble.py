"""assemble determinism, stale-file removal, range gating and prompt context."""


def build_two_page_run(h, slug="asm"):
    h.make_run(slug=slug, n=2, size=(200, 280))
    h.check_ok(
        slug,
        h.page(1, [h.item("heading", chapter="§1"), h.item("problem", number="1", statement_md="First $x$", figures=[h.figure([0.1, 0.1, 0.6, 0.4], caption="cap")], continues_to_next=True)]),
        h.page(2, [h.item("continuation", number="1", statement_md="tail"), h.item("problem", number="2", solution_md="Own solution.")]),
    )
    return slug


def test_running_assemble_twice_produces_byte_identical_tree(h):
    slug = build_two_page_run(h)
    code, out = h.run_cli(["assemble", slug])
    assert code == 0, out
    first = h.tree_bytes(h.out_dir(slug))
    assert {"index.md", f"{slug}.md", ".pdf2md.json", "img/p001-1.png", "problems/001-ch1-1.md", "problems/002-ch1-2.md"} <= set(first)
    code, out = h.run_cli(["assemble", slug])
    assert code == 0, out
    assert h.tree_bytes(h.out_dir(slug)) == first
    summary = h.pdf2md.read_json_tolerant(h.out_dir(slug) / ".pdf2md.json")
    assert summary["counts"] == {"ok": 2, "failed": 0, "skipped": 0, "pending": 0}
    assert summary["problems"] == ["001-ch1-1.md", "002-ch1-2.md"]
    assert summary["orphans"] == [] and summary["unmatched_solutions"] == []
    assert "timestamp" not in (h.out_dir(slug) / ".pdf2md.json").read_text(encoding="utf-8")


def test_stale_problem_and_image_files_are_removed(h):
    slug = build_two_page_run(h)
    stale_md = h.out_dir(slug) / "problems" / "999-chold-9.md"
    stale_png = h.out_dir(slug) / "img" / "p099-1.png"
    for p in (stale_md, stale_png):
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"old")
    code, out = h.run_cli(["assemble", slug])
    assert code == 0, out
    assert not stale_md.exists() and not stale_png.exists()
    assert (h.out_dir(slug) / "problems" / "001-ch1-1.md").is_file()


def test_prompt_and_assemble_refuse_before_ranges_are_confirmed(h):
    slug = h.make_run(n=2, confirm=False)
    code, out = h.run_cli(["prompt", slug, "--page", 1])
    assert code == 2 and "not confirmed" in out
    code, out = h.run_cli(["assemble", slug])
    assert code == 2 and "not confirmed" in out
    assert h.run_cli(["confirm-ranges", slug])[0] == 0
    code, out = h.run_cli(["prompt", slug, "--page", 1])
    assert code == 0
    assert str(h.pdf2md.page_json(slug, 1)) in out and str(h.pdf2md.page_png(slug, 1)) in out
    assert '"$schema": "https://json-schema.org/draft/2020-12/schema"' in out
    assert "{{" not in out
    assert len(out.splitlines()) < 220


def test_prompt_refuses_pages_outside_transcription_ranges(h):
    slug = h.make_run(n=3, spec="1:front,2:problems,3:other")
    assert h.run_cli(["prompt", slug, "--page", 1])[0] == 2
    assert h.run_cli(["prompt", slug, "--page", 3])[0] == 2
    assert h.run_cli(["prompt", slug, "--page", 2])[0] == 0
    st = h.state(slug)
    assert st["pages"]["1"]["reason"] == "range:front" and st["pages"]["3"]["reason"] == "range:other"
    assert h.run_cli(["next", slug])[1].strip() == "2"


def test_prompt_carries_context_from_previous_ok_page(h):
    slug = build_two_page_run(h)
    code, out = h.run_cli(["prompt", slug, "--page", 2])
    assert code == 0
    assert "- 현재 장: §1" in out
    assert "- 마지막 문제 번호: 1" in out
    assert "- 이전 페이지 마지막 항목 kind: problem" in out
    assert "First $x$" in out
    assert "`continues_to_next` 로 끝남: true" in out
    assert "## 직전 검사 오류 (실패 페이지일 때)\n없음" in out


def test_set_ranges_rejects_overlap_gaps_and_bad_kinds(h):
    slug = h.make_run(n=5, spec="")
    code, out = h.run_cli(["set-ranges", slug, "--spec", "1-3:front,3-5:problems"])
    assert code == 1 and "covered twice" in out
    code, out = h.run_cli(["set-ranges", slug, "--spec", "1-2:front,4-5:problems"])
    assert code == 1 and "do not cover pages: 3" in out
    code, out = h.run_cli(["set-ranges", slug, "--spec", "1-5:answers"])
    assert code == 1 and "bad range kind" in out
    code, out = h.run_cli(["set-ranges", slug, "--spec", "1-6:problems"])
    assert code == 1 and "outside 1..5" in out
    assert h.state(slug)["ranges"]["spec"] is None
    code, out = h.run_cli(["set-ranges", slug, "--spec", "1:front,2-4:problems,5:solutions"])
    assert code == 0 and "front 1, problems 3, solutions 1" in out


def test_set_ranges_after_confirm_resets_range_skips(h):
    slug = h.make_run(n=2, spec="1:front,2:problems")
    assert h.state(slug)["pages"]["1"]["status"] == "skipped"
    assert h.run_cli(["set-ranges", slug, "--spec", "1-2:problems"])[0] == 0
    st = h.state(slug)
    assert st["ranges"]["confirmed"] is False
    assert st["pages"]["1"]["status"] == "pending" and st["pages"]["1"]["reason"] is None


def test_version_prints_script_path(h):
    code, out = h.run_cli(["--version"])
    assert code == 0
    assert out.strip() == f"pdf2md 0.1.0 {h.pdf2md.SCRIPT_PATH}"
