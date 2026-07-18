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

  // Regression: switching per-point colors -> uniform (3-length) colors must
  // remove the stale N-length 'color' attribute. three.js re-uploads every
  // registered attribute regardless of whether the material samples it, so a
  // leftover attribute costs bandwidth every render and serves stale data if
  // per-point colors come back at a matching length.
  describe("per-point -> uniform color transition", () => {
    // Minimal model of three's WebGLAttributes + WebGLGeometries.onGeometryDispose
    // (same shape as the one in bufferGeometrySync.test.ts): buffers are freed
    // ONLY via the geometry 'dispose' event, and only for attributes still
    // present on the geometry when it fires.
    function makeFakeRenderer(geometry: THREE.BufferGeometry) {
      const uploaded = new Map<object, { size: number; version: number }>();
      let deleteBufferCalls = 0;
      geometry.addEventListener("dispose", () => {
        for (const name in geometry.attributes) {
          const attr = geometry.attributes[name];
          if (uploaded.has(attr)) {
            uploaded.delete(attr);
            deleteBufferCalls++;
          }
        }
      });
      return {
        render() {
          for (const name in geometry.attributes) {
            const attr = geometry.attributes[name] as THREE.BufferAttribute;
            const cached = uploaded.get(attr);
            if (cached === undefined) {
              uploaded.set(attr, {
                size: attr.array.byteLength,
                version: attr.version,
              });
            } else if (cached.version < attr.version) {
              if (cached.size !== attr.array.byteLength) {
                throw new Error(
                  "THREE.WebGLAttributes: Resizing buffer attributes is not supported.",
                );
              }
              cached.version = attr.version;
            }
          }
        },
        liveBufferCount: () => uploaded.size,
        deleteBufferCalls: () => deleteBufferCalls,
      };
    }

    it("removes the stale color attribute (same point count)", () => {
      const geom = new THREE.BufferGeometry();
      const gpu = makeFakeRenderer(geom);

      // Per-point colors: both attributes registered and uploaded.
      syncPointCloudGeometry(geom, new Float32Array(6), new Uint8Array(6));
      gpu.render();
      expect(geom.hasAttribute("color")).toBe(true);
      expect(gpu.liveBufferCount()).toBe(2);

      // Uniform color, same point count.
      syncPointCloudGeometry(geom, new Float32Array(6), new Uint8Array(3));
      expect(geom.hasAttribute("color")).toBe(false);
      expect(() => gpu.render()).not.toThrow();
      // Dispose fired BEFORE deleteAttribute, so the color GL buffer was
      // deterministically freed (not stranded until GC); position was then
      // re-uploaded into a fresh buffer.
      expect(gpu.deleteBufferCalls()).toBe(2);
      expect(gpu.liveBufferCount()).toBe(1); // position only
    });

    it("removes the stale color attribute (point count also changed)", () => {
      const geom = new THREE.BufferGeometry();
      syncPointCloudGeometry(
        geom,
        new Float32Array(3000),
        new Uint8Array(3000),
      );
      syncPointCloudGeometry(geom, new Float32Array(900), new Uint8Array(3));
      expect(geom.hasAttribute("color")).toBe(false);
      expect(geom.getAttribute("position").count).toBe(300);
    });

    it("re-adds the color attribute when per-point colors return", () => {
      const geom = new THREE.BufferGeometry();
      syncPointCloudGeometry(geom, new Float32Array(6), new Uint8Array(3));
      expect(geom.hasAttribute("color")).toBe(false);
      syncPointCloudGeometry(geom, new Float32Array(6), new Uint8Array(6));
      expect(geom.hasAttribute("color")).toBe(true);
      expect(geom.getAttribute("color").count).toBe(2);
    });
  });
});
