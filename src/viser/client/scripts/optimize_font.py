"""Generate the optimized Inter font shipped in the client bundle.

The client inlines the font into the single-file production build, so its size
matters: the original ``Inter-VariableFont_slnt,wght.ttf`` (~785 KiB) is the
single largest asset in the bundle. This script produces
``../src/assets/InterVariable-optimized.ttf`` (~430 KiB) from it by:

- Pinning the ``slnt`` (slant) axis to 0. Italic text falls back to
  browser-synthesized oblique, which is visually near-identical for Inter.
- Restricting the ``wght`` axis to 400-700. The UI only uses regular through
  bold; CSS clamps out-of-range weights to the nearest supported one.
- Dropping glyph names (post table format 3). Glyph *coverage* is unchanged:
  all ~2.5k encoded characters (Latin, Greek, Cyrillic, symbols) are kept.

Usage (from ``src/viser/client``)::

    pip install fonttools
    python scripts/optimize_font.py

Re-run and commit the output whenever the source font is updated.
"""

from __future__ import annotations

import io
from pathlib import Path

from fontTools import ttLib
from fontTools.varLib.instancer import instantiateVariableFont

CLIENT_DIR = Path(__file__).resolve().parent.parent
SOURCE = CLIENT_DIR / "src" / "assets" / "Inter-VariableFont_slnt,wght.ttf"
OUTPUT = CLIENT_DIR / "src" / "assets" / "InterVariable-optimized.ttf"

# Weight range to keep on the variable `wght` axis.
WGHT_RANGE = (400, 700)


def main() -> None:
    font = ttLib.TTFont(SOURCE)
    instantiateVariableFont(
        font,
        {"slnt": 0, "wght": WGHT_RANGE},
        inplace=True,
        updateFontNames=False,
    )

    # Drop glyph names; they're dead weight for web rendering.
    post = font["post"]
    post.formatType = 3.0
    post.glyphOrder = None

    buf = io.BytesIO()
    font.save(buf)
    OUTPUT.write_bytes(buf.getvalue())
    print(
        f"{SOURCE.name}: {SOURCE.stat().st_size / 1024:.0f} KiB"
        f" -> {OUTPUT.name}: {OUTPUT.stat().st_size / 1024:.0f} KiB"
    )


if __name__ == "__main__":
    main()
