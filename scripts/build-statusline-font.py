#!/usr/bin/env python3
"""Build the two original geometric glyphs used by the context meter.

Requires: python -m pip install fonttools==4.60.1 brotli==1.1.0
Run from any directory: python scripts/build-statusline-font.py

Only BLACK SQUARE (U+25A0) and SET MINUS (U+2216) are mapped. Their
identical vertical bounds and advances keep the solid and striped parts
aligned without changing the terminal's ASCII glyphs or font settings.
No outlines or other data from third-party fonts are used.
"""

import argparse
import os
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen


UNITS_PER_EM = 1000
ADVANCE = 600
BOTTOM = 90
TOP = 600
LEFT = 45
RIGHT = 555
GLYPH_ORDER = [".notdef", "square", "stripe"]


def polygon(points):
    pen = TTGlyphPen(None)
    if points:
        pen.moveTo(points[0])
        for point in points[1:]:
            pen.lineTo(point)
        pen.closePath()
    return pen.glyph()


def build(output):
    builder = FontBuilder(UNITS_PER_EM, isTTF=True)
    builder.setupGlyphOrder(GLYPH_ORDER)
    builder.setupCharacterMap({0x25A0: "square", 0x2216: "stripe"})
    builder.setupGlyf({
        ".notdef": polygon([]),
        "square": polygon([
            (LEFT, BOTTOM), (LEFT, TOP), (RIGHT, TOP), (RIGHT, BOTTOM),
        ]),
        "stripe": polygon([
            (LEFT, TOP), (LEFT + 100, TOP),
            (RIGHT, BOTTOM), (RIGHT - 100, BOTTOM),
        ]),
    })
    builder.setupHorizontalMetrics({name: (ADVANCE, 0 if name == ".notdef" else LEFT) for name in GLYPH_ORDER})
    # Match the nominal line metrics of the default 1000-unit terminal font.
    # The two short glyphs stay inside this box even at a line height of 1.
    builder.setupHorizontalHeader(ascent=1020, descent=-300, lineGap=0)
    builder.setupOS2(
        version=4,
        sTypoAscender=1020, sTypoDescender=-300, sTypoLineGap=0,
        usWinAscent=1020, usWinDescent=300,
        sxHeight=550, sCapHeight=730, xAvgCharWidth=ADVANCE,
        usWeightClass=400, usWidthClass=5, fsSelection=0xC0,
        fsType=0,
    )
    builder.setupNameTable({
        "familyName": "TDC Statusline",
        "styleName": "Regular",
        "uniqueFontIdentifier": "TDC Statusline Regular 1.0",
        "fullName": "TDC Statusline Regular",
        "psName": "TDCStatusline-Regular",
        "version": "Version 1.0",
        "description": "Two original geometric context-meter glyphs with matching bounds.",
    })
    builder.setupPost(isFixedPitch=1)
    builder.setupMaxp()
    font = builder.font
    font.recalcTimestamp = False
    # A fixed default makes rebuilds reproducible; SOURCE_DATE_EPOCH is supported.
    timestamp = int(os.environ.get("SOURCE_DATE_EPOCH", "1767225600")) + 2082844800
    font["head"].created = font["head"].modified = timestamp
    font.flavor = "woff2"
    output.parent.mkdir(parents=True, exist_ok=True)
    font.save(output)
    print(f"Built {output} ({output.stat().st_size} bytes)")
    print(f"U+25A0 and U+2216: advance {ADVANCE}/{UNITS_PER_EM} em; y {BOTTOM}..{TOP}; height {TOP - BOTTOM}/{UNITS_PER_EM} em")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "src/assets/fonts/tdc-statusline.woff2")
    build(parser.parse_args().output.resolve())
