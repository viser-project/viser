import * as THREE from "three";

/** Geometries with more vertices are drawn individually. Draw calls aren't a
 * bottleneck for them, and each object can be culled. */
export const MAX_INSTANCED_VERTICES = 4096;

/** Objects with smaller scales are drawn individually: shaders would underflow.
 * This includes mirrored ones, because front faces are determined for all
 * instances at once. */
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
  /** Only implemented by batches whose materials depend on it. */
  setViewportSize?(width: number, height: number): void;
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

/** Draws displayed sources from a dense array, in the order that they were created.
 * The order matters for objects that are in the same place. */
export abstract class DenseBatch implements InstanceBatch {
  abstract readonly object: THREE.Object3D;
  private readonly members = new Set<InstanceSource>();
  /** Set when sources need to be assigned to different positions in the array. */
  private needsRebuild = false;
  /** Set when members aren't in order of creation. */
  private needsSort = false;
  private lastId = -1;
  private capacity = 0;

  /** (Re)allocate buffers. All contents are written afterwards. */
  protected abstract allocate(capacity: number): void;
  protected abstract setCount(count: number): void;
  protected abstract writeTransform(source: InstanceSource): void;
  protected abstract writeAppearance(source: InstanceSource): void;
  abstract dispose(): void;

  add(source: InstanceSource): void {
    source.batch = this;
    source.batchIndex = -1;
    this.members.add(source);
    if (source.id < this.lastId) this.needsSort = true;
    else this.lastId = source.id;
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
    if (this.needsSort) {
      this.needsSort = false;
      const sorted = [...this.members].sort((a, b) => a.id - b.id);
      this.members.clear();
      sorted.forEach((source) => this.members.add(source));
    }

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

/** Furthest that a source can be from the center of its cell, relative to its
 * radius. Errors from storing a position in single precision are proportional to
 * the distance: this keeps them below 0.1% of the size of an object. Otherwise,
 * it should be as large as possible, because each cell is a separate draw. */
const MAX_CELL_DISTANCE = 12288;
/** Hysteresis: don't move back and forth between cells. */
const MAX_CELL_DISTANCE_BEFORE_MOVING = 1.25 * MAX_CELL_DISTANCE;

/** Size of a source, including scales of parents. */
function worldRadius(source: InstanceSource): number {
  const e = source.matrixWorld.elements;
  const scaleSq = Math.max(
    e[0] * e[0] + e[1] * e[1] + e[2] * e[2],
    e[4] * e[4] + e[5] * e[5] + e[6] * e[6],
    e[8] * e[8] + e[9] * e[9] + e[10] * e[10],
  );
  return (source.appearance?.radius ?? 0) * Math.sqrt(scaleSq);
}

function fitsInCell(
  source: InstanceSource,
  cell: Cell,
  maxDistance: number,
): boolean {
  const e = source.matrixWorld.elements;
  const { center } = cell;
  const distance = Math.max(
    Math.abs(e[12] - center.x),
    Math.abs(e[13] - center.y),
    Math.abs(e[14] - center.z),
  );
  // Comparisons are false if there are NaNs, which aren't worth moving for.
  return !(distance > worldRadius(source) * maxDistance);
}

type Cell = {
  key: string;
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
    // Prefer existing cells: draw order is only preserved within them. They're
    // ordered from oldest to newest, and there's usually only one.
    let numChecked = 0;
    for (const cell of this.cells.values()) {
      if (fitsInCell(source, cell, MAX_CELL_DISTANCE)) return cell;
      if (++numChecked === 4) break;
    }

    // Otherwise, use a cell in a grid.
    const e = source.matrixWorld.elements;
    let size = 8 ** Math.floor(Math.log2(worldRadius(source) * 8192) / 3);
    if (!(size > 0 && size < Infinity)) size = 1024;
    const key = [size, e[12], e[13], e[14]]
      .map((value, i) => (i === 0 ? value : Math.round(value / size)))
      .join("|");
    let cell = this.cells.get(key);
    if (cell === undefined) {
      const batch = this.makeBatch();
      // Centered on the first source, because others are usually close to it.
      const center = new THREE.Vector3(e[12], e[13], e[14]);
      if (!Number.isFinite(center.x + center.y + center.z)) center.set(0, 0, 0);
      batch.setViewportSize?.(...this.viewportSize);
      batch.object.position.copy(center);
      this.object.add(batch.object);
      batch.object.updateMatrixWorld(true);
      cell = { key, center, batch, numMembers: 0 };
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
    if (fitsInCell(source, cell, MAX_CELL_DISTANCE_BEFORE_MOVING))
      cell.batch.updateTransform(source);
    else this.move(source);
  }

  updateAppearance(source: InstanceSource): void {
    const cell = this.cellFromSource.get(source)!;
    if (fitsInCell(source, cell, MAX_CELL_DISTANCE_BEFORE_MOVING))
      cell.batch.updateAppearance(source);
    else this.move(source);
  }

  private move(source: InstanceSource): void {
    this.remove(source);
    this.add(source);
  }

  flush(): void {
    this.cells.forEach((cell) => cell.batch.flush());
  }

  /** Whether sources are so spread out that batching isn't worth it. */
  isSparse(): boolean {
    return this.cells.size > 16 + this.cellFromSource.size / 8;
  }

  setViewportSize(width: number, height: number): void {
    this.viewportSize = [width, height];
    this.cells.forEach((cell) => cell.batch.setViewportSize?.(width, height));
  }

  dispose(): void {
    this.cells.forEach((cell) => cell.batch.dispose());
  }
}

/** Sources that want to be drawn together. */
export class BatchEntry {
  private readonly members = new Set<InstanceSource>();
  private readonly listeners = new Set<() => void>();
  private batch: SpatialBatch | null = null;
  /** False while members still need to start drawing themselves, see `flush()`. */
  private active = false;
  /** Set when members turned out to be too spread out. */
  private sparse = false;

  constructor(
    private readonly instancer: AutoInstancer,
    private readonly key: string,
    private readonly makeBatch: () => InstanceBatch,
  ) {}

  /** Whether members are currently drawn by a batch. */
  isActive = (): boolean => this.active;

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
    if (this.active) {
      this.batch!.add(source);
    } else if (!this.sparse && this.members.size >= ACTIVATE_AT) {
      const batch = new SpatialBatch(this.makeBatch);
      batch.setViewportSize(...this.instancer.viewportSize);
      this.batch = batch;
      this.members.forEach((member) => batch.add(member));
      this.instancer.group.add(batch.object);
      this.active = true;
      this.notify();
    }
  }

  remove(source: InstanceSource): void {
    if (!this.members.delete(source)) return;
    this.batch?.remove(source);
    if (this.active && this.members.size < DEACTIVATE_BELOW) {
      this.disposeBatch();
      this.notify();
    }
    if (this.members.size === 0) {
      this.disposeBatch();
      this.instancer.deleteEntry(this.key);
    }
  }

  private disposeBatch(): void {
    const { batch } = this;
    this.active = false;
    this.batch = null;
    if (batch === null) return;
    this.members.forEach((member) => batch.remove(member));
    this.instancer.group.remove(batch.object);
    batch.dispose();
  }

  setViewportSize(width: number, height: number): void {
    this.batch?.setViewportSize(width, height);
  }

  flush(): void {
    if (this.batch === null) return;
    if (!this.active) {
      // Members have had time to start drawing themselves.
      this.disposeBatch();
      return;
    }
    this.batch.flush();
    if (this.batch.isSparse()) {
      this.sparse = true;
      this.active = false;
      this.notify();
    }
  }
}

/** Automatically instances scene nodes that can be drawn together, when there
 * are many of them. */
export class AutoInstancer {
  /** Contains everything that's drawn by the instancer. Should be added to the
   * root of the scene. */
  readonly group = new THREE.Group();
  viewportSize: [number, number] = [1, 1];
  private readonly entries = new Map<string, BatchEntry>();

  constructor() {
    this.group.name = "autoInstancer";
  }

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

  deleteEntry(key: string): void {
    this.entries.delete(key);
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
  // transparent surfaces once they're batched. Surfaces that write depth would
  // hide skirts that are behind them, and ones that don't wouldn't cover them.
  private numTransparentSurfaces = 0;
  private readonly transparentListeners = new Set<() => void>();

  /** Declare a transparent surface. Returns a cleanup function. */
  addTransparentSurface(): () => void {
    this.numTransparentSurfaces += 1;
    if (this.numTransparentSurfaces === 1)
      this.transparentListeners.forEach((listener) => listener());
    return () => {
      this.numTransparentSurfaces -= 1;
      if (this.numTransparentSurfaces === 0)
        this.transparentListeners.forEach((listener) => listener());
    };
  }

  hasTransparentSurfaces = (): boolean => this.numTransparentSurfaces > 0;

  subscribeTransparent = (listener: () => void): (() => void) => {
    this.transparentListeners.add(listener);
    return () => {
      this.transparentListeners.delete(listener);
    };
  };
}
