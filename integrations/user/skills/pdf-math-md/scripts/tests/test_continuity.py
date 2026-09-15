"""Numbering continuity inside sheet groups, number normalization, chapter provenance."""


def test_normalize_number_examples(h):
    n = h.pdf2md.normalize_number
    assert n("3") == "3" and n("12-1") == "12-1" and n("7(a)") == "7(a)"
    assert n("(3)") == "3" and n("3)") == "3" and n("3.") == "3" and n("[3]") == "3"
    assert n("III") == "3" and n("iv.") == "4" and n("IX") == "9" and n("VII-2") == "7-2"
    assert n("①") == "1" and n("⑫") == "12"
    assert n("문제 3") == "3" and n("Problem 4") == "4" and n("Q5") == "5"
    assert n(None) is None and n(7) == 7


def test_printed_variants_are_normalized_before_checks_with_a_note(h):
    slug = h.make_run(n=1)
    h.write_page(slug, h.page(1, [h.item("problem", number="(1)"), h.item("problem", number="II"), h.item("problem", number="③")]))
    code, out = h.check(slug, 1)
    assert code == 0, out
    assert "number '(1)' normalized to '1'" in out and "number 'II' normalized to '2'" in out
    assert h.state(slug)["pages"]["1"]["last_problem_after"]["number"] == "3"


def test_null_number_with_printed_leading_number_is_error(h):
    slug = h.make_run(n=1)
    h.write_page(slug, h.page(1, [h.item("problem", statement_md="III. Find the kernel of $T$.")]))
    code, out = h.check(slug, 1)
    assert code == 1 and "number is null but the statement starts with the printed number 'III'" in out
    h.write_page(slug, h.page(1, [h.item("problem", statement_md="Find the kernel of $T$.")]))
    assert h.check(slug, 1)[0] == 0, "unnumbered problems stay allowed"


def test_increasing_numbers_across_pages_are_accepted(h):
    slug = h.make_run(n=2)
    h.check_ok(slug, h.page(1, [h.item("problem", number="1"), h.item("problem", number="2")]), h.page(2, [h.item("problem", number="3")]))
    assert h.state(slug)["pages"]["2"]["last_problem_after"] == {"n": 3, "number": "3", "page": 2, "group": 0}


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


def test_number_restart_opens_a_new_sheet_group_with_a_warning(h):
    slug = h.make_run(n=1)
    h.write_page(slug, h.page(1, [h.item("problem", number="5"), h.item("problem", number="2")]))
    code, out = h.check(slug, 1)
    assert code == 0, out
    assert "restarts after 5" in out and "heading item" in out
    rec = h.state(slug)["pages"]["1"]
    assert rec["group_after"] == 1 and rec["last_problem_after"]["group"] == 1


def test_heading_restarts_numbering_without_warning(h):
    slug = h.make_run(n=2)
    h.check_ok(
        slug,
        h.page(1, [h.item("heading", chapter="§3.1"), h.item("problem", number="1"), h.item("problem", number="2")]),
        h.page(2, [h.item("heading", chapter="§3.2"), h.item("problem", number="1")]),
    )
    rec = h.state(slug)["pages"]["2"]
    assert rec["chapter_after"] == "§3.2" and rec["group_after"] == 2
    assert rec["warnings"] == []


def test_range_block_boundaries_are_sheet_boundaries(h):
    slug = h.make_run(n=3, spec="1:problems,2:solutions,3:problems")
    h.check_ok(
        slug,
        h.page(1, [h.item("problem", number="1"), h.item("problem", number="2")]),
        h.page(2, [h.item("problem", number="5", solution_md="restated with answer"), h.item("solution", number="6")]),
        h.page(3, [h.item("problem", number="1")]),
    )
    st = h.state(slug)
    assert st["pages"]["2"]["group_after"] == 1 and st["pages"]["2"]["warnings"] == [], "no gap error across the block boundary"
    assert st["pages"]["3"]["group_after"] == 2 and st["pages"]["3"]["warnings"] == []


def test_chapter_must_come_from_a_heading_item(h):
    slug = h.make_run(n=2)
    h.write_page(slug, h.page(1, [h.item("problem", chapter="Chapter 7", number="1")]))
    code, out = h.check(slug, 1)
    assert code == 1
    assert "chapter 'Chapter 7' was not introduced by a heading item" in out and "Never invent" in out
    h.check_ok(slug, h.page(1, [h.item("heading", chapter="Chapter 7"), h.item("problem", chapter="Chapter 7", number="1")]))
    h.check_ok(slug, h.page(2, [h.item("problem", chapter="Chapter 7", number="2"), h.item("problem", number="3")]))


def test_solution_number_restart_forms_a_new_solution_group(h):
    slug = h.make_run(n=3, spec="1:problems,2-3:solutions")
    h.check_ok(
        slug,
        h.page(1, [h.item("problem", number="1"), h.item("problem", number="2")]),
        h.page(2, [h.item("solution", number="1"), h.item("solution", number="3"), h.item("solution", number="5")]),
        h.page(3, [h.item("solution", number="4"), h.item("solution", number="5")]),
    )
    rec = h.state(slug)["pages"]["3"]
    assert rec["solution_group_after"] == 2 and rec["last_solution_after"]["number"] == "5"  # block boundary + restart


def test_check_all_rebuilds_snapshots_after_earlier_page_changes(h):
    slug = h.make_run(n=2)
    h.check_ok(slug, h.page(1, [h.item("problem", number="1"), h.item("problem", number="2")]), h.page(2, [h.item("problem", number="3")]))
    h.write_page(slug, h.page(1, [h.item("problem", number="1")]))
    code, out = h.run_cli(["check", slug, "--all"])
    assert code == 1
    st = h.state(slug)
    assert st["pages"]["1"]["status"] == "ok"
    assert st["pages"]["1"]["last_problem_after"]["number"] == "1"
    assert st["pages"]["2"]["status"] == "failed"
    assert st["pages"]["2"]["attempts"] == 0, "--all is a rebuild pass and does not count attempts"
    assert any("gap" in e for e in st["pages"]["2"]["errors"])
