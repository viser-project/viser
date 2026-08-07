import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { InstancedMesh2 } from "./InstancedMesh2.js";
// The feature modules (Instances, LOD, Capacity, ...) register their
// prototype extensions (addInstances / addLOD / ...) at import time; the
// package index imports them all, exactly as production code does.
import "../index.js";

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
    bufferSubData() {},
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

  it("survives a post-dispose shadow pass (shadow maps render BEFORE the main pass, so onBeforeShadow is the first hook a late frame hits)", () => {
    const { gl } = makeMockGl();
    // onBeforeShadow runs patchMaterial + updateTextures before the gate under
    // test, so the renderer mock needs the properties/initTexture surface those
    // touch. patchMaterial swaps properties.get wholesale; updateTextures takes
    // the initTexture branch when the (empty) texture properties record has no
    // __webglTexture.
    const renderer = {
      getContext: () => gl,
      properties: { get: () => ({}) },
      initTexture: () => {},
      capabilities: { maxTextures: 16 },
      info: { render: { frame: 1 } },
    } as unknown as THREE.WebGLRenderer;

    const mesh = new InstancedMesh2(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial(),
      { capacity: 128, renderer },
    );
    // A live instance keeps `count` positive: pre-fix, the disposed-mesh crash
    // needed count > 0 to get past the early return and dereference the nulled
    // instanceIndex.
    mesh.addInstances(1, () => {});

    const shadowArgs = [
      renderer,
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
      new THREE.PerspectiveCamera(),
      mesh.geometry,
      new THREE.MeshDepthMaterial(),
      null,
    ] as const;

    // Sanity: a live mesh's shadow hook runs without throwing. Pair it with
    // onAfterShadow exactly like a real shadow pass does -- it restores the
    // properties.get that patchMaterial swapped in, without which the second
    // patch would wrap its own callback and recurse.
    expect(() => mesh.onBeforeShadow(...shadowArgs)).not.toThrow();
    mesh.onAfterShadow(...shadowArgs);

    mesh.dispose();

    // The late frame's shadow pass must be a no-op, not a TypeError: culling
    // is skipped (instanceIndex null) so `count` keeps its stale positive
    // value, and pre-fix the unconditional instanceIndex.update() crashed the
    // frame inside WebGLShadowMap.render.
    expect(() => mesh.onBeforeShadow(...shadowArgs)).not.toThrow();
  });

  it("clears every LOD level's own geometry on dispose (LOD levels are separate meshes with per-level geometries)", () => {
    const { gl, stats } = makeMockGl();
    const renderer = { getContext: () => gl } as unknown as THREE.WebGLRenderer;

    const mesh = new InstancedMesh2(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial(),
      { capacity: 64, renderer },
    );
    mesh.addLOD(
      new THREE.BoxGeometry(0.5, 0.5, 0.5),
      new THREE.MeshBasicMaterial(),
      10,
    );

    const child = mesh.LODinfo!.objects.find((obj) => obj !== mesh)!;
    expect(child).toBeDefined();
    expect(child.geometry.getAttribute("instanceIndex")).toBeDefined();

    mesh.dispose();

    // Both the child's buffer and its geometry's retained attribute must go:
    // a late frame drawing the LOD level binds through the CHILD's geometry,
    // so leaving the attribute there re-binds the freed buffer even though
    // the reference on the mesh was nulled.
    expect(child.instanceIndex).toBeNull();
    expect(child.geometry.getAttribute("instanceIndex")).toBeUndefined();
    expect(mesh.geometry.getAttribute("instanceIndex")).toBeUndefined();
    expect(stats().live).toBe(0);
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
