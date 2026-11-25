import * as THREE from "three";

/** Layer for objects that should be raycast against, but not drawn. */
export const RAYCAST_ONLY_LAYER = 30;
export const raycastOnlyLayers = new THREE.Layers();
raycastOnlyLayers.set(RAYCAST_ONLY_LAYER);

export const raycastOnlyMaterials = {
  front: new THREE.MeshBasicMaterial({ side: THREE.FrontSide }),
  back: new THREE.MeshBasicMaterial({ side: THREE.BackSide }),
  double: new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
};

/** Groups of primitives are instanced when they have this many members. Below
 * this, the benefits don't outweigh the costs of an extra shader program. */
const ACTIVATE_AT = 64;
/** Hysteresis: don't flip back and forth. */
const DEACTIVATE_BELOW = 32;

/** Objects that can be drawn together. */
export interface InstanceBatch {
  readonly object: THREE.Object3D;
  add(source: InstanceSource): void;
  remove(source: InstanceSource): void;
  /** Called when a source's matrixWorld or displayed status changes. */
  updateTransform(source: InstanceSource): void;
  /** Called when a source's appearance changes. */
  updateAppearance(source: InstanceSource): void;
  setViewportSize(width: number, height: number): void;
  dispose(): void;
}

/** Root object for a scene node that may be drawn as part of a batch. */
export class InstanceSource extends THREE.Group {
  batch: InstanceBatch | null = null;
  /** Index in the batch; managed by the batch. */
  batchIndex = -1;
  /** Appearance of this source. The type depends on the batch. */
  appearance: unknown = null;
  /** Whether this source and all of its ancestors are visible. */
  displayed = false;

  setDisplayed(displayed: boolean): void {
    if (this.displayed === displayed) return;
    this.displayed = displayed;
    this.batch?.updateTransform(this);
  }

  updateMatrixWorld(force?: boolean): void {
    const changed = this.matrixWorldNeedsUpdate || force;
    super.updateMatrixWorld(force);
    if (changed) this.batch?.updateTransform(this);
  }
}

/** Schedule part of a buffer for uploading. */
export function markRange(
  attribute: THREE.BufferAttribute | THREE.InterleavedBuffer,
  start: number,
  count: number,
): void {
  // Past some number of small uploads, it's cheaper to just do a large one.
  // Ranges are cleared by three.js when they're uploaded.
  const MAX_RANGES = 256;
  const ranges = attribute.updateRanges;
  const last = ranges.length > 0 ? ranges[ranges.length - 1] : null;
  if (last !== null && last.start + last.count === start) {
    last.count += count;
  } else if (ranges.length < MAX_RANGES) {
    attribute.addUpdateRange(start, count);
  } else {
    let min = start;
    let max = start + count;
    for (const range of ranges) {
      min = Math.min(min, range.start);
      max = Math.max(max, range.start + range.count);
    }
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(min, max - min);
  }
  attribute.needsUpdate = true;
}

/** Keeps displayed sources in a dense array. `batchIndex` is a source's position
 * in it, or -1. */
export abstract class DenseBatch implements InstanceBatch {
  abstract readonly object: THREE.Object3D;
  private readonly dense: InstanceSource[] = [];
  private capacity = 0;

  /** (Re)allocate buffers. All contents are written afterwards. */
  protected abstract allocate(capacity: number): void;
  protected abstract setCount(count: number): void;
  protected abstract writeTransform(source: InstanceSource): void;
  protected abstract writeAppearance(source: InstanceSource): void;
  abstract dispose(): void;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setViewportSize(_width: number, _height: number): void {}

  private write(source: InstanceSource): void {
    this.writeTransform(source);
    this.writeAppearance(source);
  }

  private insert(source: InstanceSource): void {
    source.batchIndex = this.dense.length;
    this.dense.push(source);
    if (this.dense.length > this.capacity) {
      this.capacity = Math.max(ACTIVATE_AT * 2, this.capacity * 2);
      this.allocate(this.capacity);
      this.dense.forEach((s) => this.write(s));
    } else {
      this.write(source);
    }
    this.setCount(this.dense.length);
  }

  private evict(source: InstanceSource): void {
    // Move the last source into the hole.
    const last = this.dense.pop()!;
    if (last !== source) {
      this.dense[source.batchIndex] = last;
      last.batchIndex = source.batchIndex;
      this.write(last);
    }
    source.batchIndex = -1;
    this.setCount(this.dense.length);
  }

  add(source: InstanceSource): void {
    source.batch = this;
    if (source.displayed) this.insert(source);
  }

  remove(source: InstanceSource): void {
    if (source.batchIndex !== -1) this.evict(source);
    source.batch = null;
  }

  updateTransform(source: InstanceSource): void {
    if (source.displayed !== (source.batchIndex !== -1)) {
      if (source.displayed) this.insert(source);
      else this.evict(source);
    } else if (source.displayed) {
      this.writeTransform(source);
    }
  }

