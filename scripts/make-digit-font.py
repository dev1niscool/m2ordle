"""Build clearer pixel 2/5 glyphs and the matching logo 2. Requires fonttools[woff]."""
import re
from pathlib import Path
from tempfile import TemporaryDirectory

from fontTools.designspaceLib import AxisDescriptor, DesignSpaceDocument, SourceDescriptor
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.varLib import build
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "public" / "assets"
SOURCE = ASSETS / "pixelify-sans-latin.woff2"
OUTPUT = ASSETS / "m2ordle-pixel-digits.woff2"
FAMILY = "M2ordle Pixel Digits"
CHARACTERS = {0x32: "two", 0x35: "five"}

# Match the original widths and strokes: an open-sided 5 and a stepped 2 with
# a flat base. Identical point order lets each glyph's weight axis interpolate.
OUTLINES = {"five": {
    400: [(60, 631), (525, 631), (525, 530), (161, 530), (161, 359),
          (433, 359), (433, 270), (525, 270), (525, 78), (433, 78),
          (433, -12), (60, -12), (60, 88), (423, 88), (423, 260), (60, 260)],
    700: [(61, 638), (542, 638), (542, 501), (188, 501), (188, 381),
          (453, 381), (453, 297), (542, 297), (542, 74), (453, 74),
          (453, -11), (61, -11), (61, 125), (414, 125), (414, 246), (61, 246)],
}, "two": {
    400: [(60, 440), (60, 540), (151, 540), (151, 631), (433, 631),
          (433, 540), (525, 540), (525, 350), (433, 350), (433, 260),
          (342, 260), (342, 169), (251, 169), (251, 88), (525, 88),
          (525, -12), (60, -12), (60, 88), (151, 88), (151, 179),
          (241, 179), (241, 270), (332, 270), (332, 359), (423, 359),
          (423, 530), (161, 530), (161, 440)],
    700: [(61, 416), (61, 552), (149, 552), (149, 638), (453, 638),
          (453, 552), (542, 552), (542, 331), (453, 331), (453, 246),
          (365, 246), (365, 160), (276, 160), (276, 125), (542, 125),
          (542, -11), (61, -11), (61, 125), (149, 125), (149, 211),
          (237, 211), (237, 297), (326, 297), (326, 381), (414, 381),
          (414, 501), (188, 501), (188, 416)],
}}


def master(weight, path):
    original = instantiateVariableFont(TTFont(SOURCE), {"wght": weight}, inplace=True)
    fb = FontBuilder(original["head"].unitsPerEm, isTTF=True)
    fb.setupGlyphOrder([".notdef", *CHARACTERS.values()])
    fb.setupCharacterMap(CHARACTERS)
    glyphs = {".notdef": TTGlyphPen(None).glyph()}
    for name in CHARACTERS.values():
        pen = TTGlyphPen(None)
        pen.moveTo(OUTLINES[name][weight][0])
        for point in OUTLINES[name][weight][1:]:
            pen.lineTo(point)
        pen.closePath()
        glyphs[name] = pen.glyph()
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({".notdef": (500, 0), **{name: original["hmtx"][name] for name in CHARACTERS.values()}})
    fb.setupHorizontalHeader(**{key: getattr(original["hhea"], key) for key in ("ascent", "descent", "lineGap")})
    style = "Regular" if weight == 400 else "Bold"
    fb.setupNameTable({
        "familyName": FAMILY, "styleName": style, "fullName": f"{FAMILY} {style}",
        "psName": f"M2ordlePixelDigits-{style}", "uniqueFontIdentifier": f"M2ordlePixelDigits-1.0-{weight}",
        "version": "Version 1.000", "description": "Clearer pixel numerals 2 and 5 for M2ordle, matching Pixelify Sans metrics.",
        "copyright": "Copyright 2021 The Pixelify Sans Project Authors. Modified for M2ordle, 2026.",
        "licenseDescription": (ASSETS / "PixelifySans-OFL.txt").read_text(),
        "licenseInfoURL": "https://openfontlicense.org/",
    })
    fb.setupOS2(usWeightClass=weight, fsSelection=0x40 if weight == 400 else 0x20,
                **{key: getattr(original["OS/2"], key) for key in (
                    "sTypoAscender", "sTypoDescender", "sTypoLineGap", "usWinAscent", "usWinDescent", "sxHeight", "sCapHeight")})
    fb.setupHead(macStyle=0 if weight == 400 else 1, created=original["head"].created, modified=original["head"].modified)
    fb.setupPost()
    fb.save(path)


def main():
    with TemporaryDirectory(prefix="m2ordle-digits-") as directory:
        design = DesignSpaceDocument()
        axis = AxisDescriptor()
        axis.name, axis.tag = "Weight", "wght"
        axis.minimum, axis.default, axis.maximum = 400, 400, 700
        design.addAxis(axis)
        for weight in (400, 700):
            path = Path(directory) / f"{weight}.ttf"
            master(weight, path)
            source = SourceDescriptor()
            source.path, source.name, source.location = str(path), str(weight), {"Weight": weight}
            if weight == 400:
                source.copyInfo = source.copyLib = source.copyFeatures = True
            design.addSource(source)
        font, _, _ = build(design)
        font.flavor = "woff2"
        font.save(OUTPUT)
    # Keep the original font untouched and verify no other characters can change.
    result = TTFont(OUTPUT)
    assert result.getBestCmap() == CHARACTERS
    for weight in (400, 500, 600, 700):
        current = instantiateVariableFont(result, {"wght": weight}, inplace=False)
        original = instantiateVariableFont(TTFont(SOURCE), {"wght": weight}, inplace=True)
        for name in CHARACTERS.values():
            assert current["hmtx"][name] == original["hmtx"][name]
        prior_five = instantiateVariableFont(TTFont(ASSETS / "m2ordle-pixel-five.woff2"), {"wght": weight}, inplace=True)
        assert current["glyf"]["five"].coordinates == prior_five["glyf"]["five"].coordinates
    # Replace only the logo's numeral, preserving every other path and transform.
    logo = ASSETS / "m2ordle.svg"
    points = OUTLINES["two"][700]
    path = f"M{points[0][0]} {points[0][1]}" + "".join(f"L{x} {y}" for x, y in points[1:]) + "Z"
    updated, count = re.subn(r'(?<=transform="translate\(779 0\)" d=")[^"]+', path, logo.read_text())
    assert count == 1
    logo.write_text(updated)
    print(f"Built {OUTPUT.name} and the logo 2. Widths match at weights 400–700; the clearer 5 is unchanged.")


if __name__ == "__main__":
    main()
