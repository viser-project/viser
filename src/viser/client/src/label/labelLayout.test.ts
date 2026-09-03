import { describe, expect, it } from "vitest";
import {
  BACKGROUND_PADDING_FRACTION,
  layoutLabel,
  parseAnchor,
  segmentGraphemes,
  type FontMetrics,
} from "./labelLayout";

// Fixed-width fake measurer: 10px per grapheme cluster, with a -2px kerning
// adjustment for every "AV" pair, so kerning preservation is observable.
function fakeMeasure(text: string): number {
  const clusters = segmentGraphemes(text);
  let width = clusters.length * 10;
  for (let i = 0; i + 1 < clusters.length; i++) {
    if (clusters[i] === "A" && clusters[i + 1] === "V") width -= 2;
  }
  return width;
}

const METRICS: FontMetrics = { ascent: 8, descent: 2 };
const LINE_HEIGHT = METRICS.ascent + METRICS.descent; // 10
const PADDING = LINE_HEIGHT * BACKGROUND_PADDING_FRACTION; // 2

describe("parseAnchor", () => {
  it("parses the corner anchors", () => {
    expect(parseAnchor("top-left")).toEqual({
      anchorX: "left",
      anchorY: "top",
    });
    expect(parseAnchor("bottom-right")).toEqual({
      anchorX: "right",
      anchorY: "bottom",
    });
  });
  it("parses center variants", () => {
    expect(parseAnchor("center")).toEqual({
      anchorX: "center",
      anchorY: "middle",
    });
    expect(parseAnchor("top-center")).toEqual({
      anchorX: "center",
      anchorY: "top",
    });
    expect(parseAnchor("middle-left")).toEqual({
      anchorX: "left",
      anchorY: "middle",
    });
  });
});

describe("segmentGraphemes", () => {
  it("keeps emoji and combining marks as single clusters", () => {
    expect(segmentGraphemes("áb")).toEqual(["á", "b"]);
    expect(segmentGraphemes("x👍🏽y")).toEqual(["x", "👍🏽", "y"]);
  });
  it("splits CJK text into per-character clusters", () => {
    // Han, hiragana, katakana, hangul: one cluster per character, so each
    // gets its own atlas cell and quad.
    expect(segmentGraphemes("\u70b9\u4e91")).toEqual(["\u70b9", "\u4e91"]);
    expect(segmentGraphemes("\u30dd\u30a4\u30f3\u30c8")).toHaveLength(4);
    expect(segmentGraphemes("\ud3ec\uc778\ud2b8")).toHaveLength(3);
  });

  it("segments mixed Latin and CJK text", () => {
    expect(segmentGraphemes("pt\u70b9")).toEqual(["p", "t", "\u70b9"]);
  });

  it("handles plain ASCII", () => {
    expect(segmentGraphemes("hi")).toEqual(["h", "i"]);
  });
});

