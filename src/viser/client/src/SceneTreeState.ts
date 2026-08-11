import React from "react";
import * as THREE from "three";
import { SceneNodeMessage } from "./WebsocketMessages";
import { DragBinding } from "./dragUtils";
import { createKeyedStore, KeyedStore } from "./store";
import { NodePoseDataMap } from "./ViewerContext";

export type SceneNode = {
  message: SceneNodeMessage;
  children: string[];
  /** Per-node click bindings carried over the wire by
   * `SetSceneNodeClickBindingsMessage`. Empty array means "not
   * clickable for any input"; structurally identical to
   * `DragBinding`. */
  clickBindings: DragBinding[];
  dragBindings: DragBinding[];
  labelVisible?: boolean; // Whether to show the label for this node.
  wxyz?: [number, number, number, number];
  position?: [number, number, number];
  visibility?: boolean; // Visibility state from the server.
  overrideVisibility?: boolean; // Override from the GUI.
  effectiveVisibility?: boolean; // Computed visibility including parent chain.
  /** The lower-ranked variant of this name, when both scopes (broadcast +
   * this client) have one. Each scene-tree name holds at most one variant
   * per scope; only the effective (higher-ranked) variant is mounted and
   * interactive, but the shadowed variant keeps accumulating state from its
   * scope's messages so that removing the effective variant promotes it
   * with up-to-date state -- no resurrection round-trip needed. */
  shadowed?: ShadowedVariant;
};

export type ShadowedVariant = {
  message: SceneNodeMessage;
  clickBindings: DragBinding[];
  dragBindings: DragBinding[];
  wxyz: [number, number, number, number];
  position: [number, number, number];
  visibility: boolean;
};

/** Owner id stamped on scene messages: "" is the broadcast scope
 * (server.scene), anything else is a per-client scope. Old recordings
 * predate the field; a missing field -- or a missing MESSAGE, e.g. an
 * interaction racing a node removal -- means broadcast. */
/** Composite key for one scope's variant of a scene node, used wherever
 * per-variant side state lives in a flat map (skinnedMeshState, the message
 * batcher's parked updates). Owners are "" (broadcast) or a client id, so
 * NUL can't collide with a real owner. */
export function variantKey(owner: string | undefined, name: string): string {
  return `${owner ?? ""}\u0000${name}`;
}

export function ownerOf(message: { owner?: string } | undefined): string {
  return message?.owner ?? "";
}

function isVirtual(message: SceneNodeMessage): boolean {
  return (message as { virtual?: boolean }).virtual ?? false;
}

/** Display-rule rank: real client > real broadcast > virtual client >
 * virtual broadcast. The higher-ranked variant of a name is effective
 * (rendered, interactive); the other is shadowed. */
function variantRank(message: SceneNodeMessage): number {
  return (isVirtual(message) ? 0 : 2) + (ownerOf(message) !== "" ? 1 : 0);
}

function makeRootNodeTemplate(): SceneNode {
  // Default quaternion: 90 deg around X, 180 deg around Y, -90 deg around Z.
  // This matches the coordinate system transformation.
  const quat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(Math.PI / 2, Math.PI, -Math.PI / 2),
  );

  return {
    message: {
      type: "FrameMessage",
      name: "",
      owner: "",
      virtual: false,
      props: {
        show_axes: false,
        axes_length: 0.5,
        axes_radius: 0.0125,
        origin_radius: 0.025,
        origin_color: [236, 236, 0],
        scale: 1.0,
      },
    },
    children: ["/WorldAxes"],
    clickBindings: [],
    dragBindings: [],
    visibility: true,
    effectiveVisibility: true,
    wxyz: [quat.w, quat.x, quat.y, quat.z],
    position: [0.0, 0.0, 0.0],
  };
}

