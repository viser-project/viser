import { describe, it, expect } from "vitest";
import * as THREE from "three";
// Import via the package index so the prototype-augmentation feature modules
// (Instances.ts, FrustumCulling.ts, LOD.ts, ...) are registered.
import { InstancedMesh2, createRadixSort } from "../index.js";
import { createBackToFrontRadixSort } from "../../../mesh/backToFrontRadixSort";

// Minimal WebGL2 mock covering the buffer calls GLInstancedBufferAttribute
// touches. Frustum culling and sorting are CPU-side, so nothing else is
// needed.
function makeMockGl() {
  return {
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_DRAW: 0x88e8,
    UNSIGNED_INT: 0x1405,
    createBuffer() {
      return {};
    },
    bindBuffer() {},
    bufferData() {},
    deleteBuffer() {},
  };
}

function makeRenderer(): THREE.WebGLRenderer {
  const gl = makeMockGl();
  return { getContext: () => gl } as unknown as THREE.WebGLRenderer;
}

// Camera at the origin looking down -Z, with matrices ready for culling.
function makeCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
  camera.updateMatrixWorld();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  return camera;
}

// Creates a mesh whose instances sit on the -Z axis at the given depths
// (positive numbers; instance i is at z = -depths[i]).
function makeMesh(
  depths: number[],
  material: THREE.Material,
  renderer: THREE.WebGLRenderer,
): InstancedMesh2 {
  const mesh = new InstancedMesh2(new THREE.BoxGeometry(), material, {
    capacity: depths.length,
    renderer,
  });
  mesh.addInstances(depths.length, (obj, index) => {
    obj.position.set(0, 0, -depths[index]);
  });
  mesh.updateMatrixWorld();
  return mesh;
}

function renderedOrder(mesh: InstancedMesh2): number[] {
  return Array.from(mesh.instanceIndex.array.slice(0, mesh.count));
}

describe("InstancedMesh2 per-instance depth sorting", () => {
  // Instance i is at z = -depths[i]. Back-to-front order: [2, 4, 0, 3, 1].
  const depths = [3, 1, 5, 2, 4];

  it("sorts transparent instances back-to-front (comparator sort)", () => {
    const material = new THREE.MeshBasicMaterial({ transparent: true });
    const mesh = makeMesh(depths, material, makeRenderer());
    mesh.sortObjects = true;

    mesh.performFrustumCulling(makeCamera());

    expect(renderedOrder(mesh)).toEqual([2, 4, 0, 3, 1]);
  });

  it("sorts transparent instances back-to-front (radix sort)", () => {
    const material = new THREE.MeshBasicMaterial({ transparent: true });
    const mesh = makeMesh(depths, material, makeRenderer());
    mesh.sortObjects = true;
    mesh.customSort = createRadixSort(mesh);

    mesh.performFrustumCulling(makeCamera());

    expect(renderedOrder(mesh)).toEqual([2, 4, 0, 3, 1]);
  });

  it("sorts back-to-front with createBackToFrontRadixSort", () => {
    // The sort BatchedMeshBase actually installs: direction is fixed to
    // back-to-front rather than read from the material, so it also covers
    // material arrays (batched GLBs).
    const material = new THREE.MeshBasicMaterial({ transparent: true });
    const mesh = makeMesh(depths, material, makeRenderer());
    mesh.sortObjects = true;
    mesh.customSort = createBackToFrontRadixSort();

    mesh.performFrustumCulling(makeCamera());

    expect(renderedOrder(mesh)).toEqual([2, 4, 0, 3, 1]);
  });

  it("handles a single instance (zero depth range) in the radix sort", () => {
    // With one instance, depthDelta is 0; the sort must not produce NaN keys
    // or drop the instance.
    const material = new THREE.MeshBasicMaterial({ transparent: true });
    const mesh = makeMesh([3], material, makeRenderer());
    mesh.sortObjects = true;
    mesh.customSort = createBackToFrontRadixSort();

    mesh.performFrustumCulling(makeCamera());

    expect(renderedOrder(mesh)).toEqual([0]);
  });

  it("sorts opaque instances front-to-back", () => {
    const material = new THREE.MeshBasicMaterial();
    const mesh = makeMesh(depths, material, makeRenderer());
    mesh.sortObjects = true;

    mesh.performFrustumCulling(makeCamera());

    expect(renderedOrder(mesh)).toEqual([1, 3, 0, 4, 2]);
  });
});

