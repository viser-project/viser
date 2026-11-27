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

/** Geometries with more vertices are drawn individually. Draw calls aren't a
 * bottleneck for them, and each object can be culled. */
export const MAX_INSTANCED_VERTICES = 4096;

/** Smaller scales are drawn individually: shaders would underflow. */
export const MIN_INSTANCE_SCALE = 1e-12;

/** Groups of primitives are instanced when they have this many members. Below
 * this, the benefits don't outweigh the costs of an extra shader program. */
const ACTIVATE_AT = 64;
/** Hysteresis: don't flip back and forth. */
const DEACTIVATE_BELOW = 32;

/** Objects that can be drawn together. */
export interface InstanceBatch {
  /** Transforms are drawn relative to this object's position. */
  readonly object: THREE.Object3D;
  add(source: InstanceSource): void;
  remove(source: InstanceSource): void;
  /** Called when a source's matrixWorld or displayed status changes. */
  updateTransform(source: InstanceSource): void;
  /** Called when a source's appearance changes. */
  updateAppearance(source: InstanceSource): void;
  /** Called before each render, after world matrices have been updated. */
  flush(): void;
  setViewportSize(width: number, height: number): void;
  dispose(): void;
}

export interface InstanceAppearance {
  /** Distance of the furthest point from the source's origin. */
  radius: number;
}

/** Root object for a scene node that may be drawn as part of a batch. */
export class InstanceSource extends THREE.Group {
  batch: InstanceBatch | null = null;
  /** Index in the batch; managed by the batch. */
  batchIndex = -1;
  /** Appearance of this source. The type depends on the batch. */
  appearance: InstanceAppearance | null = null;
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

/** Draws displayed sources from a dense array, in the order that they were added.
 * The order matters for objects that are in the same place. */
export abstract class DenseBatch implements InstanceBatch {
  abstract readonly object: THREE.Object3D;
  private readonly members = new Set<InstanceSource>();
  /** Set when sources need to be assigned to different positions in the array. */
  private needsRebuild = false;
  private capacity = 0;

  /** (Re)allocate buffers. All contents are written afterwards. */
  protected abstract allocate(capacity: number): void;
  protected abstract setCount(count: number): void;
  protected abstract writeTransform(source: InstanceSource): void;
  protected abstract writeAppearance(source: InstanceSource): void;
  abstract dispose(): void;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setViewportSize(_width: number, _height: number): void {}

  add(source: InstanceSource): void {
    source.batch = this;
    source.batchIndex = -1;
    this.members.add(source);
    if (source.displayed) this.needsRebuild = true;
  }

  remove(source: InstanceSource): void {
    this.members.delete(source);
    if (source.batchIndex !== -1) this.needsRebuild = true;
    source.batchIndex = -1;
    source.batch = null;
  }

  updateTransform(source: InstanceSource): void {
    if (source.displayed !== (source.batchIndex !== -1)) {
      this.needsRebuild = true;
    } else if (source.displayed && !this.needsRebuild) {
      this.writeTransform(source);
    }
  }

  updateAppearance(source: InstanceSource): void {
    if (source.batchIndex === -1 || this.needsRebuild) return;
    this.writeTransform(source);
    this.writeAppearance(source);
  }

