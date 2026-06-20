import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { syncBufferGeometry } from "./bufferGeometrySync";

/**
 * A faithful, GL-context-free model of three.js's WebGLAttributes update path
 * (renderers/webgl/WebGLAttributes.js) plus the geometry-dispose cleanup
 * (WebGLGeometries.onGeometryDispose). vitest runs in Node with no WebGL2
 * context, so a real renderer can't exercise the resize guard -- this model
 * reproduces exactly the branch that throws, and the dispose path that avoids
 * it, keyed off the same attribute objects our sync code mutates.
 */
function makeFakeRenderer(geometry: THREE.BufferGeometry) {
  // Mirrors WebGLAttributes' `buffers` WeakMap (a plain Map here so the test can
  // observe it). Value tracks the GL buffer's allocated byte size and version.
  const uploaded = new Map<object, { size: number; version: number }>();
  let deleteBufferCalls = 0;

  // three frees an attribute's GL buffer only via the geometry 'dispose' event.
  geometry.addEventListener("dispose", () => {
    const drop = (attr: { array: { byteLength: number } } | null) => {
      if (attr && uploaded.has(attr)) {
        uploaded.delete(attr);
        deleteBufferCalls++;
      }
    };
    drop(geometry.getIndex());
    for (const name in geometry.attributes) drop(geometry.attributes[name]);
  });

  // Mirrors WebGLAttributes.update(): create on first sight, else re-upload --
  // and throw if a live buffer's size changed (the bug we're guarding against).
  function uploadAttribute(attr: THREE.BufferAttribute) {
    const cached = uploaded.get(attr);
    if (cached === undefined) {
      uploaded.set(attr, {
        size: attr.array.byteLength,
        version: attr.version,
      });
      return;
    }
    if (cached.version < attr.version) {
      if (cached.size !== attr.array.byteLength) {
        throw new Error(
          "THREE.WebGLAttributes: The size of the buffer attribute's array " +
            "buffer does not match the original size. Resizing buffer " +
            "attributes is not supported.",
        );
      }
      cached.version = attr.version;
    }
  }

  return {
    /** Simulate a render: upload index + every attribute. */
    render() {
      const index = geometry.getIndex();
      if (index) uploadAttribute(index);
      for (const name in geometry.attributes) {
        uploadAttribute(geometry.attributes[name] as THREE.BufferAttribute);
      }
    },
    liveBufferCount: () => uploaded.size,
    deleteBufferCalls: () => deleteBufferCalls,
  };
}

