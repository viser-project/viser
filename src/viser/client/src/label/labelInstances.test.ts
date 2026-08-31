import { describe, expect, it } from "vitest";
import { buildInstanceBuffers, LabelEntryConfig } from "./labelInstances";
import { segmentGraphemes, type FontMetrics } from "./labelLayout";
import type { GlyphCell } from "./GlyphAtlas";

const METRICS: FontMetrics = { ascent: 8, descent: 2 };

function fakeMeasure(text: string): number {
  return segmentGraphemes(text).length * 10;
}

// Every cluster gets the same fake cell shape but a distinct u0 so instances
// can be traced back to their cluster.
const cellRegistry = new Map<string, GlyphCell>();
function fakeGetCell(cluster: string): GlyphCell {
  let cell = cellRegistry.get(cluster);
  if (!cell) {
    cell = {
      u0: cellRegistry.size * 0.1,
      v0: 0.5,
      u1: cellRegistry.size * 0.1 + 0.05,
      v1: 0.6,
      penToLeft: 1,
      penToTop: 9,
      width: 12,
      height: 14,
    };
    cellRegistry.set(cluster, cell);
  }
  return cell;
}

function entry(overrides: Partial<LabelEntryConfig> = {}): LabelEntryConfig {
  return {
    text: "ab",
    sizeMode: "scene",
    scalePxToUnit: 0.01,
    anchorX: "center",
    anchorY: "middle",
    labelIndex: 3,
    ...overrides,
  };
}

describe("buildInstanceBuffers", () => {
  it("emits one bg per label and one glyph per non-space cluster", () => {
    const buffers = buildInstanceBuffers(
      [entry({ text: "a b" }), entry({ text: "xy", labelIndex: 7 })],
      fakeMeasure,
      fakeGetCell,
      METRICS,
    );
    expect(buffers.bgCount).toBe(2);
    expect(buffers.glyphCount).toBe(4); // "a", "b", "x", "y".
    expect(Array.from(buffers.bgLabelIndex)).toEqual([3, 7]);
    // Glyphs carry their label's index.
    expect(Array.from(buffers.glyphLabelIndex)).toEqual([3, 3, 7, 7]);
  });

  it("computes glyph rects from pen positions and cell offsets", () => {
    const buffers = buildInstanceBuffers(
      [entry({ text: "ab", anchorX: "left", anchorY: "top" })],
      fakeMeasure,
      fakeGetCell,
      METRICS,
    );
    // anchor left/top: offsetX = padding/2 = 1, offsetY = -1.
    // First glyph pen = (1, -1 - 8) = (1, -9) (baseline, Y-up).
    // rect left = penX - penToLeft = 0; top = penY + penToTop = 0;
    // bottom = top - height = -14.
    expect(Array.from(buffers.glyphRect.slice(0, 4))).toEqual([0, -14, 12, 14]);
    // Second glyph advances 10px in x.
    expect(Array.from(buffers.glyphRect.slice(4, 8))).toEqual([
      10, -14, 12, 14,
    ]);
  });

  it("passes through atlas UVs per cluster", () => {
    cellRegistry.clear();
    const buffers = buildInstanceBuffers(
      [entry({ text: "aa" })],
      fakeMeasure,
      fakeGetCell,
      METRICS,
    );
    // Same cluster -> same cell UVs for both instances.
    expect(Array.from(buffers.glyphUv.slice(0, 4))).toEqual(
      Array.from(buffers.glyphUv.slice(4, 8)),
    );
  });

  it("encodes size mode and scale in params", () => {
    const buffers = buildInstanceBuffers(
      [
        entry({ text: "a", sizeMode: "screen", scalePxToUnit: 0.25 }),
        entry({ text: "b", sizeMode: "scene", scalePxToUnit: 0.5 }),
      ],
      fakeMeasure,
      fakeGetCell,
      METRICS,
    );
    expect(Array.from(buffers.glyphParams)).toEqual([1, 0.25, 0, 0.5]);
    expect(Array.from(buffers.bgParams)).toEqual([1, 0.25, 0, 0.5]);
  });

  it("centers the background on a centered label", () => {
    const buffers = buildInstanceBuffers(
      [entry({ text: "ab" })],
      fakeMeasure,
      fakeGetCell,
      METRICS,
    );
    const [left, bottom, width, height] = Array.from(
      buffers.bgRect.slice(0, 4),
    );
    expect(left).toBeCloseTo(-width / 2);
    expect(bottom).toBeCloseTo(-height / 2);
    expect(width).toBeCloseTo(20 + 2); // Text + padding.
    expect(height).toBeCloseTo(10 + 2);
  });

  it("emits one quad per CJK character, none for ideographic spaces", () => {
    const buffers = buildInstanceBuffers(
      [entry({ text: "\u70b9\u3000\u4e91" })],
      fakeMeasure,
      fakeGetCell,
      METRICS,
    );
    expect(buffers.glyphCount).toBe(2);
    // Distinct clusters get distinct atlas cells (distinct u0 values).
    expect(buffers.glyphUv[0]).not.toBe(buffers.glyphUv[4]);
  });

  it("skips glyphs whose cell is null (capacity-exceeded fallback)", () => {
    // The renderer passes a getCell that returns null for glyphs that no
    // longer fit the atlas; those clusters get no quad, but the label's
    // layout (and background) is otherwise unaffected.
    const buffers = buildInstanceBuffers(
      [entry({ text: "abc" })],
      fakeMeasure,
      (cluster) => (cluster === "b" ? null : fakeGetCell(cluster)),
      METRICS,
    );
    expect(buffers.glyphCount).toBe(2);
    expect(buffers.bgCount).toBe(1);
  });

  it("handles an empty entry list", () => {
    const buffers = buildInstanceBuffers([], fakeMeasure, fakeGetCell, METRICS);
    expect(buffers.glyphCount).toBe(0);
    expect(buffers.bgCount).toBe(0);
  });
});
