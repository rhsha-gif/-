"""Schema validator: valid page, error paths, BOM/CRLF tolerance."""
import json


def test_valid_page_passes_validator(h):
    data = h.page(1, [h.item("problem", number="1", parts=[h.part("(a)", "x")], figures=[h.figure([0.1, 0.1, 0.5, 0.5])])])
    assert h.pdf2md.validate_schema(data, h.pdf2md.load_schema()) == []


def test_missing_required_and_bad_enum_are_reported_with_paths(h):
    bad = h.item("bogus", number="1")
    del bad["confidence"]
    errors = h.pdf2md.validate_schema(h.page(1, [bad]), h.pdf2md.load_schema())
    assert any(e.startswith("items[0].kind: must be one of") for e in errors)
    assert "items[0].confidence: required property missing" in errors


def test_number_pattern_error_names_item_path(h):
    data = h.page(1, [h.item("problem", number="1"), h.item("problem", number="1a2")])
    errors = h.pdf2md.validate_schema(data, h.pdf2md.load_schema())
    assert len(errors) == 1 and errors[0].startswith("items[1].number: does not match pattern")


def test_additional_property_and_bbox_range_rejected(h):
    it = h.item("problem", number="1", figures=[h.figure([0.0, 0.2, 1.5, 0.9])])
    it["extra"] = True
    errors = h.pdf2md.validate_schema(h.page(1, [it]), h.pdf2md.load_schema())
    assert "items[0].extra: additional property not allowed" in errors
    assert "items[0].figures[0].bbox_norm[2]: must be <= 1" in errors


def test_type_lists_const_and_string_lengths(h):
    data = h.page(1, [h.item("problem", number="1", chapter="x" * 81, figures=[h.figure([0.1, 0.1, 0.5, 0.5], caption="")])])
    data["schema_version"] = 2
    errors = h.pdf2md.validate_schema(data, h.pdf2md.load_schema())
    assert "schema_version: must be 1" in errors
    assert any(e.startswith("items[0].chapter: must not be longer than 80") for e in errors)
    assert any(e.startswith("items[0].figures[0].caption: must not be shorter than 1") for e in errors)
    assert h.pdf2md.validate_schema(h.page(1, [h.item("problem", number="1", chapter=None)]), h.pdf2md.load_schema()) == []


def test_check_accepts_utf8_bom_and_crlf(h):
    slug = h.make_run(n=1)
    data = h.page(1, [h.item("problem", number="1", statement_md="한글 $x^2$")])
    text = json.dumps(data, ensure_ascii=False, indent=2).replace("\n", "\r\n")
    h.pdf2md.page_json(slug, 1).write_bytes(b"\xef\xbb\xbf" + text.encode("utf-8"))
    code, out = h.check(slug, 1)
    assert code == 0, out
    assert h.state(slug)["pages"]["1"]["status"] == "ok"


def test_check_records_schema_failure_with_prefixed_errors(h):
    slug = h.make_run(n=1)
    bad = h.page(1, [h.item("problem", number="1")])
    del bad["items"][0]["parts"]
    h.write_page(slug, bad)
    code, out = h.check(slug, 1)
    assert code == 1
    rec = h.state(slug)["pages"]["1"]
    assert rec["status"] == "failed" and rec["attempts"] == 1
    assert rec["errors"] == ["P001/items[0].parts: required property missing"]
    assert "P001/items[0].parts" in out
