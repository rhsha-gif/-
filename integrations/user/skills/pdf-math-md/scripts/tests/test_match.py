"""Solution-to-problem matching, chapter normalization, merged runs."""


def problem_files(h, slug):
    return {p.name: p.read_text(encoding="utf-8") for p in (h.out_dir(slug) / "problems").iterdir()}


def test_solutions_match_by_normalized_chapter_and_number(h):
    slug = h.make_run(n=2, spec="1:problems,2:solutions")
    h.check_ok(
        slug,
        h.page(1, [h.item("heading", chapter="§3.2"), h.item("problem", number="1"), h.item("problem", number="2")]),
        h.page(2, [h.item("solution", chapter="Chapter 3.2", number="1", solution_md="Because."), h.item("solution", chapter="연습문제 3.2", number="2", solution_md="Hence.")]),
    )
    code, out = h.run_cli(["assemble", slug])
    assert code == 0, out
    files = problem_files(h, slug)
    assert set(files) == {"001-ch3-2-1.md", "002-ch3-2-2.md"}
    assert "> [!solution]- 해설\n> **Sol)** Because." in files["001-ch3-2-1.md"]
    assert "has_solution: true" in files["002-ch3-2-2.md"] and "solution_pages: [2]" in files["002-ch3-2-2.md"]
    index = (h.out_dir(slug) / "index.md").read_text(encoding="utf-8")
    assert "| 1 | §3.2 | 1 | [001-ch3-2-1.md](problems/001-ch3-2-1.md) | p001 | 예 (p002) | 0.90 |" in index


def test_unique_number_fallback_when_solution_chapter_is_null(h):
    slug = h.make_run(n=2, spec="1:problems,2:solutions")
    h.check_ok(
        slug,
        h.page(1, [h.item("heading", chapter="Chapter 4"), h.item("problem", number="7")]),
        h.page(2, [h.item("heading", chapter="Solutions"), h.item("solution", number="7", solution_md="Fallback match.")]),
    )
    code, out = h.run_cli(["assemble", slug])
    assert code == 0, out
    body = problem_files(h, slug)["001-ch4-7.md"]
    assert "Fallback match." in body


def test_ambiguous_or_mismatched_solutions_are_listed_as_unmatched(h):
    slug = h.make_run(n=3, spec="1-2:problems,3:solutions")
    h.check_ok(
        slug,
        h.page(1, [h.item("heading", chapter="§1"), h.item("problem", number="1")]),
        h.page(2, [h.item("heading", chapter="§2"), h.item("problem", number="1")]),
        h.page(3, [h.item("heading", chapter="Answers"), h.item("solution", number="1", solution_md="Which one?"), h.item("solution", chapter="§9", number="1", solution_md="Nowhere.")]),
    )
    code, out = h.run_cli(["assemble", slug])
    assert code == 0, out
    index = (h.out_dir(slug) / "index.md").read_text(encoding="utf-8")
    section = index.split("## 미매칭 해설")[1].split("## 고아 조각")[0]
    assert "p003 해설 1 (장 Answers)" in section
    assert "p003 해설 1 (장 §9)" in section
    for body in problem_files(h, slug).values():
        assert "has_solution: false" in body


def test_merged_solutions_from_other_run_are_referenced_as_other_pnnn(h):
    other = h.make_run(slug="sol", n=2, spec="1:front,2:solutions")
    h.check_ok(other, h.page(2, [h.item("solution", chapter="§1", number="1", solution_md="From the other run.")]))
    slug = h.make_run(slug="main", n=1)
    h.check_ok(slug, h.page(1, [h.item("heading", chapter="§1"), h.item("problem", number="1")]))
    code, out = h.run_cli(["merge-solutions", slug, "--from", "sol"])
    assert code == 0 and "merged 1 solution pages" in out, out
    code, out = h.run_cli(["merge-solutions", slug, "--from", "sol"])
    assert code == 0
    assert (h.pdf2md.merged_dir(slug, "sol") / "002.json").is_file()
    assert h.state(slug)["merged"] == [{"slug": "sol", "pdf_sha256": h.state(other)["pdf_sha256"], "pages": [2]}]
    code, out = h.run_cli(["assemble", slug])
    assert code == 0, out
    body = problem_files(h, slug)["001-ch1-1.md"]
    assert 'solution_pages: ["sol:p002"]' in body
    assert "From the other run." in body
    index = (h.out_dir(slug) / "index.md").read_text(encoding="utf-8")
    assert "예 (sol:p002)" in index


def test_merge_refuses_unknown_or_unconfirmed_runs(h):
    slug = h.make_run(slug="main", n=1)
    code, out = h.run_cli(["merge-solutions", slug, "--from", "ghost"])
    assert code == 2 and "unknown run" in out
    h.make_run(slug="sol", n=1, confirm=False)
    code, out = h.run_cli(["merge-solutions", slug, "--from", "sol"])
    assert code == 2 and "unconfirmed" in out
