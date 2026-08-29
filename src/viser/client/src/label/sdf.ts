/** Signed distance field construction for glyph atlases.
 *
 * Glyphs are rasterized supersampled (see GlyphAtlas), and this module turns
 * that coverage bitmap into a distance field at the atlas resolution:
 *
 *  1. Threshold the supersampled alpha into an ink mask.
 *  2. Exact Euclidean distance transform of the mask and its complement
 *     (Felzenszwalb & Huttenlocher's O(n) squared-distance algorithm).
 *  3. Signed distance per supersampled pixel, with the half-pixel correction
 *     for the binary edge sitting between pixel centers.
 *  4. Box-downsample the *field* by the supersampling factor.
 *
 * Supersampling matters: a distance transform locates the outline only to
 * ~0.3 px of its input grid, which at small atlas sizes shows up as lumpy,
 * uneven strokes. At 4x the residual error is well under a tenth of an atlas
 * pixel. Pure array math, no DOM -- unit-tested in Node.
 */

const INF = 1e20;

/** 1D squared-distance transform (Felzenszwalb & Huttenlocher). Reads f[0..n),
 * writes d[0..n); v and z are scratch. */
function edt1d(
  f: Float64Array,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
  n: number,
): void {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  let k = 0;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** In-place 2D squared Euclidean distance transform of `grid` (0 at feature
 * pixels, INF elsewhere). */
function edt2d(grid: Float64Array, width: number, height: number): void {
  const n = Math.max(width, height);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x];
    edt1d(f, d, v, z, height);
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = grid[y * width + x];
    edt1d(f, d, v, z, width);
    for (let x = 0; x < width; x++) grid[y * width + x] = d[x];
  }
}

/** Encode a signed distance (atlas px, positive inside ink) into a byte:
 * 0.5 at the outline, saturating at +/- radiusPx. */
export function encodeSdf(distPx: number, radiusPx: number): number {
  const t = Math.min(1, Math.max(0, 0.5 + distPx / (2 * radiusPx)));
  return Math.round(t * 255);
}

/** Byte-to-signed-distance inverse of encodeSdf; the shader applies the same
 * mapping when thresholding. */
export function decodeSdf(byte: number, radiusPx: number): number {
  return (byte / 255 - 0.5) * 2 * radiusPx;
}

/** Build an atlas-resolution SDF from a supersampled RGBA rasterization.
 *
 * `rgba` is ImageData-style RGBA at (widthSS x heightSS), which must be
 * `ss` times the target cell size; only the alpha channel is read. Returns
 * encoded bytes at (widthSS / ss) x (heightSS / ss).
 */
export function sdfFromRasterizedGlyph(
  rgba: Uint8ClampedArray | Uint8Array,
  widthSS: number,
  heightSS: number,
  ss: number,
  radiusPx: number,
): Uint8Array {
  if (widthSS % ss !== 0 || heightSS % ss !== 0) {
    throw new Error("Supersampled dimensions must be multiples of ss");
  }
  const n = widthSS * heightSS;

  // Squared distance to ink (outside) and to background (inside).
  const toInk = new Float64Array(n);
  const toBg = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ink = rgba[i * 4 + 3] >= 128;
    toInk[i] = ink ? 0 : INF;
    toBg[i] = ink ? INF : 0;
  }
  edt2d(toInk, widthSS, heightSS);
  edt2d(toBg, widthSS, heightSS);

  // Signed distance in supersampled px: positive inside ink. The true edge
  // lies between an ink pixel and a background pixel, so each one-sided
  // distance is a half pixel shorter than pixel-center spacing suggests.
  const signed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    signed[i] =
      toBg[i] > 0
        ? Math.max(0, Math.sqrt(toBg[i]) - 0.5) // Inside ink.
        : -Math.max(0, Math.sqrt(toInk[i]) - 0.5); // Outside ink.
  }

  // Box-downsample the field into target resolution, converting supersampled
  // px to atlas px.
  const width = widthSS / ss;
  const height = heightSS / ss;
  const out = new Uint8Array(width * height);
  const norm = 1 / (ss * ss * ss); // Block average, then / ss for units.
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      let sum = 0;
      for (let dy = 0; dy < ss; dy++) {
        const row = (ty * ss + dy) * widthSS + tx * ss;
        for (let dx = 0; dx < ss; dx++) sum += signed[row + dx];
      }
      out[ty * width + tx] = encodeSdf(sum * norm, radiusPx);
    }
  }
  return out;
}
