import { describe, it, expect } from "vitest";
import * as THREE from "three";
// Via the package index: the LOD and frustum-culling methods are installed
// onto InstancedMesh2's prototype as a side effect of importing their modules.
import { InstancedMesh2 } from "../../index.js";
import { createBackToFrontSort } from "../../../../mesh/batchedDepthSort";

// Minimal WebGL2 mock: InstancedMesh2 allocates a raw `instanceIndex` buffer
// on construction, and nothing in the culling path touches the context beyond
// that. Same shape as the one in InstancedMesh2.dispose.test.ts.
function makeRenderer(): THREE.WebGLRenderer {
  const gl = {
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_DRAW: 0x88e8,
    UNSIGNED_INT: 0x1405,
    createBuffer: () => ({}),
    bindBuffer() {},
    bufferData() {},
    deleteBuffer() {},
  };
  return { getContext: () => gl } as unknown as THREE.WebGLRenderer;
}

// LOD thresholds in world units; `addLevel` squares them internally.
const LOD_DISTANCES = [2.0, 6.0];
// One instance per level: 1 < 2, 2 <= 3 < 6, and 10 >= 6.
const INSTANCE_DISTANCES = [1.0, 3.0, 10.0];

/**
 * Build a 3-level LOD mesh with one instance sitting in each level's band,
 * and run one frustum-culling pass over it.
 *
 * Returns, per level, the instance indices the pass routed to that level's
 * draw call.
 */
function cullWithLODs(options: { transparent: boolean }): number[][] {
  const renderer = makeRenderer();
  const material = new THREE.MeshBasicMaterial({
    transparent: options.transparent,
  });
  const mesh = new InstancedMesh2(new THREE.BoxGeometry(), material, {
    capacity: INSTANCE_DISTANCES.length,
    renderer,
  });
  mesh.frustumCulled = false;

  for (const distance of LOD_DISTANCES) {
    mesh.addLOD(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial({ transparent: options.transparent }),
      distance,
    );
  }

  mesh.addInstances(INSTANCE_DISTANCES.length, () => {});
  mesh.updateInstances((obj, index) => {
    // Straight down the camera's view axis, so instance i is at distance
    // INSTANCE_DISTANCES[i] and every instance stays inside the frustum.
    obj.position.set(0.0, 0.0, -INSTANCE_DISTANCES[index]);
  });
  mesh.updateMatrixWorld(true);

  mesh.sortObjects = true;
  if (options.transparent) mesh.customSort = createBackToFrontSort();

  const camera = new THREE.PerspectiveCamera(75, 1.0, 0.1, 1000.0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

  mesh.performFrustumCulling(camera);

  return mesh.LODinfo.render.levels.map((level) =>
    Array.from(
      (level.object.instanceIndex.array as Uint32Array).slice(
        0,
        level.object.count,
      ),
    ),
  );
}

describe("frustumCullingLOD with a sorted render list", () => {
  it("routes instances to their own LOD level under a back-to-front sort", () => {
    // Upstream walked the sorted list with a forward-only cursor that assumed
    // ascending depth. A transparent batch sorts descending, which sent the
    // near instances to the coarsest level -- here, all three landed in level
    // 1. Each instance must land in the level its distance selects.
    expect(cullWithLODs({ transparent: true })).toEqual([[0], [1], [2]]);
  });

  it("still routes correctly under the ascending opaque sort", () => {
    expect(cullWithLODs({ transparent: false })).toEqual([[0], [1], [2]]);
  });
});