  flush(): void {
    if (!this.needsRebuild) return;
    this.needsRebuild = false;

    let count = 0;
    this.members.forEach((source) => {
      source.batchIndex = source.displayed ? count++ : -1;
    });
    if (count > this.capacity) {
      this.capacity = Math.max(16, this.capacity);
      while (this.capacity < count) this.capacity *= 2;
      this.allocate(this.capacity);
      this.object.updateMatrixWorld(true);
    }
    if (this.capacity === 0) return;
    this.members.forEach((source) => {
      if (source.batchIndex === -1) return;
      this.writeTransform(source);
      this.writeAppearance(source);
    });
    this.setCount(count);
  }
}

/** Copy of a matrix, relative to a batch's origin. Both are in double precision;
 * this is what keeps batches precise when they're far from the world origin. */
export function matrixRelativeTo(
  matrixWorld: THREE.Matrix4,
  origin: THREE.Vector3,
  out: THREE.Matrix4,
): THREE.Matrix4 {
  out.copy(matrixWorld);
  out.elements[12] -= origin.x;
  out.elements[13] -= origin.y;
  out.elements[14] -= origin.z;
  return out;
}

/** Size of a source's cell. Errors from storing a position in single precision are
 * proportional to its distance from the origin of the cell. So cells are sized
 * relative to the objects in them. */
function cellSize(source: InstanceSource): number {
  const radius = source.appearance?.radius ?? 0;
  if (!(radius > 0 && radius < Infinity)) return 1024;
  // Coarse, so objects with slightly different sizes share a cell.
  return 2048 * 8 ** Math.round(Math.log2(radius) / 3);
}

type Cell = {
  key: string;
  size: number;
  center: THREE.Vector3;
  batch: InstanceBatch;
  numMembers: number;
};

/** Splits sources into batches that are spatially local, for precision. All of
 * them usually end up in the same batch. */
export class SpatialBatch implements InstanceBatch {
  readonly object = new THREE.Group();
  private readonly cells = new Map<string, Cell>();
  private readonly cellFromSource = new Map<InstanceSource, Cell>();
  private viewportSize: [number, number] = [1, 1];

  constructor(private readonly makeBatch: () => InstanceBatch) {}

  private getCell(source: InstanceSource): Cell {
    const size = cellSize(source);
    const e = source.matrixWorld.elements;
    const index = [12, 13, 14].map((i) => {
      const value = Math.round(e[i] / size);
      return Number.isFinite(value) ? value : 0;
    });
    const key = `${size}|${index.join("|")}`;
    let cell = this.cells.get(key);
    if (cell === undefined) {
      const batch = this.makeBatch();
      const center = new THREE.Vector3(
        index[0] * size,
        index[1] * size,
        index[2] * size,
      );
      batch.setViewportSize(...this.viewportSize);
      batch.object.position.copy(center);
      this.object.add(batch.object);
      batch.object.updateMatrixWorld(true);
      cell = { key, size, center, batch, numMembers: 0 };
      this.cells.set(key, cell);
    }
    return cell;
  }

  add(source: InstanceSource): void {
    const cell = this.getCell(source);
    cell.numMembers += 1;
    this.cellFromSource.set(source, cell);
    cell.batch.add(source);
    source.batch = this;
  }

  remove(source: InstanceSource): void {
    const cell = this.cellFromSource.get(source);
    if (cell === undefined) return;
    this.cellFromSource.delete(source);
    cell.batch.remove(source);
    source.batch = null;
    cell.numMembers -= 1;
    if (cell.numMembers === 0) {
      this.cells.delete(cell.key);
      this.object.remove(cell.batch.object);
      cell.batch.dispose();
    }
  }

  updateTransform(source: InstanceSource): void {
    const cell = this.cellFromSource.get(source)!;
    const e = source.matrixWorld.elements;
    const { center } = cell;
    // Hysteresis: cells extend to 0.5 in each direction.
    const limit = 0.75 * cell.size;
    if (
      Math.abs(e[12] - center.x) > limit ||
      Math.abs(e[13] - center.y) > limit ||
      Math.abs(e[14] - center.z) > limit
    ) {
      this.remove(source);
      this.add(source);
    } else {
      cell.batch.updateTransform(source);
    }
  }

  updateAppearance(source: InstanceSource): void {
    const cell = this.cellFromSource.get(source)!;
    if (cellSize(source) !== cell.size) {
      this.remove(source);
      this.add(source);
    } else {
      cell.batch.updateAppearance(source);
    }
  }

  flush(): void {
    this.cells.forEach((cell) => cell.batch.flush());
  }

  setViewportSize(width: number, height: number): void {
    this.viewportSize = [width, height];
    this.cells.forEach((cell) => cell.batch.setViewportSize(width, height));
  }