describe("syncBufferGeometry", () => {
  it("reuses attribute objects in place when the layout is unchanged", () => {
    const geom = new THREE.BufferGeometry();
    const realloc1 = syncBufferGeometry(geom, {
      position: { array: new Float32Array([0, 0, 0, 1, 1, 1]), itemSize: 3 },
    });
    expect(realloc1).toBe(true); // first call always allocates
    const pos1 = geom.getAttribute("position") as THREE.BufferAttribute;
    const version = pos1.version;

    const newPoints = new Float32Array([2, 2, 2, 3, 3, 3]);
    const realloc2 = syncBufferGeometry(geom, {
      position: { array: newPoints, itemSize: 3 },
    });
    expect(realloc2).toBe(false); // same layout -> reuse
    expect(geom.getAttribute("position")).toBe(pos1); // same object -> same GL buffer
    expect(geom.getAttribute("position").array).toBe(newPoints); // data swapped in
    expect(pos1.version).toBeGreaterThan(version); // re-upload requested
  });

  it("disposes once on a length change so the old GL buffers are freed", () => {
    const geom = new THREE.BufferGeometry();
    syncBufferGeometry(geom, {
      position: { array: new Float32Array(6), itemSize: 3 },
    });
    const disposeSpy = vi.spyOn(geom, "dispose");

    const realloc = syncBufferGeometry(geom, {
      position: { array: new Float32Array(9), itemSize: 3 },
    });
    expect(realloc).toBe(true);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(geom.getAttribute("position").count).toBe(3);
  });

  it("reallocates on a precision change (float32 <-> float16)", () => {
    const geom = new THREE.BufferGeometry();
    syncBufferGeometry(geom, {
      position: { array: new Float32Array(6), itemSize: 3 },
    });
    const pos1 = geom.getAttribute("position");

    syncBufferGeometry(geom, {
      position: { array: new Uint16Array(6), itemSize: 3, float16: true },
    });
    const pos2 = geom.getAttribute("position");
    expect(pos2).not.toBe(pos1);
    expect(
      (pos2 as unknown as { isFloat16BufferAttribute?: boolean })
        .isFloat16BufferAttribute,
    ).toBe(true);
  });

  it("syncs an index buffer alongside attributes", () => {
    const geom = new THREE.BufferGeometry();
    syncBufferGeometry(
      geom,
      { position: { array: new Float32Array(9), itemSize: 3 } },
      new Uint32Array([0, 1, 2]),
    );
    expect(geom.getIndex()!.count).toBe(3);

    // Same-length index -> reuse.
    const idx1 = geom.getIndex();
    const realloc = syncBufferGeometry(
      geom,
      { position: { array: new Float32Array(9), itemSize: 3 } },
      new Uint32Array([2, 1, 0]),
    );
    expect(realloc).toBe(false);
    expect(geom.getIndex()).toBe(idx1);
  });

  // The core regression: against a faithful model of three's WebGLAttributes,
  // resizing must NOT throw, and old buffers must be freed (not leaked).
  describe("matches three.js WebGLAttributes semantics", () => {
    it("does not throw when the point count changes", () => {
      const geom = new THREE.BufferGeometry();
      const gpu = makeFakeRenderer(geom);

      syncBufferGeometry(geom, {
        position: { array: new Float32Array(6), itemSize: 3 },
        color: { array: new Uint8Array(6), itemSize: 3, normalized: true },
      });
      gpu.render();
      expect(gpu.liveBufferCount()).toBe(2);

      // Grow the cloud: this is the exact scenario that used to throw.
      syncBufferGeometry(geom, {
        position: { array: new Float32Array(9), itemSize: 3 },
        color: { array: new Uint8Array(9), itemSize: 3, normalized: true },
      });
      expect(() => gpu.render()).not.toThrow();
      expect(gpu.deleteBufferCalls()).toBe(2); // old buffers freed, not leaked
      expect(gpu.liveBufferCount()).toBe(2); // recreated at new size
    });

    it("reuses buffers (no dispose, no new buffers) on same-size updates", () => {
      const geom = new THREE.BufferGeometry();
      const gpu = makeFakeRenderer(geom);
      syncBufferGeometry(geom, {
        position: { array: new Float32Array(6), itemSize: 3 },
      });
      gpu.render();

      for (let i = 0; i < 100; i++) {
        syncBufferGeometry(geom, {
          position: { array: new Float32Array(6), itemSize: 3 },
        });
        gpu.render();
      }
      expect(gpu.deleteBufferCalls()).toBe(0); // never disposed
      expect(gpu.liveBufferCount()).toBe(1); // same single buffer throughout
    });

    // Negative control: prove the model actually catches the bug. The old
    // in-place-without-dispose approach DOES throw under the same model.
    it("(control) naive resize without dispose throws under the model", () => {
      const geom = new THREE.BufferGeometry();
      const gpu = makeFakeRenderer(geom);
      const attr = new THREE.BufferAttribute(new Float32Array(6), 3);
      geom.setAttribute("position", attr);
      gpu.render();

      // Mutate in place to a different length WITHOUT disposing -- the bug.
      attr.array = new Float32Array(9);
      (attr as { count: number }).count = 3;
      attr.needsUpdate = true;
      expect(() => gpu.render()).toThrow(/Resizing buffer attributes/);
    });
  });
});
