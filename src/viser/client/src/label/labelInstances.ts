/** Builds instance buffers for the label renderer.
 *
 * Each label contributes one background instance and one instance per
 * (non-whitespace) grapheme cluster. Instance attributes are static; only the
 * per-label data texture (world position + visibility) changes per frame.
 *
 * Pure module (cell lookup and measurement injected) so buffer layout can be
 * unit-tested in Node.
 */
import {
  FontMetrics,
  LabelAnchorX,
  LabelAnchorY,
  layoutLabel,
} from "./labelLayout";
import type { GlyphCell } from "./GlyphAtlas";

export interface LabelEntryConfig {
  text: string;
  sizeMode: "screen" | "scene";
  /** World units per atlas pixel (baseFontSize / ATLAS_FONT_PX). */
  scalePxToUnit: number;
  anchorX: LabelAnchorX;
  anchorY: LabelAnchorY;
  /** Slot in the per-label data texture. */
  labelIndex: number;
}

export interface InstanceBuffers {
  glyphCount: number;
  /** Per glyph instance. */
  glyphLabelIndex: Float32Array;
  /** (left, bottom, width, height) in label-local Y-up atlas px. */
  glyphRect: Float32Array;
  /** (u0, v0Top, u1, v1Bottom) atlas UVs. */
  glyphUv: Float32Array;
  /** (sizeMode, scalePxToUnit) per glyph. */
  glyphParams: Float32Array;

  bgCount: number;
  bgLabelIndex: Float32Array;
  bgRect: Float32Array;
  bgParams: Float32Array;
}

export function buildInstanceBuffers(
  entries: LabelEntryConfig[],
  measure: (text: string) => number,
  getCell: (cluster: string) => GlyphCell,
  metrics: FontMetrics,
): InstanceBuffers {
  interface GlyphInstance {
    labelIndex: number;
    rect: [number, number, number, number];
    uv: [number, number, number, number];
    params: [number, number];
  }
  const glyphs: GlyphInstance[] = [];
  const bgLabelIndex: number[] = [];
  const bgRect: number[] = [];
  const bgParams: number[] = [];

  for (const entry of entries) {
    const layout = layoutLabel(
      entry.text,
      measure,
      metrics,
      entry.anchorX,
      entry.anchorY,
    );
    const sizeModeFlag = entry.sizeMode === "screen" ? 1 : 0;

    for (const glyph of layout.glyphs) {
      const cell = getCell(glyph.cluster);
      // Pen position in label-local Y-up px: x from block-left, baseline
      // measured down from the block top (layout.offsetY = top edge, Y-up).
      const penX = layout.offsetX + glyph.x;
      const penY = layout.offsetY - glyph.baselineY;
      const left = penX - cell.penToLeft;
      const top = penY + cell.penToTop;
      glyphs.push({
        labelIndex: entry.labelIndex,
        rect: [left, top - cell.height, cell.width, cell.height],
        uv: [cell.u0, cell.v0, cell.u1, cell.v1],
        params: [sizeModeFlag, entry.scalePxToUnit],
      });
    }

    bgLabelIndex.push(entry.labelIndex);
    bgRect.push(
      layout.background.centerX - layout.background.width / 2,
      layout.background.centerY - layout.background.height / 2,
      layout.background.width,
      layout.background.height,
    );
    bgParams.push(sizeModeFlag, entry.scalePxToUnit);
  }

  const glyphCount = glyphs.length;
  const buffers: InstanceBuffers = {
    glyphCount,
    glyphLabelIndex: new Float32Array(glyphCount),
    glyphRect: new Float32Array(glyphCount * 4),
    glyphUv: new Float32Array(glyphCount * 4),
    glyphParams: new Float32Array(glyphCount * 2),
    bgCount: bgLabelIndex.length,
    bgLabelIndex: new Float32Array(bgLabelIndex),
    bgRect: new Float32Array(bgRect),
    bgParams: new Float32Array(bgParams),
  };
  glyphs.forEach((g, i) => {
    buffers.glyphLabelIndex[i] = g.labelIndex;
    buffers.glyphRect.set(g.rect, i * 4);
    buffers.glyphUv.set(g.uv, i * 4);
    buffers.glyphParams.set(g.params, i * 2);
  });
  return buffers;
}
