import {
  createSceneTreeActions,
  SceneNode,
  variantKey,
} from "./SceneTreeState";
import { KeyedStore } from "./store";
import { SceneNodeMessage } from "./WebsocketMessages";

type SceneTreeActions = ReturnType<typeof createSceneTreeActions>;

/** Per-batch parking tables for scene-node updates.
 *
 * Attribute and props updates are parked per (owner, name) during a message
 * batch and applied in merged form at flush, so a 60Hz stream costs one
 * store write per batch instead of one per message. Parked entries are
 * RE-ROUTED through `routeShadowedUpdate` when they land: a cross-scope add
 * later in the SAME batch can flip a name's effective variant after an
 * update was parked, and flushing by name alone would then write one
 * scope's update onto the other scope's variant.
 *
 * Wire-order invariant: an add/remove is applied at receive time while
 * updates park until flush, so the caller MUST `drainFor(name)` before
 * applying any message that can flip `name`'s variant topology. Without the
 * drain, a pre-flip parked update would flush AFTER post-flip updates that
 * were consumed into the shadow slot at receive time, overwriting newer
 * state with older state.
 */
export interface ParkedSceneUpdates {
  parkAttr(owner: string, name: string, updates: Partial<SceneNode>): void;
  parkProps(owner: string, name: string, updates: { [key: string]: any }): void;
  /** Apply and clear all parked entries for `name` immediately, before a
   * topology-flipping message (add / variant remove) for it is handled. */
  drainFor(name: string): void;
  /** Apply all remaining parked entries. Returns the merged store updates
   * (for a single set()) and the names whose visibility actually merged
   * into an effective variant (whose effective visibility must be
   * recomputed after the set()). */
  flush(): {
    mergedUpdates: { [name: string]: SceneNode };
    visibilityNames: string[];
  };
}

export function createParkedSceneUpdates(
  store: KeyedStore<SceneNode>,
  actions: SceneTreeActions,
): ParkedSceneUpdates {
  const attrUpdates: {
    [ownerAndName: string]: {
      name: string;
      owner: string;
      updates: Partial<SceneNode>;
    };
  } = {};
  const propsUpdates: {
    [ownerAndName: string]: {
      name: string;
      owner: string;
      updates: { [key: string]: any };
    };
  } = {};
  // Names with at least one parked entry, so the per-add/remove drainFor
  // call is O(1) in the common case (nothing parked for that name) instead
  // of scanning both tables. Never pruned on drain; a stale member only
  // costs one extra scan.
  const parkedNames = new Set<string>();

  /** Route one attr entry to the shadow slot, or merge it into `out`.
   * Returns true when a visibility change merged into the effective
   * variant. */
  function applyAttr(
    entry: { name: string; owner: string; updates: Partial<SceneNode> },
    out: { [name: string]: SceneNode },
  ): boolean {
    if (actions.routeShadowedUpdate(entry.name, entry.owner, entry.updates))
      return false;
    const currentNode = out[entry.name] ?? store.get(entry.name);
    if (currentNode === undefined) {
      console.log(`(OK) Tried to update non-existent scene node ${entry.name}`);
      return false;
    }
    out[entry.name] = { ...currentNode, ...entry.updates };
    return "visibility" in entry.updates;
  }

  function applyProps(
    entry: { name: string; owner: string; updates: { [key: string]: any } },
    out: { [name: string]: SceneNode },
  ): void {
    if (
      actions.routeShadowedUpdate(entry.name, entry.owner, {
        propsUpdates: entry.updates,
      })
    )
      return;
    const currentNode = out[entry.name] ?? store.get(entry.name);
    if (currentNode === undefined) {
      console.log(`(OK) Tried to update non-existent scene node ${entry.name}`);
      return;
    }
    out[entry.name] = {
      ...currentNode,
      message: {
        ...currentNode.message,
        props: {
          ...currentNode.message.props,
          ...entry.updates,
        },
      } as SceneNodeMessage,
    };
  }

  return {
    parkAttr: (owner, name, updates) => {
      parkedNames.add(name);
      const entry = (attrUpdates[variantKey(owner, name)] ??= {
        name,
        owner,
        updates: {},
      });
      Object.assign(entry.updates, updates);
    },
    parkProps: (owner, name, updates) => {
      parkedNames.add(name);
      const entry = (propsUpdates[variantKey(owner, name)] ??= {
        name,
        owner,
        updates: {},
      });
      Object.assign(entry.updates, updates);
    },
    drainFor: (name) => {
      if (!parkedNames.has(name)) return;
      // Rare path (a cross-scope flip mid-batch): immediate store writes
      // are fine, and required -- the topology change lands right after.
      for (const [key, entry] of Object.entries(attrUpdates)) {
        if (entry.name !== name) continue;
        delete attrUpdates[key];
        const out: { [n: string]: SceneNode } = {};
        const recompute = applyAttr(entry, out);
        if (Object.keys(out).length > 0) store.set(out);
        if (recompute) actions.computeEffectiveVisibility(name);
      }
      for (const [key, entry] of Object.entries(propsUpdates)) {
        if (entry.name !== name) continue;
        delete propsUpdates[key];
        const out: { [n: string]: SceneNode } = {};
        applyProps(entry, out);
        if (Object.keys(out).length > 0) store.set(out);
      }
    },
    flush: () => {
      const mergedUpdates: { [name: string]: SceneNode } = {};
      const visibilityNames: string[] = [];
      for (const entry of Object.values(attrUpdates)) {
        if (applyAttr(entry, mergedUpdates)) visibilityNames.push(entry.name);
      }
      for (const entry of Object.values(propsUpdates)) {
        applyProps(entry, mergedUpdates);
      }
      return { mergedUpdates, visibilityNames };
    },
  };
}
