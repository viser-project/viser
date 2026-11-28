import * as THREE from "three";
import { markRange } from "./AutoInstancer";

/** Instances with fewer vertices in total aren't worth culling. */
const MIN_CULLED_VERTICES = 50_000;

function copyItem(
  from: Float32Array,
  fromIndex: number,
  to: THREE.BufferAttribute,
  toIndex: number,
): void {
  const { array, itemSize } = to;
  for (let i = 0; i < itemSize; i++)
    array[toIndex * itemSize + i] = from[fromIndex * itemSize + i];
}

/** Same as Frustum.intersectsSphere(), but without allocating anything. */
function intersectsSphere(
  frustum: THREE.Frustum,
  spheres: Float64Array,
  i: number,
): boolean {
  const { planes } = frustum;
  for (let j = 0; j < 6; j++) {
    const { normal, constant } = planes[j];
    const distance =
      normal.x * spheres[i] +
      normal.y * spheres[i + 1] +
      normal.z * spheres[i + 2] +
      constant;
    if (distance < -spheres[i + 3]) return false;
  }
  return true;
}

/** Instances that are in view of a camera. */
class View {
  readonly mesh: THREE.InstancedMesh;
  /** Indices of instances that are drawn, in order. */
  private readonly drawn: Uint32Array;
  /** Inverse of the above; -1 for instances that aren't drawn. */
  private readonly slots: Int32Array;
  /** Instances that have changed, or null for all of them. */
  private dirty: Set<number> | null = null;

  constructor(
    private readonly instances: CulledInstances,
    capacity: number,
  ) {
    const { geometry, material, castShadow, receiveShadow } = instances;
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.count = 0;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3),
      3,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    mesh.frustumCulled = false;
    mesh.boundingSphere = new THREE.Sphere(); // Only used for sorting.
    mesh.matrixWorldAutoUpdate = false;
    mesh.raycast = () => undefined;
    this.mesh = mesh;
    this.drawn = new Uint32Array(capacity);
    this.slots = new Int32Array(capacity).fill(-1);
  }

  markDirty(index: number): void {
    this.dirty?.add(index);
  }

  markAllDirty(): void {
    this.dirty = null;
  }

  update(frustum: THREE.Frustum): void {
    const { mesh, drawn, slots } = this;
    const { matrices, colors, count, spheres } = this.instances;
    const culled = this.instances.numVertices * count > MIN_CULLED_VERTICES;
    let numDrawn = 0;
    let changed = false;
    for (let i = 0; i < count; i++) {
      if (culled && !intersectsSphere(frustum, spheres, i * 4)) {
        slots[i] = -1;
        continue;
      }
      if (numDrawn >= mesh.count || drawn[numDrawn] !== i) changed = true;
      drawn[numDrawn] = i;
      slots[i] = numDrawn;
      numDrawn += 1;
    }
    mesh.count = numDrawn;

    const write = (slot: number) => {
      copyItem(matrices, drawn[slot], mesh.instanceMatrix, slot);
      copyItem(colors, drawn[slot], mesh.instanceColor!, slot);
    };
    const markDrawn = (start: number, length: number) => {
      markRange(mesh.instanceMatrix, start * 16, length * 16);
      markRange(mesh.instanceColor!, start * 3, length * 3);
    };
    if (changed || this.dirty === null) {
      for (let i = 0; i < numDrawn; i++) write(i);
      markDrawn(0, numDrawn);
    } else {
      this.dirty.forEach((index) => {
        const slot = slots[index];
        if (slot === -1) return;
        write(slot);
        markDrawn(slot, 1);
      });
    }
    this.dirty = new Set();
  }
}

/** Draws instances of a mesh, in order. Unlike THREE.InstancedMesh, ones that are
 * out of view of a camera or light are culled.
 *
 * Whenever three.js is about to draw this object, it calls `intersectsFrustum()`.
 * That's when we choose what to draw, and draw it using a child instead. Each camera
 * and light needs a separate one, since buffers are uploaded once per frame. */
export class CulledInstances extends THREE.Mesh {
  readonly matrices: Float32Array;
  readonly colors: Float32Array;
  /** Bounds in world space: center, radius. */
  readonly spheres: Float64Array;
  readonly numVertices: number;
  count = 0;
  private readonly views: View[] = [];
  private numViewsUsed = 0;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    private readonly capacity: number,
  ) {
    super(geometry, material);
    this.matrices = new Float32Array(capacity * 16);
    this.colors = new Float32Array(capacity * 3);
    this.spheres = new Float64Array(capacity * 4);
    this.numVertices =
      geometry.index?.count ?? geometry.attributes.position.count;
  }

  markDirty(index: number): void {
    this.views.forEach((view) => view.markDirty(index));
  }

  markAllDirty(): void {
    this.views.forEach((view) => view.markAllDirty());
  }

  /** Should be called before each render. */
  beginRender(): void {
    // Lights may have been removed. Nothing is used when we're hidden.
    if (this.numViewsUsed > 0)
      this.views
        .splice(this.numViewsUsed)
        .forEach(({ mesh }) => mesh.dispose());
    this.numViewsUsed = 0;
    this.children = [];
  }

  intersectsFrustum(frustum: THREE.Frustum): boolean {
    const i = this.numViewsUsed++;
    if (i === this.views.length) this.views.push(new View(this, this.capacity));
    const view = this.views[i];
    view.update(frustum);
    view.mesh.matrixWorld.copy(this.matrixWorld);
    this.children = view.mesh.count > 0 ? [view.mesh] : [];
    return false;
  }

  raycast(): void {}

  /** Frees buffers, but not the geometry or material. */
  dispose(): void {
    this.views.forEach(({ mesh }) => mesh.dispose());
  }
}
