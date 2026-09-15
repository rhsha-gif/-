"""Numbering continuity across pages (problems and solutions)."""


def test_normalize_chapter_examples(h):
    n = h.pdf2md.normalize_chapter
    assert n("§3.2") == "3.2"
    assert n("Chapter 4") == "4"
    assert n("연습문제 2.1") == "2.1"
    assert n("Appendix") == "appendix"
    assert n(None) is None


def test_increasing_numbers_across_pages_are_accepted(h):
    slug = h.make_run(n=2)
    h.check_ok(slug, h.page(1, [h.item("problem", number="1"), h.item("problem", number="2")]), h.page(2, [h.item("problem", number="3")]))
    assert h.state(slug)["pages"]["2"]["last_problem_after"] == {"scope": None, "n": 3, "number": "3", "page": 2}


def test_same_leading_int_with_different_string_is_accepted(h):
    slug = h.make_run(n=1)
    h.check_ok(slug, h.page(1, [h.item("problem", number="12-1"), h.item("problem", number="12-2")]))


def test_gap_of_two_or_more_is_error_unless_allow_gap_in_notes(h):
    slug = h.make_run(n=2)
    h.check_ok(slug, h.page(1, [h.item("problem", number="1")]))
    h.write_page(slug, h.page(2, [h.item("problem", number="3")]))
    code, out = h.check(slug, 2)
    assert code == 1 and "gap" in out
    h.write_page(slug, h.page(2, [h.item("problem", number="3")], notes="allow-gap: printed numbering skips 2"))
    code, out = h.check(slug, 2)
    assert code == 0, out


def test_backwards_number_errors_with_heading_hint(h):
    slug = h.make_run(n=1)
    h.write_page(slug, h.page(1, [h.item("problem", number="5"), h.item("problem", number="2")]))
    code, out = h.check(slug, 1)
    assert code == 1
    assert "goes backwards" in out and "add a heading item" in out


def test_heading_restarts_numbering(h):
    slug = h.make_run(n=2)
    h.check_ok(
        slug,
        h.page(1, [h.item("heading", chapter="§3.1"), h.item("problem", number="1"), h.item("problem", number="2")]),
        h.page(2, [h.item("heading", chapter="§3.2"), h.item("problem", number="1")]),
    )
    rec = h.state(slug)["pages"]["2"]
    assert rec["heading_seen"] is True
    assert rec["chapter_after"] == "§3.2"
    assert rec["problem_keys"] == [["3.2", "1"]]


def test_explicit_chapter_change_restarts_numbering(h):
    slug = h.make_run(n=1)
    h.check_ok(slug, h.page(1, [h.item("problem", chapter="Chapter 4", number="7"), h.item("problem", chapter="Chapter 5", number="1")]))


def test_duplicate_problem_on_earlier_page_is_reported(h):
    slug = h.make_run(n=3)
    h.check_ok(slug, h.page(1, [h.item("heading", chapter="§1"), h.item("problem", number="1"), h.item("problem", number="2")]))
    h.write_page(slug, h.page(2, [h.item("heading", chapter="§1"), h.item("problem", number="2")]))
    code, out = h.check(slug, 2)
    assert code == 1
    assert "duplicate problem 2" in out and "already on page 1" in out


def test_solutions_may_skip_numbers_but_must_increase_and_not_duplicate(h):
    slug = h.make_run(n=3, spec="1:problems,2-3:solutions")
    h.check_ok(
        slug,
        h.page(1, [h.item("problem", number="1"), h.item("problem", number="2")]),
        h.page(2, [h.item("solution", number="1"), h.item("solution", number="3"), h.item("solution", number="5")]),
    )
    h.write_page(slug, h.page(3, [h.item("solution", number="4")]))
    code, out = h.check(slug, 3)
    assert code == 1 and "does not increase" in out
    h.write_page(slug, h.page(3, [h.item("solution", number="5")]))
    code, out = h.check(slug, 3)
    assert code == 1 and "duplicate solution 5" in out


def test_check_all_rebuilds_snapshots_after_earlier_page_changes(h):
    slug = h.make_run(n=2)
    h.check_ok(slug, h.page(1, [h.item("problem", number="1"), h.item("problem", number="2")]), h.page(2, [h.item("problem", number="3")]))
    h.write_page(slug, h.page(1, [h.item("problem", number="1"), h.item("problem", number="2"), h.item("problem", number="3")]))
    code, out = h.run_cli(["check", slug, "--all"])
    assert code == 1
    st = h.state(slug)
    assert st["pages"]["1"]["status"] == "ok"
    assert st["pages"]["1"]["last_problem_after"]["number"] == "3"
    assert st["pages"]["2"]["status"] == "failed"
    assert st["pages"]["2"]["attempts"] == 0, "--all is a rebuild pass and does not count attempts"
    assert any("duplicate problem 3" in e or "goes backwards" in e for e in st["pages"]["2"]["errors"])