  dispose(): void {
    this.cells.forEach((cell) => cell.batch.dispose());
  }
}

export type MeshAppearance = InstanceAppearance & {
  color: number;
  scale: [number, number, number];
};

/** Distance of the furthest point from a geometry's origin. */
export function geometryRadius(geometry: THREE.BufferGeometry): number {
  if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
  const { center, radius } = geometry.boundingSphere!;
  return center.length() + radius;
}

const tempBox = /* @__PURE__ */ new THREE.Box3();
const tempMatrix = /* @__PURE__ */ new THREE.Matrix4();
const tempScale = /* @__PURE__ */ new THREE.Vector3();
const tempColor = /* @__PURE__ */ new THREE.Color();

/** Sources that only differ in their transform, scale, and color. */
export class MeshBatch extends DenseBatch {
  readonly object = new THREE.Group();
  private mesh: THREE.InstancedMesh | null = null;
  private needsBounds = true;

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
    // Set by updateBounds().
    mesh.frustumCulled = false;
    mesh.boundingSphere = new THREE.Sphere();
    this.needsBounds = true;
    mesh.raycast = () => undefined;
    this.mesh = mesh;
    this.object.add(mesh);
  }

  protected setCount(count: number): void {
    this.mesh!.count = count;
    this.needsBounds = true;
  }

  flush(): void {
    super.flush();
    if (this.needsBounds) {
      this.needsBounds = false;
      this.updateBounds();
    }
  }

  /** Cull the entire batch when it's out of view. Batches that are cheap to draw
   * aren't worth computing bounds for. */
  private updateBounds(): void {
    const { mesh, geometry } = this;
    if (mesh === null) return;
    const numVertices =
      geometry.index?.count ?? geometry.attributes.position.count;
    mesh.frustumCulled = mesh.count * numVertices > 50_000;
    if (!mesh.frustumCulled) return;

    const radius = geometryRadius(geometry);
    const array = mesh.instanceMatrix.array;
    tempBox.makeEmpty();
    for (let i = 0; i < mesh.count * 16; i += 16) {
      // Frobenius norm: an upper bound for the largest singular value, including
      // when matrices have shear.
      let scaleSq = 0;
      for (let j = 0; j < 11; j++)
        if (j % 4 !== 3) scaleSq += array[i + j] * array[i + j];
      const r = Math.sqrt(scaleSq) * radius;
      const [x, y, z] = [array[i + 12], array[i + 13], array[i + 14]];
      if (!Number.isFinite(x + y + z + r)) {
        mesh.frustumCulled = false;
        return;
      }
      tempBox.min.set(
        Math.min(tempBox.min.x, x - r),
        Math.min(tempBox.min.y, y - r),
        Math.min(tempBox.min.z, z - r),
      );
      tempBox.max.set(
        Math.max(tempBox.max.x, x + r),
        Math.max(tempBox.max.y, y + r),
        Math.max(tempBox.max.z, z + r),
      );
    }
    tempBox.getBoundingSphere(mesh.boundingSphere!);
    mesh.boundingSphere!.radius *= 1.0 + 1e-5; // Roundoff.
  }

  protected writeTransform(source: InstanceSource): void {
    this.needsBounds = true;
    const attribute = this.mesh!.instanceMatrix;
    const { scale } = source.appearance as MeshAppearance;
    matrixRelativeTo(source.matrixWorld, this.object.position, tempMatrix)
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
      const batch = new SpatialBatch(this.makeBatch);
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

  flush(): void {
    this.batch?.flush();
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

  /** Should be called before each render, after world matrices have been
   * updated. */
  flush(): void {
    this.entries.forEach((entry) => entry.flush());
  }

  // The antialiasing skirts of world-space lines can't be sorted relative to
  // transparent objects once they're batched. That's a problem for surfaces that
  // don't write depth, which need to cover lines that are behind them.
  private numDepthlessSurfaces = 0;
  private readonly depthlessListeners = new Set<() => void>();

  /** Declare a transparent surface that doesn't write depth. Returns a cleanup
   * function. */
  addDepthlessSurface(): () => void {
    this.numDepthlessSurfaces += 1;
    if (this.numDepthlessSurfaces === 1)
      this.depthlessListeners.forEach((listener) => listener());
    return () => {
      this.numDepthlessSurfaces -= 1;
      if (this.numDepthlessSurfaces === 0)
        this.depthlessListeners.forEach((listener) => listener());
    };
  }

  hasDepthlessSurfaces = (): boolean => this.numDepthlessSurfaces > 0;

  subscribeDepthless = (listener: () => void): (() => void) => {
    this.depthlessListeners.add(listener);
    return () => {
      this.depthlessListeners.delete(listener);
    };
  };
}
