"""Tests for post-processing: Unicode NFC, PUA/control cleaning, token normalization, quality assessment, and postprocess/audit CLI commands."""
from __future__ import annotations

import unicodedata


def test_clean_unicode_text(h):
    clean = h.pdf2md.clean_unicode_text
    # 1. NFC normalization
    nfd_hangul = unicodedata.normalize("NFD", "서울대학교 기출문제")
    assert nfd_hangul != "서울대학교 기출문제"
    assert clean(nfd_hangul) == "서울대학교 기출문제"

    # 2. Control characters removal (keep \t, \n, strip \x00, \x0b, \x0c, \ufffd)
    dirty_ctrl = "Hello\x00World\x0b!\x0c\tColumn\nLine 2\ufffd"
    assert clean(dirty_ctrl) == "HelloWorld!\tColumn\nLine 2"

    # 3. PUA characters removal
    pua_text = "Vector \ue001 space \uf8ff and basis"
    assert clean(pua_text) == pua_text
    assert clean(pua_text, legacy_ocr_fixes=True) == "Vector  space  and basis"

    # 4. Trailing spaces and multiple blank lines
    trailing = "Line 1   \nLine 2\t  \n\n\n\n\nLine 3"
    assert clean(trailing) == "Line 1\nLine 2\n\nLine 3"


def test_normalize_math_tokens(h):
    norm = h.pdf2md.normalize_math_tokens

    # 1. Subscripts
    assert norm(r"an, bn, cn, sn, rn+1, \sqrt{an}, \sqrt{bn+1}") == r"a_n, b_n, c_n, s_n, r_{n+1}, \sqrt{a_n}, \sqrt{b_{n+1}}"
    assert norm(r"a{n} + b{n}") == r"a_n + b_n"

    # 2. Alternating signs & powers
    assert norm("(-1)n+1 5n / n2(n + 1)2") == "(-1)^{n+1} 5^n / n^{2}(n + 1)^{2}"
    assert norm("(-1)n xn") == "(-1)^n x^n"

    # 3. Disambiguated power on parens
    assert norm("(2n + 1)3n / (2n)!") == "(2n + 1)3^n / (2n)!"
    assert norm(r"n(\log n)s") == r"n(\log n)^{s}"
    assert norm(r"(x + 1)n") == r"(x + 1)^n"

    # 4. Variable powers
    assert norm("x2 + x3 + xn + xn+1") == "x^{2} + x^{3} + x^n + x^{n+1}"

    # 5. Index powers & specials
    assert norm("n2n + nen + en + e-n + 3n+1 + 2012n + np + nn") == r"n\,2^n + n e^n + e^n + e^{-n} + 3^{n+1} + 2012^n + n^{p} + n^n"

    # 6. Preservations: 2n + 1 and (2n)! must not be turned into powers
    assert norm("2n + 1") == "2n + 1"
    assert norm("(2n)!") == "(2n)!"

    # 7. Trig functions with 1/n
    assert norm(r"\sin 1/n + \cos 1/n + \arctan 1/n") == r"\sin\frac{1}{n} + \cos\frac{1}{n} + \arctan\frac{1}{n}"

    # 8. Curve notation
    assert norm(r"곡선 \sum(t) = (t, t2, t3)") == r"곡선 X(t) = (t, t^{2}, t^{3})"


def test_audit_math_syntax(h):
    audit = h.pdf2md.audit_math_syntax

    # Clean math
    assert audit(r"Let $x \in \mathbb{R}$ and $$y = x^2$$.") == []

    # Unclosed $
    errs = audit(r"Let $x \in \mathbb{R} and y = 1.")
    assert any("미닫힘 수식 구분자($)" in e for e in errs)

    # Broken display math
    errs = audit(r"$$\sum_{n=1}^\infty a_n")
    assert any("미닫힘 디스플레이 수식 구분자($$)" in e for e in errs)

    # Broken token _{$$}
    errs = audit(r"_{$$}^\infty a_n")
    assert any("손상된 수식 토큰" in e for e in errs)

    # Operator linebreak
    errs = audit("\\sum\n_{n=1}^\\infty a_n")
    assert any("줄바꿈 분절" in e for e in errs)

    # Dangling operator
    errs = audit(r"Compute $1 + 2 +$")
    assert any("비정상 종결" in e for e in errs)


