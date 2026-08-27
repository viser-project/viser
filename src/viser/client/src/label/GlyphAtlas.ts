/** Canvas-rasterized glyph atlas for 3D labels.
 *
 * Grapheme clusters are drawn with the system font stack into a shelf-packed
 * canvas; the renderer samples the resulting texture per glyph quad. Using
 * system fonts means the client ships no embedded font, and the browser's own
 * shaper handles any script it can draw (CJK, emoji, combining marks).
 *
 * Atlases are instantiated per font-pixel-size bucket (see LabelRenderer):
 * labels whose on-screen size is known from their configuration rasterize at
 * a matching resolution instead of one fixed size.
 */
import * as THREE from "three";

/** Matches the DOM UI's font stack (index.css / AppTheme.ts). */
export const LABEL_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Helvetica Neue", Arial, sans-serif';

const ATLAS_SIZE = 1024;
const MAX_ATLAS_SIZE = 4096;

export interface GlyphCell {
  /** Atlas UV rectangle of the glyph's *quad* (ink box + a small
   * antialiasing margin -- not the full padded cell). flipY is disabled on
   * the texture, so v increases downward: v0 is the quad's top edge. */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Offset from the cluster's pen position (baseline left) to the quad's
   * left edge (pen.x - penToLeft) and top edge (baseline.y + penToTop,
   * Y-up), in atlas px. */
  penToLeft: number;
  penToTop: number;
  /** Quad size in atlas px. */
  width: number;
  height: number;
}

export class GlyphAtlas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cells = new Map<string, GlyphCell>();
  private shelfX = 0;
  private shelfY = 0;
  private shelfHeight = 0;
  private size = ATLAS_SIZE;
  /** Padding around each cell in the atlas, so linear filtering and
   * mipmapping don't bleed neighboring glyphs. */
  private cellPadding: number;
  /** Antialiasing margin kept around the ink box in each glyph quad. */
  private quadMargin: number;
  readonly fontPx: number;
  readonly texture: THREE.CanvasTexture;
  /** Line metrics at fontPx, from the canvas text engine. */
  readonly ascent: number;
  readonly descent: number;
  /** Bumped whenever cell UVs are invalidated by an atlas resize; consumers
   * that cached cells must rebuild. */
  generation = 0;

  constructor(fontPx: number) {
    this.fontPx = fontPx;
    this.cellPadding = Math.ceil(fontPx / 8);
    this.quadMargin = Math.max(2, Math.ceil(fontPx / 16));
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.size;
    this.canvas.height = this.size;
    const ctx = this.canvas.getContext("2d", { willReadFrequently: false });
    if (ctx === null) throw new Error("Could not create 2D canvas context");
    this.ctx = ctx;
    this.configureContext();

    const probe = this.ctx.measureText("Mgj");
    // fontBoundingBox* can be missing in older engines; fall back to
    // em-box-based estimates.
    this.ascent = probe.fontBoundingBoxAscent ?? fontPx * 0.8;
    this.descent = probe.fontBoundingBoxDescent ?? fontPx * 0.25;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.anisotropy = 4;
    // Keep canvas row order: v=0 is the canvas top, so cell v0/v1 can be
    // computed directly from canvas y.
    this.texture.flipY = false;
  }

  private configureContext() {
    this.ctx.font = `${this.fontPx}px ${LABEL_FONT_STACK}`;
    this.ctx.textBaseline = "alphabetic";
    this.ctx.fillStyle = "#ffffff"; // Colored in the shader.
  }

  /** Advance width of `text` at the atlas font size. */
  measure(text: string): number {
    return this.ctx.measureText(text).width;
  }

  /** Get (rasterizing on first use) the atlas cell for a grapheme cluster. */
  getCell(cluster: string): GlyphCell {
    let cell = this.cells.get(cluster);
    if (cell !== undefined) return cell;

    const m = this.ctx.measureText(cluster);
    const padding = this.cellPadding;
    // Tight ink bounds when available; generous fallback otherwise.
    const inkLeft = Math.ceil(m.actualBoundingBoxLeft ?? 0) + padding;
    const inkRight = Math.ceil(m.actualBoundingBoxRight ?? m.width);
    const inkAscent = Math.ceil(m.actualBoundingBoxAscent ?? this.ascent);
    const inkDescent = Math.ceil(m.actualBoundingBoxDescent ?? this.descent);
    const cellWidth = inkLeft + inkRight + padding;
    const cellHeight = inkAscent + inkDescent + 2 * padding;

    // Shelf packing: place on the current shelf, else open a new shelf, else
    // grow the atlas (invalidating existing UVs).
    if (this.shelfX + cellWidth > this.size) {
      this.shelfY += this.shelfHeight;
      this.shelfX = 0;
      this.shelfHeight = 0;
    }
    if (this.shelfY + cellHeight > this.size) {
      this.grow();
      return this.getCell(cluster);
    }
    const x = this.shelfX;
    const y = this.shelfY;
    this.shelfX += cellWidth;
    this.shelfHeight = Math.max(this.shelfHeight, cellHeight);

    // Pen position inside the cell: baseline at inkAscent + padding, left
    // edge at inkLeft (which includes padding).
    this.ctx.fillText(cluster, x + inkLeft, y + padding + inkAscent);
    this.texture.needsUpdate = true;

    // The instanced quad covers only the ink box plus an antialiasing
    // margin, cutting overdraw; the remaining cell padding stays in the
    // atlas purely as filtering slack.
    const inset = padding - this.quadMargin;
    const quadWidth = cellWidth - 2 * inset;
    const quadHeight = cellHeight - 2 * inset;
    cell = {
      u0: (x + inset) / this.size,
      v0: (y + inset) / this.size,
      u1: (x + cellWidth - inset) / this.size,
      v1: (y + cellHeight - inset) / this.size,
      penToLeft: inkLeft - inset,
      penToTop: padding + inkAscent - inset,
      width: quadWidth,
      height: quadHeight,
    };
    this.cells.set(cluster, cell);
    return cell;
  }

  private grow() {
    if (this.size >= MAX_ATLAS_SIZE) {
      // Out of space: recycle the whole atlas. Consumers rebuild via the
      // generation bump. This should only happen with pathological glyph
      // diversity (thousands of unique CJK clusters).
      console.warn("[GlyphAtlas] Atlas full; recycling all cells.");
      this.cells.clear();
      this.ctx.clearRect(0, 0, this.size, this.size);
    } else {
      this.size *= 2;
      this.canvas.width = this.size;
      this.canvas.height = this.size;
      // Canvas state (font etc.) resets when resized.
      this.configureContext();
      this.cells.clear();
    }
    this.shelfX = 0;
    this.shelfY = 0;
    this.shelfHeight = 0;
    this.generation += 1;
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
  }
}