describe("InstancedMesh2 shadow passes skip sorting", () => {
  // performFrustumCulling(shadowCamera, mainCamera) with distinct cameras is
  // how onBeforeShadow invokes culling; camera !== cameraLOD marks a shadow
  // pass. Shadow maps are depth-only, so sorting there is pure waste.
  const depths = [3, 1, 5, 2, 4];

  it("renders shadow passes unsorted, main passes sorted (linear path)", () => {
    const material = new THREE.MeshBasicMaterial({ transparent: true });
    const mesh = makeMesh(depths, material, makeRenderer());
    mesh.sortObjects = true;

    mesh.performFrustumCulling(makeCamera(), makeCamera());

    // Linear culling appends visible instances in id order when not sorting.
    expect(renderedOrder(mesh)).toEqual([0, 1, 2, 3, 4]);

    mesh.performFrustumCulling(makeCamera());

    expect(renderedOrder(mesh)).toEqual([2, 4, 0, 3, 1]);
  });

  it("does not invoke customSort during shadow passes (BVH path)", () => {
    const material = new THREE.MeshBasicMaterial({ transparent: true });
    const mesh = makeMesh(depths, material, makeRenderer());
    mesh.sortObjects = true;
    let sortCalls = 0;
    mesh.customSort = (list) => {
      sortCalls++;
      list.sort((a, b) => b.depth - a.depth);
    };
    mesh.computeBVH();

    mesh.performFrustumCulling(makeCamera(), makeCamera());

    // No sort ran, but every instance still renders (BVH traversal order is
    // arbitrary, so only membership is asserted).
    expect(sortCalls).toBe(0);
    expect([...renderedOrder(mesh)].sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4,
    ]);

    mesh.performFrustumCulling(makeCamera());

    expect(sortCalls).toBe(1);
    expect(renderedOrder(mesh)).toEqual([2, 4, 0, 3, 1]);
  });

  it("renders every instance in shadow passes with per-object culling off", () => {
    const material = new THREE.MeshBasicMaterial({ transparent: true });
    const mesh = makeMesh(depths, material, makeRenderer());
    mesh.perObjectFrustumCulled = false;
    mesh.sortObjects = true;

    // Main pass first: leaves the index array holding a sorted list.
    mesh.performFrustumCulling(makeCamera());
    expect(renderedOrder(mesh)).toEqual([2, 4, 0, 3, 1]);

    // The shadow pass must rebuild it to cover all active instances.
    mesh.performFrustumCulling(makeCamera(), makeCamera());
    expect(renderedOrder(mesh)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("InstancedMesh2 sorting with off-center geometry (BVH path)", () => {
  // A box whose bounding-sphere center sits at local (0, 0, +4). Instance 0
  // is rotated 180 degrees about X, flipping the offset to world -Z, so its
  // rendered geometry is *farther* than instance 1's even though its origin
  // is *closer*. Sorting by origin and by transformed center give opposite
  // orders.
  function makeOffCenterMesh(material: THREE.Material): InstancedMesh2 {
    const geometry = new THREE.BoxGeometry();
    geometry.translate(0, 0, 4);
    const mesh = new InstancedMesh2(geometry, material, {
      capacity: 2,
      renderer: makeRenderer(),
    });
    mesh.addInstances(2, (obj, index) => {
      if (index === 0) {
        obj.position.set(0, 0, -10); // Center lands at z = -14.
        obj.quaternion.set(1, 0, 0, 0); // 180 degrees about X.
      } else {
        obj.position.set(0, 0, -12); // Center lands at z = -8.
      }
    });
    mesh.updateMatrixWorld();
    return mesh;
  }

  it("sorts by transformed bounding-sphere center, not instance origin", () => {
    const material = new THREE.MeshBasicMaterial({ transparent: true });
    const mesh = makeOffCenterMesh(material);
    mesh.computeBVH();
    mesh.sortObjects = true;

    mesh.performFrustumCulling(makeCamera());

    // Back-to-front by center depth (14, 8) is [0, 1]; sorting by origin
    // depth (10, 12) would wrongly give [1, 0].
    expect(renderedOrder(mesh)).toEqual([0, 1]);
  });

  it("matches the linear (non-BVH) path's order", () => {
    const material = new THREE.MeshBasicMaterial({ transparent: true });
    const mesh = makeOffCenterMesh(material);
    mesh.sortObjects = true;

    mesh.performFrustumCulling(makeCamera());

    expect(renderedOrder(mesh)).toEqual([0, 1]);
  });

  it("selects LOD levels by transformed center under the BVH path", () => {
    const material = new THREE.MeshBasicMaterial({ transparent: true });
    const geometry = new THREE.BoxGeometry();
    geometry.translate(0, 0, 4);
    const mesh = new InstancedMesh2(geometry, material, {
      capacity: 2,
      renderer: makeRenderer(),
    });
    mesh.addInstances(2, (obj, index) => {
      if (index === 0) {
        obj.position.set(0, 0, -9); // Center at z = -13: past the threshold.
        obj.quaternion.set(1, 0, 0, 0);
      } else {
        obj.position.set(0, 0, -12); // Center at z = -8: inside it.
      }
    });
    mesh.updateMatrixWorld();
    mesh.addLOD(new THREE.BoxGeometry(), material.clone(), 10);
    mesh.computeBVH();
    mesh.sortObjects = true;

    mesh.performFrustumCulling(makeCamera());

    // By center distance, instance 0 (13) is coarse and instance 1 (8) is
    // fine; origin distances (9, 12) would assign the exact opposite.
    const orders = mesh.LODinfo!.render!.levels.map((level) =>
      Array.from(level.object.instanceIndex.array.slice(0, level.object.count)),
    );
    expect(orders).toEqual([[1], [0]]);
  });
});

describe("InstancedMesh2 sorting with LODs", () => {
  // Near instances (z = -2, -3, -1) belong to LOD level 0; far instances
  // (z = -20, -30, -15) are past the level-1 threshold at distance 10.
  const depths = [2, 20, 3, 30, 1, 15];

  function makeLODMesh(material: THREE.Material): InstancedMesh2 {
    const mesh = makeMesh(depths, material, makeRenderer());
    mesh.addLOD(new THREE.BoxGeometry(), material.clone(), 10);
    return mesh;
  }

  function levelOrders(mesh: InstancedMesh2): number[][] {
    return mesh.LODinfo!.render!.levels.map((level) =>
      Array.from(level.object.instanceIndex.array.slice(0, level.object.count)),
    );
  }

  it("assigns LOD levels correctly for back-to-front (transparent) lists", () => {
    const material = new THREE.MeshBasicMaterial({ transparent: true });
    const mesh = makeLODMesh(material);
    mesh.sortObjects = true;

    mesh.performFrustumCulling(makeCamera());

    // Each level gets its own instances, drawn back-to-front within the
    // level. Before the direction-aware level assignment patch, the
    // descending list was split as if ascending: the farthest instances
    // landed in level 0 and the counts were wrong.
    expect(levelOrders(mesh)).toEqual([
      [2, 0, 4], // Near: z = -3, -2, -1.
      [3, 1, 5], // Far: z = -30, -20, -15.
    ]);
  });

  it("assigns LOD levels correctly with createBackToFrontRadixSort", () => {
    // Radix-sorted descending lists must split into levels the same way the
    // comparator-sorted ones do.
    const material = new THREE.MeshBasicMaterial({ transparent: true });
    const mesh = makeLODMesh(material);
    mesh.sortObjects = true;
    mesh.customSort = createBackToFrontRadixSort();

    mesh.performFrustumCulling(makeCamera());

    expect(levelOrders(mesh)).toEqual([
      [2, 0, 4], // Near: z = -3, -2, -1.
      [3, 1, 5], // Far: z = -30, -20, -15.
    ]);
  });

  it("assigns a single instance to the right level when it skips bands", () => {
    // A one-item list can't be direction-detected, so it takes the ascending
    // walk. With three levels (thresholds at distances 10 and 20), a lone
    // instance at distance 25 must skip two bands to land in level 2;
    // upstream's walk advanced at most one level per item.
    const material = new THREE.MeshBasicMaterial({ transparent: true });
    const mesh = makeMesh([25], material, makeRenderer());
    mesh.addLOD(new THREE.BoxGeometry(), material.clone(), 10);
    mesh.addLOD(new THREE.BoxGeometry(), material.clone(), 20);
    mesh.sortObjects = true;

    mesh.performFrustumCulling(makeCamera());

    expect(levelOrders(mesh)).toEqual([[], [], [0]]);
  });

  it("assigns equidistant instances to the right level", () => {
    // All-equal depths also fail direction detection and take the ascending
    // walk; every instance sits past both thresholds.
    const material = new THREE.MeshBasicMaterial({ transparent: true });
    const mesh = makeMesh([25, 25, 25], material, makeRenderer());
    mesh.addLOD(new THREE.BoxGeometry(), material.clone(), 10);
    mesh.addLOD(new THREE.BoxGeometry(), material.clone(), 20);
    mesh.sortObjects = true;

    mesh.performFrustumCulling(makeCamera());

    expect(levelOrders(mesh)).toEqual([[], [], [0, 1, 2]]);
  });

  it("assigns LOD levels correctly for front-to-back (opaque) lists", () => {
    const material = new THREE.MeshBasicMaterial();
    const mesh = makeLODMesh(material);
    mesh.sortObjects = true;

    mesh.performFrustumCulling(makeCamera());

    expect(levelOrders(mesh)).toEqual([
      [4, 0, 2], // Near: z = -1, -2, -3.
      [5, 1, 3], // Far: z = -15, -20, -30.
    ]);
  });
});
