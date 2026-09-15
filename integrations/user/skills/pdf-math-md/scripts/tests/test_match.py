"""Solution-to-problem matching: positional sheet groups, restated-text similarity, merged runs."""


def problem_files(h, slug):
    return {p.name: p.read_text(encoding="utf-8") for p in (h.out_dir(slug) / "problems").iterdir()}


def test_bare_solutions_match_by_number_inside_the_positional_sheet(h):
    slug = h.make_run(n=4, spec="1-2:problems,3-4:solutions")
    h.check_ok(
        slug,
        h.page(1, [h.item("heading", chapter="2013 midterm"), h.item("problem", number="1"), h.item("problem", number="2")]),
        h.page(2, [h.item("heading", chapter="2013 final"), h.item("problem", number="1"), h.item("problem", number="2")]),
        h.page(3, [h.item("solution", number="1", solution_md="Midterm one."), h.item("solution", number="2", solution_md="Midterm two.")]),
        h.page(4, [h.item("solution", number="1", solution_md="Final one."), h.item("solution", number="2", solution_md="Final two.")]),
    )
    code, out = h.run_cli(["assemble", slug])
    assert code == 0, out
    files = problem_files(h, slug)
    assert set(files) == {"001-t.md", "002-t.md", "003-t.md", "004-t.md"}
    assert "> **Sol)** Midterm one." in files["001-t.md"] and "solution_pages: [3]" in files["001-t.md"]
    assert "> **Sol)** Midterm two." in files["002-t.md"]
    assert "> **Sol)** Final one." in files["003-t.md"] and "solution_pages: [4]" in files["003-t.md"]
    assert "> **Sol)** Final two." in files["004-t.md"]
    for body in files.values():
        assert "chapter:" not in body and "2013" not in body.split("---")[1], "exam identity is not exported"


def test_restated_solutions_match_by_text_similarity_not_position(h):
    slug = h.make_run(n=3, spec="1-2:problems,3:solutions")
    h.check_ok(
        slug,
        h.page(1, [h.item("heading", chapter="A"), h.item("problem", number="1", statement_md="Compute the determinant of the matrix $A$ below.")]),
        h.page(2, [h.item("heading", chapter="B"), h.item("problem", number="1", statement_md="Prove that every finite dimensional vector space has a basis.")]),
        h.page(3, [
            h.item("solution", number="1", statement_md="Prove that every finite dimensional vector space has a basis.", solution_md="Extend a spanning set."),
            h.item("solution", number="1", statement_md="Compute the determinant of the matrix $A$ below.", solution_md="It is $-2$."),
        ]),
    )
    code, out = h.run_cli(["assemble", slug])
    assert code == 0, out
    files = problem_files(h, slug)
    assert "> **Sol)** It is $-2$." in files["001-t.md"]
    assert "> **pf)** Extend a spanning set." in files["002-t.md"]
    assert set(files) == {"001-t.md", "002-t.md"}, "restated solutions that matched do not become extra notes"


def test_restated_solution_without_a_matching_problem_becomes_a_problem_note(h):
    slug = h.make_run(n=2, spec="1:problems,2:solutions")
    h.check_ok(
        slug,
        h.page(1, [h.item("problem", number="1", statement_md="Compute $x$.")]),
        h.page(2, [
            h.item("solution", number="1", solution_md="Plain answer."),
            h.item("solution", number="2", statement_md="Find the eigenvalues of $B$. (10점)", parts=[h.part("(a)", "for $B = I$", "all one")], solution_md="They are $1$ and $2$."),
        ]),
    )
    code, out = h.run_cli(["assemble", slug])
    assert code == 0, out
    files = problem_files(h, slug)
    assert set(files) == {"001-t.md", "002-t.md"}
    assert "> **Sol)** Plain answer." in files["001-t.md"]
    two = files["002-t.md"]
    assert "from_solution: true" in two and "has_solution: true" in two and "pages: [2]" in two
    assert "### 2. Find the eigenvalues of $B$." in two and "(10점)" not in two and "points: 10" in two
    assert "**(a)** for $B = I$" in two and "> **Sol)** They are $1$ and $2$.\n>\n> **(a)** all one" in two
    index = (h.out_dir(slug) / "index.md").read_text(encoding="utf-8")
    section = index.split("## 해설에서 만든 문제")[1].split("## 미매칭 해설")[0]
    assert "- 2 [002-t.md](problems/002-t.md): p002 해설 2" in section
    summary = h.pdf2md.read_json_tolerant(h.out_dir(slug) / ".pdf2md.json")
    assert summary["from_solution"] == ["002-t.md"] and summary["unmatched_solutions"] == []


def test_bare_solution_without_a_target_is_listed_as_unmatched(h):
    slug = h.make_run(n=2, spec="1:problems,2:solutions")
    h.check_ok(
        slug,
        h.page(1, [h.item("problem", number="1"), h.item("problem", number="2")]),
        h.page(2, [h.item("solution", number="5", solution_md="Nowhere.")]),
    )
    code, out = h.run_cli(["assemble", slug])
    assert code == 0, out
    index = (h.out_dir(slug) / "index.md").read_text(encoding="utf-8")
    section = index.split("## 미매칭 해설")[1].split("## 고아 조각")[0]
    assert "- p002 해설 5 (문제 재진술 없음)" in section
    for body in problem_files(h, slug).values():
        assert "has_solution: false" in body


def test_merged_solutions_from_other_run_are_referenced_as_other_pnnn(h):
    other = h.make_run(slug="sol", n=2, spec="1:front,2:solutions")
    h.check_ok(other, h.page(2, [h.item("solution", number="1", solution_md="From the other run.")]))
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
    body = problem_files(h, slug)["001-main.md"]
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
