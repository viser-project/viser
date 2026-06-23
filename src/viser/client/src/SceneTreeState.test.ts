import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createSceneTreeActions, SceneNode } from "./SceneTreeState";
import { createKeyedStore } from "./store";
import { FrameMessage } from "./WebsocketMessages";
import { NodePoseDataMap } from "./ViewerContext";

function makeFrameMessage(name: string): FrameMessage {
  return {
    type: "FrameMessage",
    name,
    props: {
      show_axes: true,
      axes_length: 0.5,
      axes_radius: 0.0125,
      origin_radius: 0.025,
      origin_color: [236, 236, 0],
      scale: 1.0,
    },
  };
}

function setup() {
  const store = createKeyedStore<SceneNode>({
    "": {
      message: makeFrameMessage(""),
      children: [],
      clickBindings: [],
      dragBindings: [],
    },
  });
  const nodeRefFromName: { [name: string]: undefined | THREE.Object3D } = {};
  const nodePoseData: NodePoseDataMap = {};
  const actions = createSceneTreeActions(store, nodeRefFromName, nodePoseData);
  return { store, nodeRefFromName, actions };
}

describe("addSceneNode ref handling", () => {
  it("keeps the node ref when re-adding the identical message object", () => {
    // During recorded playback the same creation message object is replayed on
    // every loop. The mounted three.js object is reused (no remount), so the
    // ref callback that repopulates nodeRefFromName never re-fires. Deleting
    // the ref here would orphan it permanently and freeze e.g. skinned-mesh
    // animations after the first loop (see issue #728).
    const { nodeRefFromName, actions } = setup();
    const message = makeFrameMessage("/node");

    actions.addSceneNode(message);
    const obj = new THREE.Object3D();
    nodeRefFromName["/node"] = obj;

    // Replay the exact same message object.
    actions.addSceneNode(message);
    expect(nodeRefFromName["/node"]).toBe(obj);
  });

  it("clears the node ref when re-adding with a different message object", () => {
    // Live updates deserialize a fresh message each time; the underlying object
    // may be remounted, so the stale ref must be dropped.
    const { nodeRefFromName, actions } = setup();

    actions.addSceneNode(makeFrameMessage("/node"));
    nodeRefFromName["/node"] = new THREE.Object3D();

    actions.addSceneNode(makeFrameMessage("/node"));
    expect(nodeRefFromName["/node"]).toBeUndefined();
  });

  it("does not touch the ref when adding a brand-new node", () => {
    const { nodeRefFromName, actions } = setup();
    const obj = new THREE.Object3D();
    nodeRefFromName["/node"] = obj;

    // A node ref set before the node exists in the store (e.g. the ref callback
    // fires during mount) must survive the initial add.
    actions.addSceneNode(makeFrameMessage("/node"));
    expect(nodeRefFromName["/node"]).toBe(obj);
  });
});
