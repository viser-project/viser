import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { computeBoundingSphere, computeVertexNormals } from "./meshGeometry";

function randomGeometry(numVertices: number, numFaces: number) {
  // Deterministic pseudorandom values.
  let state = 1;
  const random = () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
  const positions = Float32Array.from(
    { length: numVertices * 3 },
    () => random() * 2 - 1,
  );
  const faces = Uint32Array.from({ length: numFaces * 3 }, () =>
    Math.floor(random() * numVertices),
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(faces, 1));
  return { positions, faces, geometry };
}

describe("computeVertexNormals", () => {
  it("matches three.js", () => {
    const { positions, faces, geometry } = randomGeometry(100, 300);
    geometry.computeVertexNormals();
    const expected = geometry.attributes.normal.array;
    const actual = computeVertexNormals(positions, faces);
    for (let i = 0; i < expected.length; i++)
      expect(actual[i]).toBeCloseTo(expected[i], 4);
  });

  it("clears reused arrays, and leaves unreferenced vertices at zero", () => {
    const { positions, faces } = randomGeometry(100, 10);
    const expected = computeVertexNormals(positions, faces);
    const out = new Float32Array(300).fill(7);
    expect(computeVertexNormals(positions, faces, out)).toBe(out);
    expect(out).toEqual(expected);
    expect(out.every(Number.isFinite)).toBe(true);
  });
});

describe("computeBoundingSphere", () => {
  it("matches three.js", () => {
    const { positions, geometry } = randomGeometry(100, 1);
    geometry.computeBoundingSphere();
    const sphere = computeBoundingSphere(positions);
    expect(sphere.radius).toBeCloseTo(geometry.boundingSphere!.radius, 5);
    expect(
      sphere.center.distanceTo(geometry.boundingSphere!.center),
    ).toBeCloseTo(0, 5);
  });

  it("handles empty inputs", () => {
    expect(computeBoundingSphere(new Float32Array(0)).radius).toBeLessThan(0);
  });
});
