import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  needsReversedDepthSortFix,
  primeCamera,
  reversedDepthOpaqueSort,
  reversedDepthTransparentSort,
} from "./ReversedDepthSort";

/** Build a render item shaped like three's `WebGLRenderList` entries. */
function item(overrides: {
  id?: number;
  groupOrder?: number;
  renderOrder?: number;
  z?: number;
  materialId?: number;
  materialVariant?: number;
}) {
  return {
    id: overrides.id ?? 0,
    groupOrder: overrides.groupOrder ?? 0,
    renderOrder: overrides.renderOrder ?? 0,
    z: overrides.z ?? 0,
    material: { id: overrides.materialId ?? 0 } as any,
    materialVariant: overrides.materialVariant ?? 0,
  };
}

/** Sort, then reverse: what three does when the depth buffer is reversed. */
function sortAndFlip<T>(items: T[], sort: (a: T, b: T) => number): T[] {
  return [...items].sort(sort).reverse();
}

describe("reversed-depth render list sorting", () => {
  it("draws higher renderOrder last in the opaque list", () => {
    const items = [
      item({ id: 1, renderOrder: 0 }),
      item({ id: 2, renderOrder: 10000 }),
      item({ id: 3, renderOrder: 500 }),
    ];
    expect(
      sortAndFlip(items, reversedDepthOpaqueSort).map((i) => i.renderOrder),
    ).toEqual([0, 500, 10000]);
  });

  it("draws higher renderOrder last in the transparent list", () => {
    // The label case from #767: the white background quad (9999) has to be
    // drawn before the text (10000), or it paints over it.
    const items = [
      item({ id: 1, renderOrder: 10000 }),
      item({ id: 2, renderOrder: 9999 }),
    ];
    expect(
      sortAndFlip(items, reversedDepthTransparentSort).map(
        (i) => i.renderOrder,
      ),
    ).toEqual([9999, 10000]);
  });

  it("orders by groupOrder ahead of renderOrder", () => {
    const items = [
      item({ id: 1, groupOrder: 1, renderOrder: 0 }),
      item({ id: 2, groupOrder: 0, renderOrder: 10000 }),
    ];
    expect(
      sortAndFlip(items, reversedDepthTransparentSort).map((i) => [
        i.groupOrder,
        i.renderOrder,
      ]),
    ).toEqual([
      [0, 10000],
      [1, 0],
    ]);
  });

  it("keeps three's depth ordering within one renderOrder", () => {
    // `z` is the projected depth, which has flipped sign under a reversed
    // depth buffer: larger is nearer. Opaque draws near-to-far, transparent
    // far-to-near.
    const items = [
      item({ id: 1, z: 0.2 }),
      item({ id: 2, z: 0.9 }),
      item({ id: 3, z: 0.5 }),
    ];
    expect(sortAndFlip(items, reversedDepthOpaqueSort).map((i) => i.z)).toEqual(
      [0.9, 0.5, 0.2],
    );
    expect(
      sortAndFlip(items, reversedDepthTransparentSort).map((i) => i.z),
    ).toEqual([0.2, 0.5, 0.9]);
  });

  it("groups opaque draws by material within one renderOrder", () => {
    const items = [
      item({ id: 1, materialId: 7, z: 0.1 }),
      item({ id: 2, materialId: 3, z: 0.9 }),
      item({ id: 3, materialId: 7, z: 0.5 }),
    ];
    expect(
      sortAndFlip(items, reversedDepthOpaqueSort).map((i) => i.material.id),
    ).toEqual([3, 7, 7]);
  });

  it("is a total order, so the sort is deterministic", () => {
    const items = [item({ id: 3 }), item({ id: 1 }), item({ id: 2 })];
    expect(
      sortAndFlip(items, reversedDepthOpaqueSort).map((i) => i.id),
    ).toEqual([1, 2, 3]);
    expect(
      sortAndFlip(items, reversedDepthTransparentSort).map((i) => i.id),
    ).toEqual([1, 2, 3]);
  });

  it("only applies to r185 with a reversed depth buffer", () => {
    // r185 is the one release that reverses its sorted render lists; r186
    // negates the projected z instead (mrdoob/three.js#33945), so compensating
    // there would invert renderOrder rather than fix it.
    expect(needsReversedDepthSortFix("185", true)).toBe(true);
    expect(needsReversedDepthSortFix("185", false)).toBe(false);
    expect(needsReversedDepthSortFix("184", true)).toBe(false);
    expect(needsReversedDepthSortFix("186", true)).toBe(false);
  });

  it("primes a camera's reversedDepth flag before three would", () => {
    // three only sets this lazily in setProgram(), which runs after sort().
    // get_render builds a fresh camera per request, so without priming every
    // capture sorts with the flag still false and lands un-flipped.
    const camera = new THREE.PerspectiveCamera(50, 1.5, 0.1, 100);
    expect(camera.reversedDepth).toBe(false);
    const before = camera.projectionMatrix.elements.slice();

    primeCamera(camera);

    expect(camera.reversedDepth).toBe(true);
    // The projection matrix has to be rebuilt for the flag to mean anything.
    expect(Array.from(camera.projectionMatrix.elements)).not.toEqual(
      Array.from(before),
    );

    // Idempotent: priming an already-primed camera is a no-op.
    const after = camera.projectionMatrix.elements.slice();
    primeCamera(camera);
    expect(Array.from(camera.projectionMatrix.elements)).toEqual(
      Array.from(after),
    );
  });
});
