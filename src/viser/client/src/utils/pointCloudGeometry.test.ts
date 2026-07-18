import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { syncPointCloudGeometry } from "./pointCloudGeometry";

// Reusing the same BufferAttribute object across updates is what keeps the
// underlying WebGL buffer alive and reused. Allocating a fresh
// BufferAttribute on every update (the old behavior) orphans the previous GPU
// buffer -- three.js tracks buffers in a WeakMap keyed by the attribute and
// never calls gl.deleteBuffer on a replaced attribute, so it leaks until
// (maybe) GC. Asserting object identity is a GL-context-free proxy for "no new
// GPU buffer was allocated".
describe("syncPointCloudGeometry", () => {
  it("reuses the position/color BufferAttributes across same-precision updates", () => {
    const geom = new THREE.BufferGeometry();
    syncPointCloudGeometry(
      geom,
      new Float32Array([0, 0, 0, 1, 1, 1]),
      new Uint8Array([255, 0, 0, 0, 255, 0]),
    );
    const pos1 = geom.getAttribute("position") as THREE.BufferAttribute;
    const col1 = geom.getAttribute("color");
    const posVersion = pos1.version;

    const newPoints = new Float32Array([2, 2, 2, 3, 3, 3]);
    syncPointCloudGeometry(
      geom,
      newPoints,
      new Uint8Array([0, 0, 255, 255, 255, 0]),
    );

    expect(geom.getAttribute("position")).toBe(pos1); // same object -> same GPU buffer
    expect(geom.getAttribute("color")).toBe(col1);
    expect(geom.getAttribute("position").array).toBe(newPoints); // data swapped in
    // needsUpdate is a write-only setter that bumps version; check the version
    // advanced so three re-uploads the buffer.
    expect(pos1.version).toBeGreaterThan(posVersion);
  });

  it("updates the attribute count when the point count changes", () => {
    const geom = new THREE.BufferGeometry();
    syncPointCloudGeometry(geom, new Float32Array(6), new Uint8Array(6));
    syncPointCloudGeometry(geom, new Float32Array(9), new Uint8Array(9));
    expect(geom.getAttribute("position").count).toBe(3);
    expect(geom.getAttribute("color").count).toBe(3);
  });

  it("allocates a new attribute only when precision changes (float32 <-> float16)", () => {
    const geom = new THREE.BufferGeometry();
    syncPointCloudGeometry(geom, new Float32Array(6), new Uint8Array(6));
    const pos1 = geom.getAttribute("position");
    syncPointCloudGeometry(geom, new Uint16Array(6), new Uint8Array(6)); // float16
    expect(geom.getAttribute("position")).not.toBe(pos1);
  });
});