function makeWorldAxesNodeTemplate(): SceneNode {
  return {
    message: {
      type: "FrameMessage",
      name: "/WorldAxes",
      owner: "",
      virtual: false,
      props: {
        show_axes: true,
        axes_length: 0.5,
        axes_radius: 0.0125,
        origin_radius: 0.025,
        origin_color: [236, 236, 0],
        scale: 1.0,
      },
    },
    children: [],
    clickBindings: [],
    dragBindings: [],
    visibility: true,
    effectiveVisibility: true,
  };
}

function makeDefaultSceneTreeState(): Record<string, SceneNode> {
  return {
    "": makeRootNodeTemplate(),
    "/WorldAxes": makeWorldAxesNodeTemplate(),
  };
}

// Pre-defined scene nodes.
export const rootNodeTemplate: SceneNode = makeRootNodeTemplate();

/** Helper functions that operate on the scene tree store */
export function createSceneTreeActions(
  store: KeyedStore<SceneNode>,
  nodeRefFromName: { [name: string]: undefined | THREE.Object3D },
  nodePoseData: NodePoseDataMap,
) {
  /** Pre-order names of `name`'s subtree, collected BEFORE any removal:
   * children lists die with their nodes. Shared by variant-subtree and
   * whole-node removal. */
  function collectSubtreeNames(name: string): string[] {
    const names: string[] = [];
    function collect(nodeName: string) {
      names.push(nodeName);
      store.get(nodeName)?.children.forEach(collect);
    }
    collect(name);
    return names;
  }

  /** Remove `name` from its parent's `children` list, recording the change
   * in `updates`. Shared by variant removal and recursive removal. */
  function dropFromParentChildren(
    name: string,
    updates: Record<string, SceneNode | undefined>,
  ) {
    const parentName = name.split("/").slice(0, -1).join("/");
    const parentNode = store.get(parentName);
    if (parentNode) {
      updates[parentName] = {
        ...parentNode,
        children: parentNode.children.filter(
          (child_name) => child_name !== name,
        ),
      };
    }
  }

  const actions = {
    /** Returns whether the added variant became the effective one for its
     * name, or was parked in the shadow slot. */
    addSceneNode: (message: SceneNodeMessage): "effective" | "shadowed" => {
      const existingNode = store.get(message.name);

      // Cross-scope add: the name already has a variant from the OTHER
      // scope. The display rule decides which becomes effective; the loser
      // is parked in the shadow slot, where its scope's messages keep
      // updating it.
      if (
        existingNode !== undefined &&
        ownerOf(existingNode.message) !== ownerOf(message)
      ) {
        if (variantRank(message) >= variantRank(existingNode.message)) {
          // Incoming variant shadows the current effective one. Snapshot the
          // effective variant's state (including its live pose) into the
          // shadow slot, then install the incoming variant fresh: a new
          // variant starts at default pose/visibility, and its own Set*
          // messages follow its create in the same buffer.
          const pose = nodePoseData[message.name];
          const shadowed: ShadowedVariant = {
            message: existingNode.message,
            clickBindings: existingNode.clickBindings,
            dragBindings: existingNode.dragBindings,
            wxyz: pose?.wxyz ?? [1, 0, 0, 0],
            position: pose?.position ?? [0, 0, 0],
            visibility: existingNode.visibility ?? true,
          };
          delete nodeRefFromName[message.name];
          nodePoseData[message.name] = {
            wxyz: [1, 0, 0, 0],
            position: [0, 0, 0],
            poseUpdateState: "needsUpdate",
          };
          store.set({
            [message.name]: {
              ...existingNode,
              message,
              shadowed,
              clickBindings: [],
              dragBindings: [],
              visibility: true,
            },
          });
          actions.computeEffectiveVisibility(message.name);
          return "effective";
        }
        // Incoming variant is lower-ranked (e.g. a virtual anchor next to
        // a real node): park it in the shadow slot, effective untouched.
        store.set({
          [message.name]: {
            ...existingNode,
            shadowed: {
              message,
              clickBindings: [],
              dragBindings: [],
              wxyz: [1, 0, 0, 0],
              position: [0, 0, 0],
              visibility: true,
            },
          },
        });
        return "shadowed";
      }

      // Same-owner add (within-scope create or supersede), or a brand-new
      // name. `...existingNode` carries any shadow slot across a supersede.
      // Deliberately NOT re-ranked against the shadow slot: the wire never
      // downgrades an existing in-scope name to a virtual anchor (anchors
      // are only sent for names missing in that scope), so a supersede
      // keeps this variant effective unconditionally.
      const parentName = message.name.split("/").slice(0, -1).join("/");
      const parentNode = store.get(parentName);

      const updates: Record<string, SceneNode | undefined> = {
        [message.name]: {
          ...existingNode,
          message: message,
          children: existingNode?.children ?? [],
          clickBindings: existingNode?.clickBindings ?? [],
          dragBindings: existingNode?.dragBindings ?? [],
          labelVisible: existingNode?.labelVisible ?? false,
          // Default to true, will be updated when visibility is set.
          effectiveVisibility: existingNode?.effectiveVisibility ?? true,
        },
      };

      // Add to parent's children if this is a new node.
      if (parentNode && !parentNode.children.includes(message.name)) {
        updates[parentName] = {
          ...parentNode,
          children: [...parentNode.children, message.name],
        };
      }

      // Preserve refs when playback replays the same creation message; React
      // may reuse the mounted object instead of remounting it.
      if (existingNode && existingNode.message !== message) {
        delete nodeRefFromName[message.name];
      }
      store.set(updates);
      return "effective";
    },

    /** Remove ONE scope's variant of a name. Scope-local by design: the
     * server enumerates a message per same-scope descendant, and the other
     * scope's variants (including children hanging from their own scope's
     * virtual anchors) are untouched -- so unlike `removeSceneNode`, this
     * does not recurse. Removing the effective variant promotes the
     * shadowed one; a promoted VIRTUAL anchor inherits the departing
     * variant's pose (frozen-pose inheritance), so surviving children stay
     * where they were instead of teleporting to identity.
     *
     * The return value reports which disposition happened, so callers can
     * act on it (e.g. clean per-node side state only when the mounted
     * variant went away) without re-deriving the display-rule decision. */
    removeSceneNodeVariant: (
      name: string,
      owner: string,
    ): "removed-effective" | "promoted" | "removed-shadow" | "noop" => {
      // Absent names are routine, not an anomaly: servers enumerate one
      // remove per descendant, and the subtree recursion (see
      // removeSceneNodeVariantSubtree) has usually removed them already.
      const node = store.get(name);
      if (node === undefined) return "noop";
      if (ownerOf(node.message) === owner) {
        const shadowed = node.shadowed;
        if (shadowed !== undefined) {
          // Promote the shadowed variant, with the state its scope's
          // messages have been accumulating while it was hidden.
          delete nodeRefFromName[name];
          if (!isVirtual(shadowed.message)) {
            nodePoseData[name] = {
              wxyz: shadowed.wxyz,
              position: shadowed.position,
              poseUpdateState: "needsUpdate",
            };
          }
          store.set({
            [name]: {
              ...node,
              message: shadowed.message,
              clickBindings: shadowed.clickBindings,
              dragBindings: shadowed.dragBindings,
              visibility: isVirtual(shadowed.message)
                ? true
                : shadowed.visibility,
              shadowed: undefined,
            },
          });
          actions.computeEffectiveVisibility(name);
          return "promoted";
        }
        // Last variant: drop the entry (no recursion -- see docstring).
        const updates: Record<string, SceneNode | undefined> = {
          [name]: undefined,
        };
        delete nodeRefFromName[name];
        delete nodePoseData[name];
        dropFromParentChildren(name, updates);
        store.set(updates);
        return "removed-effective";
      }
      if (node.shadowed && ownerOf(node.shadowed.message) === owner) {
        store.set({ [name]: { ...node, shadowed: undefined } });
        return "removed-shadow";
      }
      return "noop";
    },

    /** Remove one scope's variants of `name` AND its same-scope descendants.
     * Current servers enumerate one RemoveSceneNodeMessage per descendant
     * (the recursion then no-ops on the later messages), but recordings from
     * older servers contain a single non-enumerated remove per subtree --
     * without the recursion their descendants would linger forever, along
     * with their pose/ref side state. Still scope-local: other-owner
     * variants of descendant names are untouched. Returns the names whose
     * variant actually went away, so callers can clean per-variant side
     * state. */
    removeSceneNodeVariantSubtree: (name: string, owner: string): string[] => {
      if (store.get(name) === undefined) return [];
      return collectSubtreeNames(name).filter(
        (n) => actions.removeSceneNodeVariant(n, owner) !== "noop",
      );
    },

    /** Route a node-keyed state update by owner: returns false when it
     * targets the EFFECTIVE variant of `name` (or the scope-less root
     * singleton), in which case the caller applies it through the normal
     * effective-variant path; returns true when it was consumed here --
     * applied to the shadowed variant, or dropped because no variant of
     * that owner exists (e.g. the update raced a removal).
     *
     * Shadowed state is mutated IN PLACE, with no store write: nothing
     * subscribes to the shadow slot (only promotion reads it, via
     * non-reactive store.get), and a server animating a shadowed node can
     * stream pose updates at 60Hz -- reactive writes would notify every
     * subscriber of the effective node per message for state that nothing
     * renders. Promotion materializes the accumulated state into fresh
     * store objects. */
    routeShadowedUpdate: (
      name: string,
      owner: string | undefined,
      updates: Partial<Omit<ShadowedVariant, "message">> & {
        propsUpdates?: { [key: string]: any };
      },
    ): boolean => {
      // The root ("") is a singleton across scopes; owner is ignored for it.
      if (name === "") return false;
      const node = store.get(name);
      if (node === undefined) return false;
      if (ownerOf(node.message) === (owner ?? "")) return false;
      const shadowed = node.shadowed;
      if (
        shadowed !== undefined &&
        ownerOf(shadowed.message) === (owner ?? "")
      ) {
        const { propsUpdates, ...rest } = updates;
        Object.assign(shadowed, rest);
        if (propsUpdates !== undefined) {
          Object.assign(
            shadowed.message.props as Record<string, unknown>,
            propsUpdates,
          );
        }
      }
      return true;
    },

    removeSceneNode: (name: string) => {
      // Remove this scene node and all children.
      const removeNames = collectSubtreeNames(name);

      const updates: Record<string, SceneNode | undefined> = {};
      removeNames.forEach((removeName) => {
        updates[removeName] = undefined;
        delete nodeRefFromName[removeName];
        delete nodePoseData[removeName];
      });

      // Remove node from parent's children list.
      dropFromParentChildren(name, updates);
      store.set(updates);
    },

    updateSceneNodeProps: (name: string, updates: { [key: string]: any }) => {
      const node = store.get(name);
      if (node === undefined) {
        console.error(
          `Attempted to update props of non-existent node ${name}`,
          updates,
        );
        return {};
      }
      // Skip the store write when nothing actually changed -- the prop editor
      // auto-submits on every Switch/Select/ColorInput change, and a no-op
      // write would still notify store subscribers and re-render every
      // useSceneTree consumer of this node.
      //
      // Shallow-compare arrays explicitly: ColorInput (and tuple-shaped scale
      // updates) emit fresh array references on every onChange, so a plain
      // ``Object.is`` would think every re-click of the same color is a
      // change.
      const currentProps = node.message.props as Record<string, unknown>;
      let changed = false;
      for (const key in updates) {
        const a = currentProps[key];
        const b = updates[key];
        if (Object.is(a, b)) continue;
        if (
          Array.isArray(a) &&
          Array.isArray(b) &&
          a.length === b.length &&
          a.every((v, i) => Object.is(v, b[i]))
        ) {
          continue;
        }
        changed = true;
        break;
      }
      if (!changed) return;
      store.set({
        [name]: {
          ...node,
          message: {
            ...node.message,
            props: {
              ...node.message.props,
              ...(updates as any),
            },
          },
        },
      });
    },

    resetScene: () => {
      // Remove all children of root except /WorldAxes.
      const root = store.get("");
      if (root) {
        for (const child of root.children) {
          if (child === "/WorldAxes") continue;
          actions.removeSceneNode(child);
        }
      }
      // Reset root and /WorldAxes to default state.
      const defaultState = makeDefaultSceneTreeState();
      store.set({
        "": defaultState[""],
        "/WorldAxes": defaultState["/WorldAxes"],
      });
      nodePoseData[""] = {
        wxyz: defaultState[""].wxyz!,
        position: defaultState[""].position!,
        poseUpdateState: "needsUpdate",
      };
    },

    updateNodeAttributes: (name: string, attributes: Partial<SceneNode>) => {
      const node = store.get(name);
      if (node === undefined) {
        console.log(
          `(OK) Attempted to update attributes of non-existent node ${name}`,
          attributes,
        );
        return;
      }

      // Check if any attributes actually changed to avoid unnecessary updates.
      let hasChanged = false;
      for (const key in attributes) {
        if (
          node[key as keyof SceneNode] !== attributes[key as keyof SceneNode]
        ) {
          hasChanged = true;
          break;
        }
      }
      if (hasChanged) {
        store.set({
          [name]: {
            ...node,
            ...attributes,
          },
        });

        // If visibility changed, recompute effective visibility for this node and descendants.
        if ("visibility" in attributes || "overrideVisibility" in attributes) {
          actions.computeEffectiveVisibility(name);
        }
      }
    },

    computeEffectiveVisibility: (name: string) => {
      const node = store.get(name);
      if (!node) return;

      // Compute parent's effective visibility. The check is on `name` (is this
      // node the root?), NOT on `parentName`: the root node itself has no
      // parent, but its *children* (whose parentName is also "") must inherit
      // the root's actual effectiveVisibility -- otherwise a child recomputed
      // after `set_global_visibility(False)` would wrongly become visible.
      const parentName = name.split("/").slice(0, -1).join("/");
      const parentNode = store.get(parentName);
      const parentEffective =
        name === ""
          ? true // Root node has no parent.
          : (parentNode?.effectiveVisibility ?? true);

      // Compute this node's visibility.
      const nodeVisibility = node.overrideVisibility ?? node.visibility ?? true;
      const effective = parentEffective && nodeVisibility;

      // Update this node and all descendants.
      const updates: Record<string, SceneNode> = {
        [name]: {
          ...node,
          effectiveVisibility: effective,
        },
      };

      // Recursively update children.
      function updateChildren(nodeName: string, parentEffective: boolean) {
        const n = store.get(nodeName);
        if (!n?.children) return;

        n.children.forEach((childName) => {
          const child = store.get(childName);
          if (!child) return;

          const childVisibility =
            child.overrideVisibility ?? child.visibility ?? true;
          const childEffective = parentEffective && childVisibility;

          updates[childName] = {
            ...child,
            effectiveVisibility: childEffective,
          };

          updateChildren(childName, childEffective);
        });
      }
      updateChildren(name, effective);
      store.set(updates);
    },
  };

  return actions;
}

/** Declare a scene state, and return a hook for accessing it. Note that we put
effort into avoiding a global state! */
export function useSceneTreeState(
  nodeRefFromName: { [name: string]: undefined | THREE.Object3D },
  nodePoseData: NodePoseDataMap,
) {
  return React.useState(() => {
    const store = createKeyedStore<SceneNode>(makeDefaultSceneTreeState());

    const actions = createSceneTreeActions(
      store,
      nodeRefFromName,
      nodePoseData,
    );

    // Establish the default state up front via the same path used on
    // (re)connect. This seeds the root node's pose into nodePoseData -- which
    // the pose sync needs in order to orient the root frame (and the
    // /WorldAxes gizmo under it). Without it, the root renders at identity (the
    // three.js Y-up frame) until the first connection.
    actions.resetScene();

    // Return both store and helpers.
    return { store, actions };
  })[0];
}
