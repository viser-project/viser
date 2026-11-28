import * as THREE from "three";
import { parentNameOf } from "../SceneTreeState";

// Object3D.updateWorldMatrix(true, false) is what getWorldPosition() and friends
// use to bring an object and its ancestors up to date. It's written with the
// assumption that matrixAutoUpdate is enabled everywhere. When it isn't:
// - Objects don't notice that their ancestors have moved, unless their own
//   `matrixWorldNeedsUpdate` is also set.
// - `matrixWorldNeedsUpdate` is cleared on ancestors, without updating their
//   other children. Those will never be updated.
const originalUpdateWorldMatrix = THREE.Object3D.prototype.updateWorldMatrix;
const previousMatrixWorld = /* @__PURE__ */ new THREE.Matrix4();
THREE.Object3D.prototype.updateWorldMatrix = function (
  updateParents: boolean,
  updateChildren: boolean,
  force: boolean = false,
) {
  if (updateParents) this.parent?.updateWorldMatrix(true, false);

  const stale = this.matrixWorldNeedsUpdate || force;
  previousMatrixWorld.copy(this.matrixWorld);
  originalUpdateWorldMatrix.call(this, false, false, true);
  const changed = stale || !previousMatrixWorld.equals(this.matrixWorld);

  if (updateChildren) {
    for (const child of this.children) {
      child.updateWorldMatrix(false, true, true);
    }
  } else if (changed) {
    // For the next traversal to update children.
    this.matrixWorldNeedsUpdate = true;
  }
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
    this.matrixWorldNeedsUpdate = true;
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

/** Call a function with the name of a node, and then those of its ancestors. */
function forEachAncestor(name: string, callback: (name: string) => void): void {
  callback(name);
  while (name !== "") {
    name = parentNameOf(name);
    callback(name);
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
