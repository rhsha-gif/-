"""Problem-bank rules: point labels, first-line display math, review list, error history."""


def test_parse_and_strip_points_labels(h):
    parse, strip = h.pdf2md.parse_points, h.pdf2md.strip_points_label
    for text, value in (("(10점)", 10), ("(10 점)", 10), ("[15 pts]", 15), ("(20 points)", 20), ("(10 pt)", 10), ("5점", 5), ("Let $x$ (2.5 pts)", 2.5), ("no label", None)):
        assert parse(text) == value, text
    assert strip("Compute $A^{-1}$. (10점)") == "Compute $A^{-1}$."
    assert strip("(15 points) Prove that $x = 1$.") == "Prove that $x = 1$."
    assert strip("Find $\\dim V$ [5 pts]:") == "Find $\\dim V$:"
    assert strip("The 5 points lie on a line.") == "The 5 points lie on a line.", "prose is left alone when it is not a label"


def test_first_line_display_math_is_an_error_for_problems(h):
    slug = h.make_run(n=1)
    h.write_page(slug, h.page(1, [h.item("problem", number="1", statement_md="$$A = 1$$\nCompute.")]))
    code, out = h.check(slug, 1)
    assert code == 1 and "first line contains `$$`" in out
    h.write_page(slug, h.page(1, [h.item("problem", number="1", statement_md="Compute $A$ where\n$$A = 1$$")]))
    assert h.check(slug, 1)[0] == 0


def test_review_list_names_retries_handwriting_and_low_confidence(h):
    slug = h.make_run(n=3)
    h.write_page(slug, h.page(1, [h.item("problem", number="1"), h.item("problem", number="4")]))
    assert h.check(slug, 1)[0] == 1
    assert h.check(slug, 1)[0] == 1
    h.check_ok(
        slug,
        h.page(1, [h.item("problem", number="1"), h.item("problem", number="2")]),
        h.page(2, [h.item("problem", number="3", confidence=0.7)], notes="손글씨 답안이 섞여 있음"),
        h.page(3, [h.item("problem", number="4", confidence=0.95)]),
    )
    code, out = h.run_cli(["assemble", slug])
    assert code == 0, out
    index = (h.out_dir(slug) / "index.md").read_text(encoding="utf-8")
    review = index.split("## 검토 권장")[1].split("## 해설에서 만든 문제")[0].strip().splitlines()
    assert review == [
        "- 1 [001-t.md](problems/001-t.md): 재시도 p001",
        "- 2 [002-t.md](problems/002-t.md): 재시도 p001",
        "- 3 [003-t.md](problems/003-t.md): 손글씨 p002; 신뢰도 0.70",
    ]
    summary = h.pdf2md.read_json_tolerant(h.out_dir(slug) / ".pdf2md.json")
    assert summary["review"]["003-t.md"] == ["손글씨 p002; 신뢰도 0.70".split("; ")[0], "신뢰도 0.70"]


def test_error_history_survives_a_later_ok_and_status_json_exposes_it(h):
    slug = h.make_run(n=1)
    h.write_page(slug, h.page(1, [h.item("problem", number="1", statement_md="Unbalanced $x")]))
    assert h.check(slug, 1)[0] == 1
    h.check_ok(slug, h.page(1, [h.item("problem", number="1")]))
    rec = h.state(slug)["pages"]["1"]
    assert rec["status"] == "ok" and rec["errors"] == []
    assert len(rec["history"]) == 1 and rec["history"][0]["attempt"] == 1
    assert "unbalanced `$`" in rec["history"][0]["errors"][0]
    code, out = h.run_cli(["status", slug, "--json"])
    assert code == 0 and '"history"' in out
