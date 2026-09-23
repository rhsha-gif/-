"""index.md layout, problem frontmatter (points, importance) and Sol)/pf) selection."""


def build(h):
    slug = h.make_run(slug="idx", n=3, spec="1-2:problems,3:solutions")
    h.check_ok(
        slug,
        h.page(1, [
            h.item("heading", chapter="§2.1", statement_md="Exercises 2.1"),
            h.item("problem", number="1", statement_md="Prove that $1 + 1 = 2$. (10점)\nMore text.", confidence=0.95),
            h.item("problem", number="2", statement_md="Compute $\\int_0^1 x\\,dx$. [20 pts]", parts=[h.part("(a)", "for $n=1$ (5점)", "one half"), h.part("(b)", "for $n=2$ (15점)")], confidence=0.6),
            h.item("other", statement_md="Hint: use induction."),
        ]),
        h.page(2, [h.item("problem", number="3", statement_md="다음을 증명하라: $a^2 \\ge 0$.", points=10)]),
        h.page(3, [h.item("solution", number="1", solution_md="Trivial.\nQED."), h.item("solution", number="3", solution_md="제곱은 음이 아니다.")]),
    )
    code, out = h.run_cli(["assemble", slug])
    assert code == 0, out
    return slug


def test_index_has_banner_table_rows_and_all_sections(h):
    slug = build(h)
    index = (h.out_dir(slug) / "index.md").read_text(encoding="utf-8")
    lines = index.splitlines()
    assert lines[0] == "> 자동 생성 파일 — 직접 편집하지 말고 볼트로 옮긴 뒤 편집한다."
    assert "| # | 파일 | 페이지 | 원번호 | 배점 | 중요도 | 해설 | 신뢰도 |" in lines
    assert "| 1 | [001-idx.md](problems/001-idx.md) | p001 | 1 | 10 | 0.75 | 예 (p003) | 0.95 |" in lines
    assert "| 2 | [002-idx.md](problems/002-idx.md) | p001 | 2 | 20 | 1.50 | 예 (p001) | 0.60 |" in lines
    assert "| 3 | [003-idx.md](problems/003-idx.md) | p002 | 3 | 10 | 0.75 | 예 (p003) | 0.90 |" in lines
    for section in ("## 해설에서 만든 문제", "## 미매칭 해설", "## 고아 조각", "## 실패·건너뜀 페이지", "## 그림 미추출"):
        assert section in lines
        after = lines[lines.index(section) + 1]
        assert after == "없음"
    review = index.split("## 검토 권장")[1].split("## 해설에서 만든 문제")[0]
    assert "- 2 [002-idx.md](problems/002-idx.md): 신뢰도 0.60" in review


def test_problem_frontmatter_fields(h):
    slug = build(h)
    body = (h.out_dir(slug) / "problems" / "002-idx.md").read_text(encoding="utf-8")
    fm = body.split("---")[1].strip().splitlines()
    assert fm == [
        'source: "idx.pdf"',
        "pages: [1]",
        'source_number: "2"',
        "tags: [math, problem, idx]",
        "points: 20",
        "importance: 1.5",
        "has_solution: true",
        "solution_pages: [1]",
        "from_solution: false",
        "confidence: 0.6",
        'text_quality: "poor"',
        "instruction_lost: false",
    ]
    assert "### 2.\n\nCompute $\\int_0^1 x\\,dx$." in body and "[20 pts]" not in body
    assert "**(a)** for $n=1$\n" in body and "(5점)" not in body
    assert "> [!solution]- 해설\n> **Sol)**\n>\n> **(a)** one half" in body


def test_points_from_part_labels_and_importance_null_without_points(h):
    slug = h.make_run(slug="pts", n=1)
    h.check_ok(slug, h.page(1, [
        h.item("problem", number="1", statement_md="Split.", parts=[h.part("(a)", "one (5 points)"), h.part("(b)", "two (7 points)")]),
        h.item("problem", number="2", statement_md="No label here."),
        h.item("heading", chapter="Sheet two"),
        h.item("problem", number="1", statement_md="Unscored sheet."),
    ]))
    code, out = h.run_cli(["assemble", slug])
    assert code == 0, out
    files = {p.name: p.read_text(encoding="utf-8") for p in (h.out_dir(slug) / "problems").iterdir()}
    assert "points: 12\nimportance: 1.0\n" in files["001-pts.md"], "a single scored problem is the sheet average"
    assert "points: null\nimportance: null\n" in files["002-pts.md"]
    assert "points: null\nimportance: null\n" in files["003-pts.md"]


def test_proof_problems_use_pf_and_others_use_sol(h):
    slug = build(h)
    one = (h.out_dir(slug) / "problems" / "001-idx.md").read_text(encoding="utf-8")
    assert "### 1.\n\nProve that $1 + 1 = 2$." in one
    assert "> [!solution]- 해설\n> **pf)** Trivial.\n> QED." in one
    three = (h.out_dir(slug) / "problems" / "003-idx.md").read_text(encoding="utf-8")
    assert "> **pf)** 제곱은 음이 아니다." in three
    two = (h.out_dir(slug) / "problems" / "002-idx.md").read_text(encoding="utf-8")
    assert "**Sol)**" in two and "**pf)**" not in two
    p = h.pdf2md.is_proof
    assert p("(10점) Let $V$ be a vector space.\nShow that $\\ker T$ is a subspace.")
    assert p("Let $A$ be a matrix.", [{"statement_md": "Prove that $A^2 = A$."}])
    assert not p("Compute the inverse.", [{"statement_md": "for $n=2$"}])


def test_whole_file_lists_pages_headings_and_other_blocks(h):
    slug = build(h)
    whole = (h.out_dir(slug) / "idx.md").read_text(encoding="utf-8")
    assert whole.startswith("# idx\n\n<!-- page 001 -->\n## p.001\n\n## §2.1 Exercises 2.1\n")
    assert "### 1.\n\nProve that $1 + 1 = 2$." in whole, "the whole file keeps printed numbers"
    assert "More text." in whole
    assert "> Hint: use induction." in whole
    assert "<!-- page 003 -->\n## p.003\n\n### 1. (해설)\n\nTrivial.\nQED." in whole
    assert "![](img/" not in whole and "../img" not in whole
