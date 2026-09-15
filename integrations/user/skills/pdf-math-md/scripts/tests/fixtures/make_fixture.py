#!/usr/bin/env python3
"""Generate ``fixture-2p.pdf`` with the standard library only.

Page 1: A4 (595 x 842 pt) with a filled black rectangle covering x 25-50 %
and y 25-50 % of the page (measured from the top-left corner, as bbox_norm
does).  Page 2: blank A4.  Run once and check the output in:

    python make_fixture.py            # writes fixture-2p.pdf next to this file
"""
from __future__ import annotations

from pathlib import Path

WIDTH, HEIGHT = 595, 842


def _rect_content() -> bytes:
    x0 = WIDTH * 0.25
    w = WIDTH * 0.25
    # PDF y axis points up: top-left origin y 25-50 % -> bottom 50 %, height 25 %.
    y0 = HEIGHT * 0.50
    h = HEIGHT * 0.25
    return f"0 g {x0:.2f} {y0:.2f} {w:.2f} {h:.2f} re f\n".encode("ascii")


def build_pdf() -> bytes:
    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    content1 = _rect_content()
    content2 = b""
    catalog = add(b"<< /Type /Catalog /Pages 2 0 R >>")
    pages = add(b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>")
    media = f"/MediaBox [0 0 {WIDTH} {HEIGHT}]".encode("ascii")
    add(b"<< /Type /Page /Parent 2 0 R " + media + b" /Contents 5 0 R >>")
    add(b"<< /Type /Page /Parent 2 0 R " + media + b" /Contents 6 0 R >>")
    add(b"<< /Length " + str(len(content1)).encode() + b" >>\nstream\n" + content1 + b"endstream")
    add(b"<< /Length " + str(len(content2)).encode() + b" >>\nstream\n" + content2 + b"endstream")
    assert catalog == 1 and pages == 2

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode("ascii") + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("ascii")
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode("ascii")
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii")
    return bytes(out)


def main() -> None:
    target = Path(__file__).resolve().parent / "fixture-2p.pdf"
    target.write_bytes(build_pdf())
    print(f"wrote {target} ({target.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
