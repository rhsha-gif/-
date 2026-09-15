"""LaTeX delimiter checks on Markdown strings."""


def errors_of(h, text):
    return h.pdf2md.check_latex(text)[0]


def warnings_of(h, text):
    return h.pdf2md.check_latex(text)[1]


def test_unbalanced_dollar_is_error_but_escaped_dollar_is_fine(h):
    assert any("unbalanced `$`" in e for e in errors_of(h, "Let $x = 1 be given."))
    assert errors_of(h, "Costs \\$5 and $x=1$.") == []


def test_braces_must_balance_ignoring_escaped_braces(h):
    assert any("braces" in e for e in errors_of(h, "$\\frac{1}{2$"))
    assert errors_of(h, "$\\{1, 2\\}$ and $\\{x\\}$") == []


def test_left_and_right_counts_must_match_but_leftarrow_does_not_count(h):
    assert any("\\left" in e for e in errors_of(h, "$\\left( x $"))
    assert errors_of(h, "$a \\leftarrow b$ and $\\left( y \\right)$") == []


def test_begin_end_environments_are_stack_matched(h):
    assert any("\\begin" in e for e in errors_of(h, "$$\n\\begin{aligned} x \\end{cases}\n$$"))
    assert errors_of(h, "$$\n\\begin{aligned} x &= 1 \\\\ y &= 2 \\end{aligned}\n$$") == []


def test_display_math_sharing_a_line_is_only_a_warning(h):
    errors, warnings = h.pdf2md.check_latex("Here $$x^2$$ inline")
    assert errors == []
    assert any("$$" in w for w in warnings)
    assert warnings_of(h, "Here\n$$\nx^2\n$$\n") == []


def test_blank_line_inside_inline_span_is_error(h):
    assert any("blank line" in e for e in errors_of(h, "$x +\n\ny$"))
    assert errors_of(h, "$$\nx\n\ny\n$$") == []


def test_fenced_code_blocks_are_ignored(h):
    assert errors_of(h, "```\n$ echo {\n```\nfine $x$") == []
