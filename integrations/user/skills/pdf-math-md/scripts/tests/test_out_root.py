from __future__ import annotations


def _problem_page(h, n: int = 1):
    return h.page(n, [h.item("problem", number="1", statement_md="첫 줄\n둘째 줄")])


def test_out_root_stored_in_state_wins_over_env(h, tmp_path):
    slug = "root"
    h.make_run(slug=slug, n=1)
    h.check_ok(slug, _problem_page(h))
    subject = tmp_path / "선형대수학"
    code, out = h.run_cli(["set-out-root", slug, "--out-root", str(subject)])
    assert code == 0 and "out root stored" in out
    assert h.state(slug)["out_root"] == str(subject.resolve())
    assert h.run_cli(["assemble", slug])[0] == 0
    assert (subject / slug / "index.md").exists()
    code, out = h.run_cli(["paths", slug])
    assert code == 0 and str(subject / slug) in out


def test_assemble_out_root_flag_persists(h, tmp_path):
    slug = "root2"
    h.make_run(slug=slug, n=1)
    h.check_ok(slug, _problem_page(h))
    subject = tmp_path / "미적분"
    assert h.run_cli(["assemble", slug, "--out-root", str(subject)])[0] == 0
    assert (subject / slug / "problems").is_dir()
    assert h.state(slug)["out_root"] == str(subject.resolve())


def test_problem_note_does_not_repeat_its_first_line(h):
    slug = "dup"
    h.make_run(slug=slug, n=1)
    h.check_ok(slug, _problem_page(h))
    assert h.run_cli(["assemble", slug])[0] == 0
    note = next((h.out_dir(slug) / "problems").glob("*.md")).read_text(encoding="utf-8")
    assert note.count("첫 줄") == 1 and "둘째 줄" in note


def test_whole_note_heading_not_duplicated_when_text_starts_with_chapter(h):
    slug = "head"
    h.make_run(slug=slug, n=1)
    data = h.page(
        1,
        [
            h.item("heading", chapter="MIDTERM I", statement_md="MIDTERM I (4/6 12:40-1:30 pm)"),
            h.item("problem", number="1", statement_md="문제 하나"),
        ],
    )
    h.check_ok(slug, data)
    assert h.run_cli(["assemble", slug])[0] == 0
    whole = (h.out_dir(slug) / f"{slug}.md").read_text(encoding="utf-8")
    assert "## MIDTERM I (4/6 12:40-1:30 pm)" in whole and "## MIDTERM I MIDTERM I" not in whole
