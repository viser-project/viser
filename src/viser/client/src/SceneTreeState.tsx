import React from "react";
import * as THREE from "three";
import { SceneNodeMessage } from "./WebsocketMessages";
import { create, StoreApi, UseBoundStore } from "zustand";

export type SceneNode = {
  message: SceneNodeMessage;
  children: string[];
  clickable: boolean;
  labelVisible?: boolean; // Whether to show the label for this node.
  poseUpdateState?: "updated" | "needsUpdate" | "waitForMakeObject";
  wxyz?: [number, number, number, number];
  position?: [number, number, number];
  visibility?: boolean; // Visibility state from the server.
  overrideVisibility?: boolean; // Override from the GUI.
  effectiveVisibility?: boolean; // Computed visibility including parent chain.
};

export type SceneTreeState = {
  // Scene graph structure: nodes are stored flat at the root level.
  [name: string]: SceneNode | undefined;
};

// Pre-defined scene nodes.
export const rootNodeTemplate: SceneNode = {
  message: {
    type: "FrameMessage",
    name: "",
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
  clickable: false,
  visibility: true,
  effectiveVisibility: true,
  // Default quaternion: 90° around X, 180° around Y, -90° around Z.
  // This matches the coordinate system transformation.
  wxyz: (() => {
    const quat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(Math.PI / 2, Math.PI, -Math.PI / 2),
    );
    return [quat.w, quat.x, quat.y, quat.z] as [number, number, number, number];
  })(),
  position: [0.0, 0.0, 0.0],
};
const worldAxesNodeTemplate: SceneNode = {
  message: {
    type: "FrameMessage",
    name: "/WorldAxes",
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
  clickable: false,
  visibility: true,
  effectiveVisibility: true,
};

/** Helper functions that operate on the scene tree store */
function createSceneTreeActions(
  store: UseBoundStore<StoreApi<SceneTreeState>>,
  nodeRefFromName: { [name: string]: undefined | THREE.Object3D },
) {
  // Declare actions object first so functions can reference each other
  const actions = {
    addSceneNode: (message: SceneNodeMessage) => {
      const state = store.getState();
      const existingNode = state[message.name];
      const parentName = message.name.split("/").slice(0, -1).join("/");
      const parentNode = state[parentName];

      const partial: SceneTreeState = {
        [message.name]: {
          ...existingNode,
          message: message,
          children: existingNode?.children ?? [],
          clickable: existingNode?.clickable ?? false,
          labelVisible: existingNode?.labelVisible ?? false,
          // Default to true, will be updated when visibility is set
          effectiveVisibility: existingNode?.effectiveVisibility ?? true,
        },
      };

      // Add to parent's children if this is a new node.
      if (parentNode && !parentNode.children.includes(message.name)) {
        partial[parentName] = {
          ...parentNode,
          children: [...parentNode.children, message.name],
        };
      }

      // Clear the node ref if updating existing node.
      if (existingNode) {
        delete nodeRefFromName[message.name];
      }
      store.setState(partial);
    },

    removeSceneNode: (name: string) => {
      const state = store.getState();
      // Remove this scene node and all children.
      const removeNames: string[] = [];
      function findChildrenRecursive(nodeName: string) {
        removeNames.push(nodeName);
        const node = state[nodeName];
        if (node) {
          node.children.forEach(findChildrenRecursive);
        }
      }
      findChildrenRecursive(name);

      const partial: Partial<SceneTreeState> = {};
      removeNames.forEach((removeName) => {
        partial[removeName] = undefined;
        delete nodeRefFromName[removeName];
      });

      // Remove node from parent's children list.
      const parentName = name.split("/").slice(0, -1).join("/");
      const parentNode = state[parentName];
      if (parentNode) {
        partial[parentName] = {
          ...parentNode,
          children: parentNode.children.filter(
            (child_name) => child_name !== name,
          ),
        };
      }
      store.setState(partial);
    },

    updateSceneNodeProps: (name: string, updates: { [key: string]: any }) => {
      const node = store.getState()[name];
      if (node === undefined) {
        console.error(
          `Attempted to update props of non-existent node ${name}`,
          updates,
        );
        return {};
      }
      store.setState({
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
      store.setState(
        {
          "": rootNodeTemplate,
          "/WorldAxes": worldAxesNodeTemplate,
        },
        true,
      );
    },

    updateNodeAttributes: (name: string, attributes: Partial<SceneNode>) => {
      const node = store.getState()[name];
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
        store.setState({
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
      const state = store.getState();
      const node = state[name];
      if (!node) return;

      // Compute parent's effective visibility.
      const parentName = name.split("/").slice(0, -1).join("/");
      const parentNode = state[parentName];
      const parentEffective =
        parentName === ""
          ? true // Root is always effectively visible
          : (parentNode?.effectiveVisibility ?? true);

      // Compute this node's visibility.
      const nodeVisibility = node.overrideVisibility ?? node.visibility ?? true;
      const effective = parentEffective && nodeVisibility;

      // Update this node and all descendants.
      const updates: SceneTreeState = {
        [name]: {
          ...node,
          effectiveVisibility: effective,
        },
      };

      // Recursively update children.
      function updateChildren(nodeName: string, parentEffective: boolean) {
        const n = state[nodeName];
        if (!n) return;

        n.children.forEach((childName) => {
          const child = state[childName];
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
      store.setState(updates);
    },
  };

  return actions;
}

/** Declare a scene state, and return a hook for accessing it. Note that we put
effort into avoiding a global state! */
export function useSceneTreeState(nodeRefFromName: {
  [name: string]: undefined | THREE.Object3D;
}) {
  return React.useState(() => {
    const store = create<SceneTreeState>(() => ({
      "": rootNodeTemplate,
      "/WorldAxes": worldAxesNodeTemplate,
    }));

    const actions = createSceneTreeActions(store, nodeRefFromName);

    // Return both store and helpers
    return { store, actions };
  })[0];
}
