import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  createBackToFrontSort,
  isTransparentMaterial,
} from "./batchedDepthSort";
import type { InstancedRenderItem } from "../vendor/instanced-mesh/index.js";

function renderList(depths: number[]): InstancedRenderItem[] {
  return depths.map((depth, index) => ({ index, depth, depthSort: 0 }));
}

function orderOf(list: InstancedRenderItem[]): number[] {
  return list.map((item) => item.index);
}

describe("isTransparentMaterial", () => {
  it("reads the flag off a single material", () => {
    const material = new THREE.MeshStandardMaterial();
    expect(isTransparentMaterial(material)).toBe(false);
    material.transparent = true;
    expect(isTransparentMaterial(material)).toBe(true);
  });

  it("treats a multi-material array as transparent if any slot blends", () => {
    const opaque = new THREE.MeshStandardMaterial();
    const blended = new THREE.MeshStandardMaterial({ transparent: true });
    expect(isTransparentMaterial([opaque, opaque])).toBe(false);
    // The case the vendor's own sort factory gets wrong: `material.transparent`
    // is undefined on an array, so it would sort these front-to-back.
    expect(isTransparentMaterial([opaque, blended])).toBe(true);
  });
});

describe("createBackToFrontSort", () => {
  it("orders instances farthest-first", () => {
    const sort = createBackToFrontSort();
    const list = renderList([1.0, 5.0, 3.0, 2.0]);
    sort(list);
    expect(orderOf(list)).toEqual([1, 2, 3, 0]);
    expect(list.map((item) => item.depth)).toEqual([5.0, 3.0, 2.0, 1.0]);
  });

  it("handles negative depths, from instances behind the camera plane", () => {
    const sort = createBackToFrontSort();
    const list = renderList([-4.0, 2.0, -1.5, 0.0]);
    sort(list);
    expect(list.map((item) => item.depth)).toEqual([2.0, 0.0, -1.5, -4.0]);
  });

  it("sorts counts large enough to exercise every radix pass", () => {
    const sort = createBackToFrontSort();
    // Pseudo-random but deterministic depths; >32 items so radixSort takes
    // its bucketing path rather than the small-block insertion sort.
    const depths = Array.from(
      { length: 500 },
      (_, i) => ((i * 7919) % 1000) / 10 - 50,
    );
    const list = renderList(depths);
    sort(list);
    expect(list.length).toBe(500);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].depth).toBeGreaterThanOrEqual(list[i].depth);
    }
    // Every instance survives the sort exactly once.
    expect(new Set(orderOf(list)).size).toBe(500);
  });

  it("reuses its scratch buffer across calls of growing size", () => {
    const sort = createBackToFrontSort();
    sort(renderList([1.0, 2.0]));
    const list = renderList(
      Array.from({ length: 200 }, (_, i) => (i * 37) % 200),
    );
    sort(list);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].depth).toBeGreaterThanOrEqual(list[i].depth);
    }
  });

  it("leaves degenerate depth spans alone", () => {
    const sort = createBackToFrontSort();

    // All instances equidistant: no ordering carries information, and the
    // rescale factor would be Infinity.
    const equal = renderList([2.0, 2.0, 2.0]);
    sort(equal);
    expect(orderOf(equal)).toEqual([0, 1, 2]);

    // An infinite depth makes the whole span infinite, so nothing is keyed.
    const withInf = renderList([1.0, Infinity, 3.0]);
    sort(withInf);
    expect(orderOf(withInf)).toEqual([0, 1, 2]);
  });

  it("sinks a NaN depth to the back without scrambling the rest", () => {
    const sort = createBackToFrontSort();
    const list = renderList([1.0, NaN, 3.0]);
    sort(list);
    // The degenerate instance keys to 0 and lands last; the real instances
    // keep their farthest-first order.
    expect(orderOf(list)).toEqual([2, 0, 1]);
  });

  it("is a no-op below two instances", () => {
    const sort = createBackToFrontSort();
    const single = renderList([4.0]);
    sort(single);
    expect(orderOf(single)).toEqual([0]);
    const empty = renderList([]);
    sort(empty);
    expect(empty).toEqual([]);
  });
});
