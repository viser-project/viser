import { describe, expect, it } from "vitest";
import {
  decodeSdf,
  encodeSdf,
  sdfFromRasterizedGlyph,
  supersampleForFontPx,
} from "./sdf";

/** RGBA raster of a filled axis-aligned rectangle. */
function rectRaster(
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) {
        rgba[(y * width + x) * 4 + 3] = 255;
      }
    }
  }
  return rgba;
}

const RADIUS = 4;

describe("sdf", () => {
  it("round-trips encode/decode within quantization error", () => {
    for (const d of [-RADIUS, -1.3, 0, 0.72, RADIUS]) {
      expect(decodeSdf(encodeSdf(d, RADIUS), RADIUS)).toBeCloseTo(d, 1);
    }
    // Saturation beyond the radius.
    expect(encodeSdf(100, RADIUS)).toBe(255);
    expect(encodeSdf(-100, RADIUS)).toBe(0);
  });

  it("places the zero crossing on the rectangle edge", () => {
    // 64x64 supersampled (ss=4 -> 16x16 target) rect covering the middle:
    // supersampled [16, 48) = target-px [4, 12).
    const ss = 4;
    const sdf = sdfFromRasterizedGlyph(
      rectRaster(64, 64, 16, 16, 48, 48),
      64,
      64,
      ss,
      RADIUS,
    );
    const dist = (x: number, y: number) => decodeSdf(sdf[y * 16 + x], RADIUS);

    // Center texel (center 8.5): 3.5 px from the nearest edge at x=12.
    // Far-outside corner: saturated negative.
    expect(dist(8, 8)).toBeCloseTo(3.5, 0);
    expect(dist(0, 0)).toBeCloseTo(-RADIUS, 1);

    // Straddling the left edge at x=4: the texel centered at 3.5 is half a
    // pixel outside, the one at 4.5 half a pixel inside.
    expect(dist(3, 8)).toBeCloseTo(-0.5, 0);
    expect(dist(4, 8)).toBeCloseTo(0.5, 0);
    expect(dist(3, 8)).toBeLessThan(0);
    expect(dist(4, 8)).toBeGreaterThan(0);

    // One target px further in each direction: about +/- 1.5 px.
    expect(dist(2, 8)).toBeCloseTo(-1.5, 0);
    expect(dist(5, 8)).toBeCloseTo(1.5, 0);
  });

  it("measures interior distance from the nearest edge", () => {
    // Wide, short bar: interior distance is set by the short axis.
    const ss = 4;
    const sdf = sdfFromRasterizedGlyph(
      rectRaster(96, 32, 0, 8, 96, 24), // Target: 24x8 bar rows [2, 6).
      96,
      32,
      ss,
      RADIUS,
    );
    // Rows [2,6): edges at y=2 and y=6; texel y=3 (center 3.5) is 1.5 px
    // from either edge.
    expect(decodeSdf(sdf[3 * 24 + 12], RADIUS)).toBeCloseTo(1.5, 0);
  });

  it("handles empty rasters (no ink)", () => {
    const sdf = sdfFromRasterizedGlyph(
      new Uint8Array(16 * 16 * 4),
      16,
      16,
      4,
      RADIUS,
    );
    // Everywhere far outside.
    for (const byte of sdf) expect(byte).toBe(0);
  });

  it("rejects dimensions not divisible by the supersampling factor", () => {
    expect(() =>
      sdfFromRasterizedGlyph(new Uint8Array(15 * 16 * 4), 15, 16, 4, RADIUS),
    ).toThrow();
  });

  it("scales supersampling down as the atlas resolution takes over", () => {
    expect(supersampleForFontPx(12)).toBe(4);
    expect(supersampleForFontPx(24)).toBe(4);
    expect(supersampleForFontPx(64)).toBe(2);
    expect(supersampleForFontPx(256)).toBe(1);
  });

  it("is smooth across the field (no lumpy quantization)", () => {
    // Along a horizontal line through a rect edge, consecutive texel
    // distances should step by ~1 px each -- large jumps or plateaus are the
    // lumpiness artifact.
    for (const ss of [4, 2]) {
      const sdf = sdfFromRasterizedGlyph(
        rectRaster(16 * ss, 16 * ss, 4 * ss, 4 * ss, 12 * ss, 12 * ss),
        16 * ss,
        16 * ss,
        ss,
        8,
      );
      const dist = (x: number) => decodeSdf(sdf[8 * 16 + x], 8);
      for (let x = 1; x < 8; x++) {
        const step = dist(x) - dist(x - 1);
        expect(step).toBeGreaterThan(0.8);
        expect(step).toBeLessThan(1.2);
      }
    }
  });
});