describe("layoutLabel", () => {
  it("lays out a single line with prefix-based offsets", () => {
    const layout = layoutLabel("abc", fakeMeasure, METRICS, "center", "middle");
    expect(layout.width).toBe(30);
    expect(layout.height).toBe(LINE_HEIGHT);
    expect(layout.glyphs.map((g) => g.x)).toEqual([0, 10, 20]);
    expect(layout.glyphs.map((g) => g.baselineY)).toEqual([8, 8, 8]);
    expect(layout.glyphs.map((g) => g.cluster)).toEqual(["a", "b", "c"]);
  });

  it("preserves kerning through prefix measurement", () => {
    const layout = layoutLabel("AVA", fakeMeasure, METRICS, "center", "middle");
    // Widths: "" = 0, "A" = 10, "AV" = 18 -> offsets 0, 10, 18.
    expect(layout.glyphs.map((g) => g.x)).toEqual([0, 10, 18]);
    expect(layout.width).toBe(28);
  });

  it("skips whitespace clusters but keeps their advance", () => {
    const layout = layoutLabel("a b", fakeMeasure, METRICS, "center", "middle");
    expect(layout.glyphs.map((g) => g.cluster)).toEqual(["a", "b"]);
    expect(layout.glyphs.map((g) => g.x)).toEqual([0, 20]);
    expect(layout.width).toBe(30);
  });

  it("stacks multiple lines, left-aligned like troika", () => {
    const layout = layoutLabel(
      "abcd\nab",
      fakeMeasure,
      METRICS,
      "center",
      "middle",
    );
    expect(layout.width).toBe(40);
    expect(layout.height).toBe(2 * LINE_HEIGHT);
    const secondLine = layout.glyphs.filter((g) => g.baselineY > LINE_HEIGHT);
    // Second line ("ab") starts flush with the block's left edge: the
    // previous troika implementation used textAlign "left" (its default),
    // and anchoring positions the block, not the lines.
    expect(secondLine.map((g) => g.x)).toEqual([0, 10]);
    expect(secondLine[0].baselineY).toBe(LINE_HEIGHT + METRICS.ascent);
  });

  it("treats ideographic space as whitespace: advance kept, no quad", () => {
    // U+3000 separates CJK words; like ASCII spaces it must advance the pen
    // (String.prototype.trim strips it) without emitting a glyph quad.
    const layout = layoutLabel(
      "\u70b9\u3000\u4e91",
      fakeMeasure,
      METRICS,
      "left",
      "top",
    );
    expect(layout.glyphs.map((g) => g.cluster)).toEqual(["\u70b9", "\u4e91"]);
    expect(layout.glyphs.map((g) => g.x)).toEqual([0, 20]);
    expect(layout.width).toBe(30);
  });

  it("lays out multi-line CJK text", () => {
    const layout = layoutLabel(
      "\u70b9\u4e91\u56f3\n\u30c6\u30b9\u30c8",
      fakeMeasure,
      METRICS,
      "center",
      "middle",
    );
    expect(layout.glyphs).toHaveLength(6);
    expect(layout.width).toBe(30);
    expect(layout.height).toBe(2 * LINE_HEIGHT);
    const secondLine = layout.glyphs.filter((g) => g.baselineY > LINE_HEIGHT);
    expect(secondLine.map((g) => g.x)).toEqual([0, 10, 20]);
  });

  it("returns no glyphs for empty text", () => {
    const layout = layoutLabel("", fakeMeasure, METRICS, "center", "middle");
    expect(layout.glyphs).toEqual([]);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(LINE_HEIGHT);
  });

  describe("anchoring (Y-up offsets of the padded block)", () => {
    const anchors: [
      "left" | "center" | "right",
      "top" | "middle" | "bottom",
      number,
      number,
    ][] = [
      // [anchorX, anchorY, expected offsetX, expected offsetY]
      ["left", "top", PADDING / 2, -PADDING / 2],
      ["center", "middle", -15, 5],
      ["right", "bottom", -30 - PADDING / 2, 10 + PADDING / 2],
    ];
    for (const [ax, ay, ox, oy] of anchors) {
      it(`${ay}-${ax}`, () => {
        const layout = layoutLabel("abc", fakeMeasure, METRICS, ax, ay);
        expect(layout.offsetX).toBeCloseTo(ox);
        expect(layout.offsetY).toBeCloseTo(oy);
      });
    }

    it("keeps a bottom-anchored label's background above the anchor", () => {
      const layout = layoutLabel(
        "abc",
        fakeMeasure,
        METRICS,
        "center",
        "bottom",
      );
      const bgBottom = layout.background.centerY - layout.background.height / 2;
      expect(bgBottom).toBeCloseTo(0);
    });
  });

  it("sizes the background around the padded block", () => {
    const layout = layoutLabel("abc", fakeMeasure, METRICS, "center", "middle");
    expect(layout.background.width).toBeCloseTo(30 + PADDING);
    expect(layout.background.height).toBeCloseTo(LINE_HEIGHT + PADDING);
    // Centered anchor: background centered on the anchor point.
    expect(layout.background.centerX).toBeCloseTo(0);
    expect(layout.background.centerY).toBeCloseTo(0);
  });
});
