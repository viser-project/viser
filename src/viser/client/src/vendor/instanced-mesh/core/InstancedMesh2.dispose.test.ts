import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { InstancedMesh2 } from "./InstancedMesh2.js";

// Minimal WebGL2 mock that only implements the buffer calls
// GLInstancedBufferAttribute touches, plus counters so we can assert that the
// raw `instanceIndex` GL buffer is freed deterministically (i.e. the code does
// NOT rely on the JS garbage collector to reclaim GPU memory).
function makeMockGl() {
  let created = 0;
  let deleted = 0;
  const live = new Set<object>();
  const gl = {
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_DRAW: 0x88e8,
    UNSIGNED_INT: 0x1405,
    createBuffer() {
      created++;
      const buffer = { id: created };
      live.add(buffer);
      return buffer;
    },
    bindBuffer() {},
    bufferData() {},
    deleteBuffer(buffer: object) {
      deleted++;
      live.delete(buffer);
    },
  };
  return { gl, stats: () => ({ created, deleted, live: live.size }) };
}

describe("InstancedMesh2 GPU buffer disposal", () => {
  it("frees the instanceIndex GL buffer on dispose (no reliance on GC)", () => {
    const { gl, stats } = makeMockGl();
    const renderer = { getContext: () => gl } as unknown as THREE.WebGLRenderer;

    const mesh = new InstancedMesh2(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial(),
      { capacity: 128, renderer },
    );

    // Construction allocates exactly one raw GL buffer (instanceIndex).
    expect(stats().created).toBe(1);
    expect(stats().live).toBe(1);

    mesh.dispose();

    // dispose() must explicitly delete that buffer -- three.js never tracks it,
    // so without an explicit deleteBuffer it leaks until (maybe) GC.
    expect(stats().deleted).toBe(1);
    expect(stats().live).toBe(0);
  });

  it("nulls instanceIndex on dispose so a late frame re-inits instead of binding the deleted buffer", () => {
    const { gl, stats } = makeMockGl();
    // onAfterRender's unpatchMaterial touches renderer.properties, so the mock
    // needs the object to exist (its `get` is only restored, never called).
    const renderer = {
      getContext: () => gl,
      properties: { get: undefined },
    } as unknown as THREE.WebGLRenderer;

    const mesh = new InstancedMesh2(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial(),
      { capacity: 128, renderer },
    );
    expect(mesh.instanceIndex).not.toBeNull();

    mesh.dispose();

    // The reference must be dropped along with the GL buffer: onBeforeRender /
    // onAfterRender gate on falsiness, so a dangling reference would bind a
    // deleted buffer on a frame drawn before React commits the unmount -- and
    // permanently skip the re-init branch.
    expect(mesh.instanceIndex).toBeNull();
    // The geometry must not retain the deleted buffer either.
    expect(mesh.geometry.getAttribute("instanceIndex")).toBeUndefined();

    // A post-dispose render takes the initIndexAttribute re-init branch,
    // allocating a fresh GL buffer and re-registering the geometry attribute.
    mesh.onAfterRender(
      renderer,
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
      mesh.geometry,
      new THREE.MeshBasicMaterial(),
      null,
    );
    expect(mesh.instanceIndex).not.toBeNull();
    expect(mesh.geometry.getAttribute("instanceIndex")).toBeDefined();
    expect(stats().created).toBe(2); // initial + re-init
    expect(stats().live).toBe(1); // only the re-init buffer survives
  });

  it("does not leak instanceIndex buffers across repeated create/dispose", () => {
    const { gl, stats } = makeMockGl();
    const renderer = { getContext: () => gl } as unknown as THREE.WebGLRenderer;

    // Simulates BatchedMeshBase rebuilding the mesh on every geometry change.
    for (let i = 0; i < 50; i++) {
      const mesh = new InstancedMesh2(
        new THREE.BoxGeometry(),
        new THREE.MeshBasicMaterial(),
        { capacity: 64, renderer },
      );
      mesh.dispose();
    }

    const s = stats();
    expect(s.created).toBe(50);
    expect(s.deleted).toBe(50); // net zero live buffers
    expect(s.live).toBe(0);
  });
});
