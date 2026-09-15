"""Figure cropping from the real fixture PDF (pypdfium2 + Pillow)."""
from PIL import Image

W, H = 595, 842  # fixture page size at 72 dpi


def prepare_fixture(h, slug="fx"):
    code, out = h.run_cli(["prepare", h.FIXTURE_PDF, "--slug", slug, "--dpi", 72])
    assert code == 0, out
    assert h.run_cli(["set-ranges", slug, "--spec", "1-2:problems"])[0] == 0
    assert h.run_cli(["confirm-ranges", slug])[0] == 0
    return slug


def test_crop_naming_padding_and_content_from_fixture_rectangle(h):
    slug = prepare_fixture(h)
    h.check_ok(slug, h.page(1, [h.item("problem", number="1", figures=[h.figure([0.25, 0.25, 0.5, 0.5], caption="사각형")])]))
    code, out = h.run_cli(["assemble", slug])
    assert code == 0, out
    img = h.out_dir(slug) / "img" / "p001-1.png"
    assert img.is_file()
    with Image.open(img) as im:
        w, hgt = im.size
        assert abs(w - (0.25 + 0.03) * W) <= 2 and abs(hgt - (0.25 + 0.03) * H) <= 2
        assert im.getpixel((w // 2, hgt // 2)) == (0, 0, 0)
        assert im.getpixel((2, 2)) == (255, 255, 255), "padding ring stays white"
    body = (h.out_dir(slug) / "problems" / "001-chnone-1.md").read_text(encoding="utf-8")
    assert "![](../img/p001-1.png)\n*사각형*" in body


def test_degenerate_bbox_yields_no_file_but_warning_callout_and_index_row(h):
    slug = prepare_fixture(h)
    h.write_page(slug, h.page(1, [h.item("problem", number="1", figures=[h.figure([0.25, 0.25, 0.5, 0.5]), h.figure([0.1, 0.1, 0.11, 0.5], caption="얇은")])]))
    code, out = h.check(slug, 1)
    assert code == 0 and "degenerate bbox" in out
    code, out = h.run_cli(["assemble", slug])
    assert code == 0, out
    assert (h.out_dir(slug) / "img" / "p001-1.png").is_file()
    assert not (h.out_dir(slug) / "img" / "p001-2.png").exists()
    body = (h.out_dir(slug) / "problems" / "001-chnone-1.md").read_text(encoding="utf-8")
    assert "> [!warning] 그림 추출 실패 (bbox 0.100, 0.100, 0.110, 0.500)\n> 얇은\n> 설명 문단" in body
    index = (h.out_dir(slug) / "index.md").read_text(encoding="utf-8")
    assert "- p001 그림 2 (문제 1): bbox 0.100, 0.100, 0.110, 0.500" in index.split("## 그림 미추출")[1]


def test_padding_is_clamped_to_the_page_edge(h):
    slug = prepare_fixture(h)
    h.check_ok(slug, h.page(2, [h.item("problem", number="1", figures=[h.figure([0.9, 0.9, 1.0, 1.0])])]))
    code, out = h.run_cli(["assemble", slug])
    assert code == 0, out
    with Image.open(h.out_dir(slug) / "img" / "p002-1.png") as im:
        w, hgt = im.size
    assert w == W - round(0.885 * W) and hgt == H - round(0.885 * H)