def test_assess_record_quality(h):
    assess = h.pdf2md.assess_record_quality

    # Good problem
    good_rec = {
        "kind": "problem",
        "statement_md": "다음 행렬 $A$의 역행렬을 구하시오: $$A = \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}$$",
        "solution_md": "",
        "parts": [],
        "confidence": 0.95,
        "pages": [1],
    }
    tq, inst_lost, notes = assess(good_rec)
    assert tq == "good" and inst_lost is False and notes == []

    # Low confidence -> poor
    poor_rec = dict(good_rec, confidence=0.7)
    tq, inst_lost, notes = assess(poor_rec)
    assert tq == "poor" and any("낮은 신뢰도" in n for n in notes)

    # Handwriting -> poor
    tq, inst_lost, notes = assess(good_rec, notes_by_page={1: "손글씨 답안지"})
    assert tq == "poor" and any("손글씨" in n for n in notes)

    # Lost instruction / empty body -> broken
    broken_rec = dict(good_rec, statement_md="")
    tq, inst_lost, notes = assess(broken_rec)
    assert tq == "broken" and inst_lost is True


def test_postprocess_file_content(h):
    post = h.pdf2md.postprocess_file_content

    # Header trapped file with PUA and unnormalized tokens
    raw = """---
source: "test.pdf"
pages: [1]
source_number: "1"
tags: [math, problem, test]
points: 10
importance: 1.0
has_solution: false
solution_pages: []
from_solution: false
confidence: 0.95
---
### 1. Let an be a sequence with \ue001 and (-1)n+1 5n.
Compute the limit.
"""
    cleaned, info = post(raw, legacy_ocr_fixes=True)
    assert "### 1.\n\nLet a_n be a sequence with  and (-1)^{n+1} 5^n." in cleaned
    assert "text_quality: \"good\"" in cleaned
    assert "instruction_lost: false" in cleaned
    assert info["text_quality"] == "good"
    assert info["instruction_lost"] is False


def test_cli_postprocess_and_audit(h):
    slug = h.make_run(slug="pp", n=2, spec="1-2:problems")
    h.check_ok(
        slug,
        h.page(1, [h.item("problem", number="1", statement_md="다음을 계산하시오: $x2 + x3$.")]),
        h.page(2, [h.item("problem", number="2", statement_md="급수 $\\sum_{n=1}^\\infty an$의 수렴성을 판정하라.")]),
    )
    # Assemble
    code, out = h.run_cli(["assemble", slug, "--legacy-ocr-fixes"])
    assert code == 0, out
    assert "text quality: good=2" in out

    # Check index.md has text quality section
    index = (h.out_dir(slug) / "index.md").read_text(encoding="utf-8")
    assert "## 텍스트 품질 요약" in index
    assert "- 양호(good): 2개, 미흡(poor): 0개, 결손(broken): 0개" in index

    # Audit command passes
    code, out = h.run_cli(["audit", slug])
    assert code == 0, out
    assert "Text Quality: good=2, poor=0, broken=0" in out
    assert "PUA Characters: 0" in out

    # Introduce a header trap and PUA defect directly on disk
    prob1 = h.out_dir(slug) / "problems" / "001-pp.md"
    prob1_text = prob1.read_text(encoding="utf-8")
    corrupted = prob1_text.replace("### 1.\n\n", "### 1. Header Trapped \ue005 ")
    prob1.write_text(corrupted, encoding="utf-8")

    # Audit command now detects defects and returns exit code 1
    code, out = h.run_cli(["audit", slug])
    assert code == 1
    assert "PUA Characters: 1" in out
    assert "Header-trapped Problems: 1" in out

    # Postprocess command cleans it up
    code, out = h.run_cli(["postprocess", slug, "--legacy-ocr-fixes"])
    assert code == 0, out

    # Audit command passes again
    code, out = h.run_cli(["audit", slug])
    assert code == 0, out
    assert "PUA Characters: 0" in out
    assert "Header-trapped Problems: 0" in out
