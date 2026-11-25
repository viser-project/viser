import * as THREE from "three";

// Object3D.updateWorldMatrix(true, false) brings an object and its ancestors up
// to date, and clears their `matrixWorldNeedsUpdate` flags. But it doesn't
// update the ancestors' other children. Those are only updated by the next
// traversal if the ancestors' flags are still set, or if matrixAutoUpdate is
// enabled on every object. We rely on being able to disable the latter, so keep
// the flags.
const originalUpdateWorldMatrix = THREE.Object3D.prototype.updateWorldMatrix;
THREE.Object3D.prototype.updateWorldMatrix = function (
  updateParents: boolean,
  updateChildren: boolean,
  force?: boolean,
) {
  const stale = this.matrixWorldNeedsUpdate || (force ?? false);
  // @ts-ignore The third argument is missing from type definitions.
  originalUpdateWorldMatrix.call(this, updateParents, updateChildren, force);
  if (stale && !updateChildren) this.matrixWorldNeedsUpdate = true;
};

/** Group that contains everything in a scene node's subtree. Its own transform
 * is always identity.
 *
 * Scenes may have many thousands of nodes, and three.js visits all of them every
 * frame. Two flags, maintained by SceneNodeGraph, are used for pruning subtrees:
 * - `visible` is false if there's nothing to draw in this subtree. This is
 *   unrelated to the visibility of the scene node.
 * - `transformsStatic`, which is true if world matrices in this subtree only
 *   change when SceneNodeGraph is notified. */
export class SceneNodeGroup extends THREE.Group {
  transformsStatic = false;
  transformsDirty = true;

  constructor() {
    super();
    this.matrixAutoUpdate = false;
  }

  updateMatrixWorld(force?: boolean): void {
    if (
      this.transformsStatic &&
      !this.transformsDirty &&
      !this.matrixWorldNeedsUpdate &&
      !force
    )
      return;
    this.transformsDirty = false;
    super.updateMatrixWorld(force);
  }
}

type NodeRecord = {
  group: SceneNodeGroup | null;
  /** Number of things in this node's subtree that need to be drawn by walking
   * the scene graph. */
  drawables: number;
  /** Number of things in this node's subtree that may move on their own. */
  dynamics: number;
};

function forEachAncestor(
  name: string,
  callback: (name: string) => boolean | void,
): void {
  // Node names are either empty (the root) or start with a slash.
  for (;;) {
    if (callback(name) === false || name === "") return;
    name = name.slice(0, Math.max(0, name.lastIndexOf("/")));
  }
}

/** Bookkeeping for pruning; see SceneNodeGroup. */
export class SceneNodeGraph {
  private readonly records = new Map<string, NodeRecord>();

  private getRecord(name: string): NodeRecord {
    let record = this.records.get(name);
    if (record === undefined) {
      record = { group: null, drawables: 0, dynamics: 0 };
      this.records.set(name, record);
    }
    return record;
  }

  private deleteIfUnused(name: string, record: NodeRecord): void {
    if (
      record.group === null &&
      record.drawables === 0 &&
      record.dynamics === 0
    )
      this.records.delete(name);
  }

  private count(
    name: string,
    field: "drawables" | "dynamics",
    delta: number,
  ): void {
    forEachAncestor(name, (ancestor) => {
      const record = this.getRecord(ancestor);
      record[field] += delta;
      this.syncGroup(record);
      this.deleteIfUnused(ancestor, record);
    });
  }

  private syncGroup(record: NodeRecord): void {
    if (record.group === null) return;
    record.group.visible = record.drawables > 0;
    record.group.transformsStatic = record.dynamics === 0;
  }

  /** Register the group of a mounted scene node. */
  attachGroup(name: string, group: SceneNodeGroup): void {
    const record = this.getRecord(name);
    record.group = group;
    this.syncGroup(record);
    this.markTransformsDirty(name);
  }

  detachGroup(name: string, group: SceneNodeGroup): void {
    const record = this.records.get(name);
    // When a node is remounted, the successor may already be attached.
    if (record === undefined || record.group !== group) return;
    record.group = null;
    this.deleteIfUnused(name, record);
  }

  /** Declare something that needs to be drawn under a scene node. Returns a
   * cleanup function. */
  addDrawable(name: string): () => void {
    this.count(name, "drawables", 1);
    return () => this.count(name, "drawables", -1);
  }

  /** Declare something that may move without calling `markTransformsDirty()`
   * under a scene node. Returns a cleanup function. */
  addDynamic(name: string): () => void {
    this.count(name, "dynamics", 1);
    return () => this.count(name, "dynamics", -1);
  }

  /** Should be called when an object in a node's subtree is moved or added. */
  markTransformsDirty(name: string): void {
    forEachAncestor(name, (ancestor) => {
      const group = this.records.get(ancestor)?.group;
      if (group != null) group.transformsDirty = true;
    });
  }
}
