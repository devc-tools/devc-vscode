"""Glyph-hole check for resources/agent-icons.woff: the marks' counters must stay holes.

Points are in each SVG's 24x24 viewBox; they are mapped onto the glyph by matching the
glyph's bounds to the SVG path's bounds (fantasticon's --normalize scales each glyph to
the font height), so the check does not depend on the scale fantasticon chose.
"""

import sys

from fontTools.pens.pointInsidePen import PointInsidePen
from fontTools.ttLib import TTFont

# code point: (name, path bounds in the viewBox (xmin, ymin, xmax, ymax), inside, holes)
CHECKS = {
    0xE001: ("claudecode", (0, 5, 24, 20), [(12, 6.5)], [(6.744, 9.5), (17.255, 9.5)]),
    0xE003: ("pi", (1, 1, 23, 23), [(3.75, 12)], [(9.25, 9.25)]),
    0xE004: ("opencode", (4, 2, 20, 22), [(6, 12)], [(12, 12)]),
}
EXPECTED = {0xE001: "claudecode", 0xE002: "githubcopilot", 0xE003: "pi", 0xE004: "opencode"}


def main(path: str) -> int:
    font = TTFont(path)
    cmap = font.getBestCmap()
    glyphs = font.getGlyphSet()
    failures = []
    for cp, name in EXPECTED.items():
        if cp not in cmap:
            failures.append(f"U+{cp:04X} ({name}) missing from the font")
    for cp, (name, (sx0, sy0, sx1, sy1), inside, holes) in CHECKS.items():
        if cp not in cmap:
            continue
        glyph_name = cmap[cp]
        glyph = glyphs[glyph_name]
        from fontTools.pens.boundsPen import BoundsPen

        bp = BoundsPen(glyphs)
        glyph.draw(bp)
        gx0, gy0, gx1, gy1 = bp.bounds
        sx = (gx1 - gx0) / (sx1 - sx0)
        sy = (gy1 - gy0) / (sy1 - sy0)

        def to_font(x: float, y: float) -> tuple[float, float]:
            # SVG y grows down, font y grows up.
            return gx0 + (x - sx0) * sx, gy0 + (sy1 - y) * sy

        for points, want in ((inside, True), (holes, False)):
            for x, y in points:
                pen = PointInsidePen(glyphs, to_font(x, y))
                glyph.draw(pen)
                got = pen.getResult()
                status = "ok" if got == want else "FAIL"
                print(f"{status} U+{cp:04X} {name} ({x}, {y}) {'inside' if want else 'hole'}")
                if got != want:
                    failures.append(f"U+{cp:04X} {name} ({x}, {y}): expected {'inside' if want else 'a hole'}")
    for f in failures:
        print(f, file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
