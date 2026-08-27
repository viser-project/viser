/** Pure layout logic for 3D labels.
 *
 * Text is rendered from a canvas-rasterized glyph atlas (see GlyphAtlas.ts):
 * each label becomes one background quad plus one instanced quad per grapheme
 * cluster. This module computes where those quads go, in "atlas pixel" units
 * at the atlas font size; the renderer scales positions by
 * (font size in world units) / (atlas font px).
 *
 * Kept free of DOM/three dependencies so it can be unit-tested in Node: text
 * measurement is injected as a function.
 */

export interface GlyphMeasure {
  /** Advance width of `text`, in atlas pixels. */
  (text: string): number;
}

export interface FontMetrics {
  /** Distance from baseline to the top of a line box, in atlas pixels. */
  ascent: number;
  /** Distance from baseline to the bottom of a line box (positive), in atlas
   * pixels. */
  descent: number;
}

export interface GlyphPlacement {
  /** The grapheme cluster to draw. */
  cluster: string;
  /** X of the cluster's left edge relative to the label block's left edge. */
  x: number;
  /** Baseline Y of the cluster's line, relative to the block's top edge
   * (positive = down). */
  baselineY: number;
}

export interface LabelLayout {
  glyphs: GlyphPlacement[];
  /** Tight block size around all lines. */
  width: number;
  height: number;
  /** Offset from the label's anchor point to the block's top-left corner, in
   * atlas pixels, Y-up (matching world space): anchoring at "top-left" gives
   * (0, 0); "bottom-right" gives (-width, height). The renderer adds
   * `(x + offsetX, -baselineY + offsetY)` Y-up positions. */
  offsetX: number;
  offsetY: number;
  /** Background rectangle, centered on the padded block: center position
   * relative to the anchor point (Y-up) and size. */
  background: {
    centerX: number;
    centerY: number;
    width: number;
    height: number;
  };
}

export type LabelAnchorX = "left" | "center" | "right";
export type LabelAnchorY = "top" | "middle" | "bottom";

/** Split a viser anchor string ("top-left", "center", ...) into axes. */
export function parseAnchor(anchor: string): {
  anchorX: LabelAnchorX;
  anchorY: LabelAnchorY;
} {
  const [vertical, horizontal] = anchor.split("-");
  const anchorY =
    vertical === "top" ? "top" : vertical === "bottom" ? "bottom" : "middle";
  const anchorX =
    horizontal === "left"
      ? "left"
      : horizontal === "right"
        ? "right"
        : "center";
  return { anchorX, anchorY };
}

/** Split text into grapheme clusters (so emoji / combining marks stay
 * together), using Intl.Segmenter when available. */
export function segmentGraphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    });
    return Array.from(segmenter.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/** Padding around the text block for the background rectangle, as a fraction
 * of the line height. Matches the previous troika-based implementation's
 * 0.2 x font-size padding. */
export const BACKGROUND_PADDING_FRACTION = 0.2;

/**
 * Lay out a (possibly multi-line) label.
 *
 * @param text Label text; newlines split lines.
 * @param measure Advance-width measurement at the atlas font size. Glyph x
 *   offsets are computed from prefix widths so inter-cluster kerning applied
 *   by the text engine is preserved.
 * @param metrics Line metrics at the atlas font size.
 * @param anchorX/anchorY Which point of the (padded) block sits at the
 *   label's 3D position.
 */
export function layoutLabel(
  text: string,
  measure: GlyphMeasure,
  metrics: FontMetrics,
  anchorX: LabelAnchorX,
  anchorY: LabelAnchorY,
): LabelLayout {
  const lineHeight = metrics.ascent + metrics.descent;
  const lines = text.split("\n");

  interface Line {
    clusters: string[];
    offsets: number[];
    width: number;
  }
  const measuredLines: Line[] = lines.map((line) => {
    const clusters = segmentGraphemes(line);
    const offsets: number[] = [];
    // Prefix widths preserve kerning between clusters.
    let prefix = "";
    for (const cluster of clusters) {
      offsets.push(measure(prefix));
      prefix += cluster;
    }
    return { clusters, offsets, width: measure(prefix) };
  });

  const width = Math.max(0, ...measuredLines.map((l) => l.width));
  const height = lineHeight * lines.length;

  const glyphs: GlyphPlacement[] = [];
  measuredLines.forEach((line, lineIndex) => {
    // Center each line horizontally within the block, matching troika's
    // default multi-line alignment for centered labels; for left/right
    // anchors the block itself is offset, and lines stay centered (this
    // matches textAlign: center behavior).
    const lineStart = (width - line.width) / 2;
    const baselineY = lineIndex * lineHeight + metrics.ascent;
    line.clusters.forEach((cluster, i) => {
      if (cluster.trim() === "") return; // Whitespace needs no quad.
      glyphs.push({
        cluster,
        x: lineStart + line.offsets[i],
        baselineY,
      });
    });
  });

  // Anchor offsets in Y-up coordinates. The anchor applies to the padded
  // block (text + background padding), so a "bottom" anchored label's
  // background doesn't overlap the anchor point.
  const padding = lineHeight * BACKGROUND_PADDING_FRACTION;
  const paddedWidth = width + padding;
  const paddedHeight = height + padding;

  let offsetX: number;
  if (anchorX === "left") offsetX = padding / 2;
  else if (anchorX === "right") offsetX = -width - padding / 2;
  else offsetX = -width / 2;

  // offsetY positions the block's *top* edge relative to the anchor (Y-up:
  // the top edge is at +offsetY, text extends downward).
  let offsetY: number;
  if (anchorY === "top") offsetY = -padding / 2;
  else if (anchorY === "bottom") offsetY = height + padding / 2;
  else offsetY = height / 2;

  const background = {
    centerX: offsetX + width / 2,
    centerY: offsetY - height / 2,
    width: paddedWidth,
    height: paddedHeight,
  };

  return { glyphs, width, height, offsetX, offsetY, background };
}
