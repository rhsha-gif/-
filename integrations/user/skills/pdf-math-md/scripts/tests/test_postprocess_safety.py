import json
import pdf2md


def test_default_preserves_ambiguous_math_and_pua():
    original = r"3n+1, \sum(t), x2" + "\ue000"
    result, info = pdf2md.postprocess_file_content(original)
    assert result == original
    assert info["legacy_changes"] == []
    assert any("PUA" in issue for issue in info["syntax_issues"])
    assert any("OCR" in issue for issue in info["syntax_issues"])


def test_explicit_legacy_fix_has_before_after_evidence():
    original = r"3n+1, \sum(t)" + "\ue000"
    result, info = pdf2md.postprocess_file_content(original, legacy_ocr_fixes=True)
    assert "3^{n+1}" in result and "X(t)" in result and "\ue000" not in result
    assert info["legacy_changes"][0]["before"] == original
    assert info["legacy_changes"][0]["after"] == result
    pdf2md.write_legacy_changes("sample", info["legacy_changes"])
    rows = (pdf2md.run_dir("sample") / "legacy-ocr-fixes.jsonl").read_text(encoding="utf-8").splitlines()
    assert json.loads(rows[0])["before"] == original


def test_default_still_separates_heading_and_records_quality():
    result, info = pdf2md.postprocess_file_content('---\nsource: example\n---\n### 001. Find the value of the following expression.\n')
    assert '### 001.\n\nFind the value' in result
    assert 'text_quality:' in result and 'instruction_lost:' in result
    assert info['legacy_changes'] == []


def test_legacy_flag_is_explicit_and_not_persisted_by_parser():
    parser = pdf2md.build_parser()
    for command in ('assemble', 'postprocess'):
        assert parser.parse_args([command, 'sample']).legacy_ocr_fixes is False
        assert parser.parse_args([command, 'sample', '--legacy-ocr-fixes']).legacy_ocr_fixes is True
