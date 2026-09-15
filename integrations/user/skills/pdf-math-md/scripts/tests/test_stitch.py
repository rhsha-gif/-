"""Stitching continued items across pages and continuation flag checks."""


def test_problem_spanning_three_pages_is_stitched_into_one_file(h):
    slug = h.make_run(n=3)
    h.check_ok(
        slug,
        h.page(1, [h.item("problem", number="1", statement_md="Part one of the statement.", continues_to_next=True, confidence=0.9)]),
        h.page(2, [h.item("continuation", number="1", statement_md="Part two.", parts=[h.part("(a)", "first part")], continues_to_next=True, confidence=0.7)]),
        h.page(3, [h.item("continuation", number="1", parts=[h.part("(a)", "more of (a)"), h.part("(b)", "second part")], confidence=0.8), h.item("problem", number="2")]),
    )
    code, out = h.run_cli(["assemble", slug])
    assert code == 0, out
    files = sorted(p.name for p in (h.out_dir(slug) / "problems").iterdir())
    assert files == ["001-chnone-1.md", "002-chnone-2.md"]
    body = (h.out_dir(slug) / "problems" / "001-chnone-1.md").read_text(encoding="utf-8")
    assert "pages: [1, 2, 3]" in body
    assert "confidence: 0.7" in body
    assert "Part one of the statement.\n\nPart two." in body
    assert "**(a)** first part\n\nmore of (a)" in body
    assert "**(b)** second part" in body
    whole = (h.out_dir(slug) / f"{slug}.md").read_text(encoding="utf-8")
    assert "<!-- page 002 -->\n## p.002\n\n(앞 페이지에서 이어짐)" in whole
    assert whole.count("### 1. Part one") == 1


def test_continuation_after_closed_page_is_error_naming_previous_page(h):
    slug = h.make_run(n=2)
    h.check_ok(slug, h.page(1, [h.item("problem", number="1")]))
    h.write_page(slug, h.page(2, [h.item("continuation", number="1", statement_md="tail")]))
    code, out = h.check(slug, 2)
    assert code == 1
    assert "page 1 last item has continues_to_next=false" in out
    assert "run check on 1 then 2" in out


def test_open_page_followed_by_fresh_item_is_error(h):
    slug = h.make_run(n=2)
    h.check_ok(slug, h.page(1, [h.item("problem", number="1", continues_to_next=True)]))
    h.write_page(slug, h.page(2, [h.item("problem", number="2")]))
    code, out = h.check(slug, 2)
    assert code == 1 and "continues_to_next=true but this page does not start with a continuation" in out


def test_flag_placement_rules_within_a_page(h):
    slug = h.make_run(n=1)
    h.write_page(slug, h.page(1, [h.item("problem", number="1", continues_to_next=True), h.item("continuation", number="1", continues_from_previous=False, statement_md="x")]))
    code, out = h.check(slug, 1)
    assert code == 1
    assert "only allowed on the last item" in out
    assert "continuation items must have continues_from_previous=true" in out


def test_continuation_after_skipped_middle_page_becomes_orphan(h):
    slug = h.make_run(n=3)
    h.check_ok(slug, h.page(1, [h.item("problem", number="1", statement_md="Start", continues_to_next=True)]))
    code, out = h.run_cli(["skip", slug, "--page", 2, "--reason", "unreadable scan"])
    assert code == 0, out
    h.write_page(slug, h.page(3, [h.item("continuation", number="1", statement_md="Orphaned tail")]))
    code, out = h.check(slug, 3)
    assert code == 0, out  # only a warning: page 2 is not ok
    assert "warning" in out
    code, out = h.run_cli(["assemble", slug])
    assert code == 0, out
    index = (h.out_dir(slug) / "index.md").read_text(encoding="utf-8")
    section = index.split("## 고아 조각")[1].split("## 실패·건너뜀 페이지")[0]
    assert "p003 item[0] continuation 1: Orphaned tail" in section
    failed = index.split("## 실패·건너뜀 페이지")[1].split("## 그림 미추출")[0]
    assert "p002: skipped" in failed and "unreadable scan" in failed
    body = (h.out_dir(slug) / "problems" / "001-chnone-1.md").read_text(encoding="utf-8")
    assert "Orphaned tail" not in body and "pages: [1]" in body
