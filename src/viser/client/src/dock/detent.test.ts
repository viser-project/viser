// Pins for the pure content-height detent math (detent.ts, spec section 6 /
// D56): in-band snaps, out-of-band passes through, nearest detent wins, exact
// landings, and the inclusive band edge the window grip's original magnet
// used.

import { describe, expect, it } from "vitest";
import { snapToDetent } from "./detent";

const BAND = 12;

describe("snapToDetent", () => {
  it("snaps a value inside the band onto the detent", () => {
    expect(snapToDetent(105, [100], BAND)).toEqual({
      value: 100,
      snapped: true,
    });
    expect(snapToDetent(95, [100], BAND)).toEqual({
      value: 100,
      snapped: true,
    });
  });

  it("passes an out-of-band value through unchanged", () => {
    expect(snapToDetent(113, [100], BAND)).toEqual({
      value: 113,
      snapped: false,
    });
    expect(snapToDetent(80, [100], BAND)).toEqual({
      value: 80,
      snapped: false,
    });
  });

  it("band edge is inclusive (distance == band snaps; the grip's <=)", () => {
    expect(snapToDetent(112, [100], BAND)).toEqual({
      value: 100,
      snapped: true,
    });
    expect(snapToDetent(88, [100], BAND)).toEqual({
      value: 100,
      snapped: true,
    });
    expect(snapToDetent(112.01, [100], BAND).snapped).toBe(false);
  });

  it("nearest detent wins when both flanks are in band", () => {
    // Both detents within 12 of value 6: |6-0|=6, |6-10|=4 -> 10 wins.
    expect(snapToDetent(6, [0, 10], BAND)).toEqual({
      value: 10,
      snapped: true,
    });
    // Mirrored: 4 is nearer 0.
    expect(snapToDetent(4, [0, 10], BAND)).toEqual({ value: 0, snapped: true });
  });

  it("exact tie goes to the earlier-listed detent", () => {
    expect(snapToDetent(5, [0, 10], BAND)).toEqual({ value: 0, snapped: true });
    expect(snapToDetent(5, [10, 0], BAND)).toEqual({
      value: 10,
      snapped: true,
    });
  });

  it("exact landing on a detent reports snapped", () => {
    expect(snapToDetent(100, [100], BAND)).toEqual({
      value: 100,
      snapped: true,
    });
    expect(snapToDetent(0, [0], BAND)).toEqual({ value: 0, snapped: true });
  });

  it("works on negative deltas (divider dragged up)", () => {
    expect(snapToDetent(-178, [-185], BAND)).toEqual({
      value: -185,
      snapped: true,
    });
    expect(snapToDetent(-193, [-185], BAND)).toEqual({
      value: -185,
      snapped: true,
    });
    expect(snapToDetent(-220, [-185], BAND).snapped).toBe(false);
  });

  it("no detents -> never snaps", () => {
    expect(snapToDetent(3, [], BAND)).toEqual({ value: 3, snapped: false });
  });
});
