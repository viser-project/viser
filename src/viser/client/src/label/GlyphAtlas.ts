/** SDF glyph atlas for 3D labels.
 *
 * Grapheme clusters are rasterized with the system font stack -- supersampled,
 * then converted to a signed distance field (sdf.ts) -- into a shelf-packed
 * single-channel atlas texture. The renderer re-thresholds the bilinear-
 * sampled field in the fragment shader over a ~1 screen px ramp, which keeps
 * glyph edges crisp at any scale (screen-space labels under adaptive DPR,
 * scene-space labels under arbitrary magnification, orthographic zoom).
 *
 * Using system fonts means the client ships no embedded font, and the
 * browser's own shaper handles any script it can draw (CJK, emoji, combining
 * marks). Mipmaps stay off: minifying a distance field rounds corners and
 * thickens strokes; the shader ramp handles minification instead.
 *
 * Atlases are instantiated per font-pixel-size bucket (see LabelRenderer):
 * labels whose on-screen size is known from their configuration rasterize at
 * a matching resolution instead of one fixed size.
 */
import * as THREE from "three";
import { sdfFromRasterizedGlyph, supersampleForFontPx } from "./sdf";
/** Matches the DOM UI's font stack (index.css / AppTheme.ts). */
export const LABEL_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Helvetica Neue", Arial, sans-serif';

const ATLAS_SIZE = 1024;
const MAX_ATLAS_SIZE = 4096;

export interface GlyphCell {
  /** Atlas UV rectangle of the glyph's *quad* (ink box + a margin covering
   * the SDF ramp -- not the full padded cell). flipY is disabled on the
   * texture, so v increases downward: v0 is the quad's top edge. */
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
  /** Scratch canvas for supersampled glyph rasterization. */
  private scratch: HTMLCanvasElement;
  private scratchCtx: CanvasRenderingContext2D;
  /** Measurement context at the atlas font size. */
  private measureCtx: CanvasRenderingContext2D;
  private cells = new Map<string, GlyphCell>();
  private shelfX = 0;
  private shelfY = 0;
  private shelfHeight = 0;
  /** Single-channel SDF backing store, size x size. */
  private data: Uint8Array;
  /** Padding around each cell in the atlas; also bounds the SDF ramp, so
   * bilinear samples near a quad edge stay inside valid field values. */
  private cellPadding: number;
  /** Margin kept around the ink box in each glyph quad, covering the
   * distance-field ramp the shader thresholds over. */
  private quadMargin: number;
  /** Supersampling factor for rasterization before the distance transform
   * (see supersampleForFontPx). */
  private supersample: number;
  readonly fontPx: number;
  /** SDF encoding radius in atlas px (see sdf.ts encodeSdf). */
  readonly sdfRadius: number;
  size = ATLAS_SIZE;
  texture: THREE.DataTexture;
  /** Line metrics at fontPx, from the canvas text engine. */
  readonly ascent: number;
  readonly descent: number;
  /** Bumped whenever cell UVs are invalidated by an atlas resize; consumers
   * that cached cells must rebuild. */
  generation = 0;
  /** Full-at-max-size recycles (a subset of generation bumps): consumers use
   * this to detect glyph sets that cannot fit the atlas at all. */
  recycles = 0;

  constructor(fontPx: number) {
    this.fontPx = fontPx;
    this.cellPadding = Math.max(3, Math.ceil(fontPx / 8));
    this.quadMargin = Math.max(2, Math.ceil(fontPx / 16));
    this.sdfRadius = this.cellPadding;
    this.supersample = supersampleForFontPx(fontPx);

    const measureCanvas = document.createElement("canvas");
    measureCanvas.width = measureCanvas.height = 1;
    const measureCtx = measureCanvas.getContext("2d");
    this.scratch = document.createElement("canvas");
    this.scratch.width = this.scratch.height = 64 * this.supersample;
    const scratchCtx = this.scratch.getContext("2d", {
      willReadFrequently: true,
    });
    if (measureCtx === null || scratchCtx === null) {
      throw new Error("Could not create 2D canvas context");
    }
    this.measureCtx = measureCtx;
    this.scratchCtx = scratchCtx;
    this.configureContexts();

    const probe = this.measureCtx.measureText("Mgj");
    // fontBoundingBox* can be missing in older engines; fall back to
    // em-box-based estimates.
    this.ascent = probe.fontBoundingBoxAscent ?? fontPx * 0.8;
    this.descent = probe.fontBoundingBoxDescent ?? fontPx * 0.25;

    this.data = new Uint8Array(this.size * this.size);
    this.texture = this.createTexture();
  }

