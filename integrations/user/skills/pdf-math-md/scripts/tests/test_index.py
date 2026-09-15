"""index.md layout, problem frontmatter and Sol)/pf) selection."""


def build(h):
    slug = h.make_run(slug="idx", n=3, spec="1-2:problems,3:solutions")
    h.check_ok(
        slug,
        h.page(1, [
            h.item("heading", chapter="§2.1", statement_md="Exercises 2.1"),
            h.item("problem", number="1", statement_md="Prove that $1 + 1 = 2$.\nMore text.", confidence=0.95),
            h.item("problem", number="2", statement_md="Compute $\\int_0^1 x\\,dx$.", parts=[h.part("(a)", "for $n=1$", "one half"), h.part("(b)", "for $n=2$")], confidence=0.6),
            h.item("other", statement_md="Hint: use induction."),
        ]),
        h.page(2, [h.item("problem", number="3", statement_md="다음을 증명하라: $a^2 \\ge 0$.")]),
        h.page(3, [h.item("solution", chapter="§2.1", number="1", solution_md="Trivial.\nQED."), h.item("solution", chapter="§2.1", number="3", solution_md="제곱은 음이 아니다.")]),
    )
    code, out = h.run_cli(["assemble", slug])
    assert code == 0, out
    return slug


def test_index_has_banner_table_rows_and_all_sections(h):
    slug = build(h)
    index = (h.out_dir(slug) / "index.md").read_text(encoding="utf-8")
    lines = index.splitlines()
    assert lines[0] == "> 자동 생성 파일 — 직접 편집하지 말고 볼트로 옮긴 뒤 편집한다."
    assert "| # | 장 | 번호 | 파일 | 페이지 | 해설 | 신뢰도 |" in lines
    assert "| 1 | §2.1 | 1 | [001-ch2-1-1.md](problems/001-ch2-1-1.md) | p001 | 예 (p003) | 0.95 |" in lines
    assert "| 2 | §2.1 | 2 | [002-ch2-1-2.md](problems/002-ch2-1-2.md) | p001 | 예 (p001) | 0.60 |" in lines
    assert "| 3 | §2.1 | 3 | [003-ch2-1-3.md](problems/003-ch2-1-3.md) | p002 | 예 (p003) | 0.90 |" in lines
    for section in ("## 미매칭 해설", "## 고아 조각", "## 실패·건너뜀 페이지", "## 그림 미추출"):
        assert section in lines
        after = lines[lines.index(section) + 1]
        assert after == "없음"


def test_problem_frontmatter_fields(h):
    slug = build(h)
    body = (h.out_dir(slug) / "problems" / "002-ch2-1-2.md").read_text(encoding="utf-8")
    fm = body.split("---")[1].strip().splitlines()
    assert fm == [
        'source: "idx.pdf"',
        "pages: [1]",
        'number: "2"',
        'chapter: "§2.1"',
        "tags: [math, problem, idx]",
        "has_solution: true",
        "solution_pages: [1]",
        "confidence: 0.6",
    ]
    assert "### 2. Compute $\\int_0^1 x\\,dx$." in body
    assert "**(a)** for $n=1$" in body
    assert "> [!solution]- 해설\n> **Sol)**\n>\n> **(a)** one half" in body


def test_proof_problems_use_pf_and_others_use_sol(h):
    slug = build(h)
    one = (h.out_dir(slug) / "problems" / "001-ch2-1-1.md").read_text(encoding="utf-8")
    assert "### 1. Prove that $1 + 1 = 2$." in one
    assert "> [!solution]- 해설\n> **pf)** Trivial.\n> QED." in one
    three = (h.out_dir(slug) / "problems" / "003-ch2-1-3.md").read_text(encoding="utf-8")
    assert "> **pf)** 제곱은 음이 아니다." in three
    two = (h.out_dir(slug) / "problems" / "002-ch2-1-2.md").read_text(encoding="utf-8")
    assert "**Sol)**" in two and "**pf)**" not in two


def test_whole_file_lists_pages_headings_and_other_blocks(h):
    slug = build(h)
    whole = (h.out_dir(slug) / "idx.md").read_text(encoding="utf-8")
    assert whole.startswith("# idx\n\n<!-- page 001 -->\n## p.001\n\n## §2.1 Exercises 2.1\n")
    assert "> Hint: use induction." in whole
    assert "<!-- page 003 -->\n## p.003\n\n### 1. (해설)\n\nTrivial.\nQED." in whole
    assert "![](img/" not in whole and "../img" not in whole