  updateAppearance(source: InstanceSource): void {
    if (source.batchIndex !== -1) this.write(source);
  }
}

export type MeshAppearance = {
  color: number;
  scale: [number, number, number];
};

const tempMatrix = /* @__PURE__ */ new THREE.Matrix4();
const tempScale = /* @__PURE__ */ new THREE.Vector3();
const tempColor = /* @__PURE__ */ new THREE.Color();

/** Sources that only differ in their transform, scale, and color. */
export class MeshBatch extends DenseBatch {
  readonly object = new THREE.Group();
  private mesh: THREE.InstancedMesh | null = null;

  constructor(
    private readonly geometry: THREE.BufferGeometry,
    private readonly material: THREE.Material,
    private readonly castShadow: boolean,
    private readonly receiveShadow: boolean,
  ) {
    super();
  }

  protected allocate(capacity: number): void {
    this.disposeMesh();
    const mesh = new THREE.InstancedMesh(
      this.geometry,
      this.material,
      capacity,
    );
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3),
      3,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = this.castShadow;
    mesh.receiveShadow = this.receiveShadow;
    // Culling and sorting would both use bounds that are expensive to compute.
    mesh.frustumCulled = false;
    mesh.boundingSphere = new THREE.Sphere();
    mesh.raycast = () => undefined;
    this.mesh = mesh;
    this.object.add(mesh);
  }

  protected setCount(count: number): void {
    this.mesh!.count = count;
  }

  protected writeTransform(source: InstanceSource): void {
    const attribute = this.mesh!.instanceMatrix;
    const { scale } = source.appearance as MeshAppearance;
    tempMatrix
      .copy(source.matrixWorld)
      .scale(tempScale.set(scale[0], scale[1], scale[2]))
      .toArray(attribute.array, source.batchIndex * 16);
    markRange(attribute, source.batchIndex * 16, 16);
  }

  protected writeAppearance(source: InstanceSource): void {
    const attribute = this.mesh!.instanceColor!;
    tempColor
      .setHex((source.appearance as MeshAppearance).color)
      .toArray(attribute.array, source.batchIndex * 3);
    markRange(attribute, source.batchIndex * 3, 3);
  }

  private disposeMesh(): void {
    if (this.mesh === null) return;
    this.object.remove(this.mesh);
    // Frees the instance buffers, but not the geometry or material.
    this.mesh.dispose();
  }

  dispose(): void {
    this.disposeMesh();
    this.material.dispose();
  }
}

/** Sources that want to be drawn together. */
export class BatchEntry {
  private readonly members = new Set<InstanceSource>();
  private readonly listeners = new Set<() => void>();
  private batch: InstanceBatch | null = null;

  constructor(
    private readonly instancer: AutoInstancer,
    private readonly key: string,
    private readonly makeBatch: () => InstanceBatch,
  ) {}

  /** Whether members are currently drawn by a batch. */
  isActive = (): boolean => this.batch !== null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  add(source: InstanceSource): void {
    this.members.add(source);
    if (this.batch !== null) {
      this.batch.add(source);
    } else if (this.members.size >= ACTIVATE_AT) {
      const batch = this.makeBatch();
      batch.setViewportSize(...this.instancer.viewportSize);
      this.batch = batch;
      this.members.forEach((member) => batch.add(member));
      this.instancer.group.add(batch.object);
      this.notify();
    }
  }

  remove(source: InstanceSource): void {
    if (!this.members.delete(source)) return;
    this.batch?.remove(source);
    if (this.batch !== null && this.members.size < DEACTIVATE_BELOW) {
      const batch = this.batch;
      this.batch = null;
      this.members.forEach((member) => batch.remove(member));
      this.instancer.group.remove(batch.object);
      batch.dispose();
      this.notify();
    }
    if (this.members.size === 0) this.instancer.deleteEntry(this.key, this);
  }

  setViewportSize(width: number, height: number): void {
    this.batch?.setViewportSize(width, height);
  }
}

/** Automatically instances scene nodes that can be drawn together, when there
 * are many of them. */
export class AutoInstancer {
  /** Contains everything that's drawn by the instancer. Should be added to the
   * root of the scene. */
  readonly group = new THREE.Group();
  viewportSize: [number, number] = [1, 1];
  constructor() {
    this.group.name = "autoInstancer";
  }

  private readonly entries = new Map<string, BatchEntry>();

  /** Returns the entry for a key, which should describe everything that members
   * need to have in common. */
  getEntry(key: string, makeBatch: () => InstanceBatch): BatchEntry {
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = new BatchEntry(this, key, makeBatch);
      this.entries.set(key, entry);
    }
    return entry;
  }

  deleteEntry(key: string, entry: BatchEntry): void {
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }

  setViewportSize(width: number, height: number): void {
    this.viewportSize = [width, height];
    this.entries.forEach((entry) => entry.setViewportSize(width, height));
  }
}
