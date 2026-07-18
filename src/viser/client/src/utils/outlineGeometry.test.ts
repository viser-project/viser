// Pins the ownership contract of buildOutlineGeometry against three-stdlib's
// toCreasedNormals, whose subtle behavior caused a real dispose-of-shared-
// geometry bug: it returns its INPUT object unchanged (and rewrites its
// normal attribute in place) when the input is already non-indexed, so
// "angle != 0 => we own a fresh clone" is false without the clone step.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { toCreasedNormals } from "three-stdlib";
import { buildOutlineGeometry } from "./outlineGeometry";

/** A unit quad as two indexed triangles. */
function indexedGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      3,
    ),
  );
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

function nonIndexedGeometry(): THREE.BufferGeometry {
  const g = indexedGeometry().toNonIndexed();
  g.computeVertexNormals();
  return g;
}

describe("buildOutlineGeometry ownership", () => {
  it("angle 0: shares the parent's geometry, not owned", () => {
    const parent = indexedGeometry();
    const built = buildOutlineGeometry(parent, 0);
    expect(built.geometry).toBe(parent);
    expect(built.owned).toBe(false);
  });

  it("indexed parent: creased result is a fresh owned object", () => {
    const parent = indexedGeometry();
    const built = buildOutlineGeometry(parent, Math.PI);
    expect(built.geometry).not.toBe(parent);
    expect(built.owned).toBe(true);
  });

  it("NON-indexed parent: still owned, and the parent is untouched", () => {
    // The library premise this module exists to fence: toCreasedNormals
    // returns a non-indexed input as-is. If a three-stdlib upgrade changes
    // this, the clone in buildOutlineGeometry becomes redundant but stays
    // correct; if this test starts failing here, re-derive the ownership
    // rules before touching the clone.
    const raw = nonIndexedGeometry();
    expect(toCreasedNormals(raw, Math.PI)).toBe(raw);

    const parent = nonIndexedGeometry();
    const normalsBefore = Array.from(
      (parent.getAttribute("normal") as THREE.BufferAttribute).array,
    );
    const built = buildOutlineGeometry(parent, Math.PI);
    expect(built.geometry).not.toBe(parent);
    expect(built.owned).toBe(true);
    // Creasing mutates normals in place on its input; the clone must have
    // absorbed that so the parent's live normals are unchanged.
    expect(
      Array.from(
        (parent.getAttribute("normal") as THREE.BufferAttribute).array,
      ),
    ).toEqual(normalsBefore);
    built.geometry.dispose();
  });
});
