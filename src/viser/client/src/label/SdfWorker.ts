/** Worker for glyph SDF construction.
 *
 * The distance transform is the expensive part of building a glyph atlas
 * cell (sdf.ts); running it here keeps the main thread's per-glyph cost to
 * rasterization + pixel readback. Jobs and results carry their pixel buffers
 * as transferables, so no copies cross the thread boundary.
 */
import { sdfFromRasterizedGlyph } from "./sdf";

export interface SdfJob {
  token: number;
  /** RGBA pixels of the supersampled rasterization (ImageData buffer). */
  rgba: ArrayBuffer;
  widthSS: number;
  heightSS: number;
  ss: number;
  radiusPx: number;
}

export interface SdfResult {
  token: number;
  /** Encoded SDF at atlas resolution (see sdf.ts encodeSdf). */
  sdf: Uint8Array;
}

self.onmessage = ({ data }: MessageEvent<SdfJob>) => {
  const sdf = sdfFromRasterizedGlyph(
    new Uint8ClampedArray(data.rgba),
    data.widthSS,
    data.heightSS,
    data.ss,
    data.radiusPx,
  );
  const result: SdfResult = { token: data.token, sdf };
  // @ts-ignore -- worker-scoped postMessage (same convention as SplatSortWorker).
  self.postMessage(result, [sdf.buffer]);
};
