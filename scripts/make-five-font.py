"""Build the single-character pixel 5 override. Requires fonttools[woff]."""
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
OUTPUT = ASSETS / "m2ordle-pixel-five.woff2"
FAMILY = "M2ordle Pixel Five"

# Matching stroke widths and metrics, with a flat top and open upper-right /
# lower-left spaces. Identical point order lets the weight axis interpolate.
OUTLINES = {
    400: [(60, 631), (525, 631), (525, 530), (161, 530), (161, 359),
          (433, 359), (433, 270), (525, 270), (525, 78), (433, 78),
          (433, -12), (60, -12), (60, 88), (423, 88), (423, 260), (60, 260)],
    700: [(61, 638), (542, 638), (542, 501), (188, 501), (188, 381),
          (453, 381), (453, 297), (542, 297), (542, 74), (453, 74),
          (453, -11), (61, -11), (61, 125), (414, 125), (414, 246), (61, 246)],
}


def master(weight, path):
    original = instantiateVariableFont(TTFont(SOURCE), {"wght": weight}, inplace=True)
    fb = FontBuilder(original["head"].unitsPerEm, isTTF=True)
    fb.setupGlyphOrder([".notdef", "five"])
    fb.setupCharacterMap({0x35: "five"})
    pen = TTGlyphPen(None)
    pen.moveTo(OUTLINES[weight][0])
    for point in OUTLINES[weight][1:]:
        pen.lineTo(point)
    pen.closePath()
    fb.setupGlyf({".notdef": TTGlyphPen(None).glyph(), "five": pen.glyph()})
    fb.setupHorizontalMetrics({".notdef": (500, 0), "five": original["hmtx"]["five"]})
    fb.setupHorizontalHeader(**{key: getattr(original["hhea"], key) for key in ("ascent", "descent", "lineGap")})
    style = "Regular" if weight == 400 else "Bold"
    fb.setupNameTable({
        "familyName": FAMILY, "styleName": style, "fullName": f"{FAMILY} {style}",
        "psName": f"M2ordlePixelFive-{style}", "uniqueFontIdentifier": f"M2ordlePixelFive-1.0-{weight}",
        "version": "Version 1.000", "description": "A clearer pixel numeral 5 for M2ordle, matching Pixelify Sans metrics.",
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
    with TemporaryDirectory(prefix="m2ordle-five-") as directory:
        design = DesignSpaceDocument()
        axis = AxisDescriptor()
        axis.name, axis.tag = "Weight", "wght"
        axis.minimum, axis.default, axis.maximum = 400, 400, 700
        design.addAxis(axis)
        for weight in OUTLINES:
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
    assert result.getBestCmap() == {0x35: "five"}
    for weight in (400, 500, 600, 700):
        current = instantiateVariableFont(result, {"wght": weight}, inplace=False)
        original = instantiateVariableFont(TTFont(SOURCE), {"wght": weight}, inplace=True)
        assert current["hmtx"]["five"] == original["hmtx"]["five"]
    print(f"Built {OUTPUT.name}: numeral 5 only; widths match at weights 400–700.")


if __name__ == "__main__":
    main()