  private configureContexts() {
    this.measureCtx.font = `${this.fontPx}px ${LABEL_FONT_STACK}`;
    this.measureCtx.textBaseline = "alphabetic";
    this.scratchCtx.font = `${this.fontPx * this.supersample}px ${LABEL_FONT_STACK}`;
    this.scratchCtx.textBaseline = "alphabetic";
    this.scratchCtx.fillStyle = "#ffffff"; // Only alpha coverage is used.
  }

  private createTexture(): THREE.DataTexture {
    const texture = new THREE.DataTexture(
      this.data,
      this.size,
      this.size,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    // Keep row order: v=0 is the data top, so cell v0/v1 can be computed
    // directly from atlas y.
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  }

  /** Advance width of `text` at the atlas font size. */
  measure(text: string): number {
    return this.measureCtx.measureText(text).width;
  }

  /** Whether a cluster's cell is already rasterized (getCell would be a
   * cache hit). Lets the renderer budget rasterization work per frame. */
  has(cluster: string): boolean {
    return this.cells.has(cluster);
  }

  /** Get (rasterizing on first use) the atlas cell for a grapheme cluster. */
  getCell(cluster: string): GlyphCell {
    let cell = this.cells.get(cluster);
    if (cell !== undefined) return cell;

    const m = this.measureCtx.measureText(cluster);
    const padding = this.cellPadding;
    // Tight ink bounds when available; generous fallback otherwise.
    const inkLeft = Math.ceil(m.actualBoundingBoxLeft ?? 0) + padding;
    const inkRight = Math.ceil(m.actualBoundingBoxRight ?? m.width);
    const inkAscent = Math.ceil(m.actualBoundingBoxAscent ?? this.ascent);
    const inkDescent = Math.ceil(m.actualBoundingBoxDescent ?? this.descent);
    let cellWidth = inkLeft + inkRight + padding;
    let cellHeight = inkAscent + inkDescent + 2 * padding;

    // A cluster can measure larger than the whole atlas (multi-em ligatures
    // like U+FDFA at large buckets). Grow if a larger atlas would fit it;
    // at maximum size, clamp the cell and let the glyph clip -- the shelf
    // logic below only checks height, and an unclamped width would wrap the
    // blit into neighboring rows (or off the end of the backing store).
    if (
      (cellWidth > this.size || cellHeight > this.size) &&
      this.size < MAX_ATLAS_SIZE
    ) {
      this.grow();
      return this.getCell(cluster);
    }
    cellWidth = Math.min(cellWidth, this.size);
    cellHeight = Math.min(cellHeight, this.size);

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

    // Rasterize supersampled, distance-transform, and blit the SDF cell.
    const ss = this.supersample;
    const wSS = cellWidth * ss;
    const hSS = cellHeight * ss;
    if (this.scratch.width < wSS || this.scratch.height < hSS) {
      this.scratch.width = Math.max(this.scratch.width, wSS);
      this.scratch.height = Math.max(this.scratch.height, hSS);
      this.configureContexts(); // Canvas state resets when resized.
    }
    this.scratchCtx.clearRect(0, 0, wSS, hSS);
    // Pen position inside the cell: baseline at inkAscent + padding, left
    // edge at inkLeft (which includes padding).
    this.scratchCtx.fillText(cluster, inkLeft * ss, (padding + inkAscent) * ss);
    const rgba = this.scratchCtx.getImageData(0, 0, wSS, hSS).data;
    const sdf = sdfFromRasterizedGlyph(rgba, wSS, hSS, ss, this.sdfRadius);
    for (let row = 0; row < cellHeight; row++) {
      this.data.set(
        sdf.subarray(row * cellWidth, (row + 1) * cellWidth),
        (y + row) * this.size + x,
      );
    }
    this.texture.needsUpdate = true;

    // The instanced quad covers only the ink box plus the ramp margin,
    // cutting overdraw; the remaining cell padding stays in the atlas purely
    // as field slack for bilinear sampling.
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
      this.data.fill(0); // 0 encodes "far outside": renders as empty.
      this.cells.clear();
      this.texture.needsUpdate = true;
      this.recycles += 1;
    } else {
      // three's WebGL2 texture storage is immutable per size; swap in a new
      // texture (consumers re-read atlas.texture on rebuild).
      this.size *= 2;
      this.data = new Uint8Array(this.size * this.size);
      this.texture.dispose();
      this.texture = this.createTexture();
      this.cells.clear();
    }
    this.shelfX = 0;
    this.shelfY = 0;
    this.shelfHeight = 0;
    this.generation += 1;
  }

  dispose() {
    this.texture.dispose();
  }
}
