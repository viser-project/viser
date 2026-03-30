import React from "react";
import * as THREE from "three";
import { SceneNodeMessage } from "./WebsocketMessages";
import { createKeyedStore, KeyedStore } from "./store";
import { NodePoseDataMap } from "./ViewerContext";

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
  // Default quaternion: 90 deg around X, 180 deg around Y, -90 deg around Z.
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
  store: KeyedStore<SceneNode>,
  nodeRefFromName: { [name: string]: undefined | THREE.Object3D },
  nodePoseData: NodePoseDataMap,
) {
  const actions = {
    addSceneNode: (message: SceneNodeMessage) => {
      const existingNode = store.get(message.name);
      const parentName = message.name.split("/").slice(0, -1).join("/");
      const parentNode = store.get(parentName);

      const updates: Record<string, SceneNode | undefined> = {
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
        updates[parentName] = {
          ...parentNode,
          children: [...parentNode.children, message.name],
        };
      }

      // Clear the node ref if updating existing node.
      if (existingNode) {
        delete nodeRefFromName[message.name];
      }
      store.set(updates);
    },

    removeSceneNode: (name: string) => {
      // Remove this scene node and all children.
      const removeNames: string[] = [];
      function findChildrenRecursive(nodeName: string) {
        removeNames.push(nodeName);
        const node = store.get(nodeName);
        if (node) {
          node.children.forEach(findChildrenRecursive);
        }
      }
      findChildrenRecursive(name);

      const updates: Record<string, SceneNode | undefined> = {};
      removeNames.forEach((removeName) => {
        updates[removeName] = undefined;
        delete nodeRefFromName[removeName];
        delete nodePoseData[removeName];
      });

      // Remove node from parent's children list.
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
      store.setAll(
        {
          "": rootNodeTemplate,
          "/WorldAxes": worldAxesNodeTemplate,
        },
        true,
      );
      // Clear all stale pose data.
      for (const key of Object.keys(nodePoseData)) {
        delete nodePoseData[key];
      }
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

      // Compute parent's effective visibility.
      const parentName = name.split("/").slice(0, -1).join("/");
      const parentNode = store.get(parentName);
      const parentEffective =
        parentName === ""
          ? true // Root is always effectively visible
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
    const store = createKeyedStore<SceneNode>({
      "": rootNodeTemplate,
      "/WorldAxes": worldAxesNodeTemplate,
    });

    const actions = createSceneTreeActions(
      store,
      nodeRefFromName,
      nodePoseData,
    );

    // Return both store and helpers
    return { store, actions };
  })[0];
}
