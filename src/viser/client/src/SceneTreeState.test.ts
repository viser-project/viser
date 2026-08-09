import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createSceneTreeActions, SceneNode } from "./SceneTreeState";
import { createKeyedStore } from "./store";
import { FrameMessage } from "./WebsocketMessages";
import { NodePoseDataMap } from "./ViewerContext";

function makeFrameMessage(
  name: string,
  owner: string = "",
  virtual: boolean = false,
): FrameMessage {
  return {
    type: "FrameMessage",
    name,
    owner,
    virtual,
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
  return { store, nodeRefFromName, nodePoseData, actions };
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

describe("variant slots and the display rule", () => {
  it("client variant shadows a broadcast variant, preserving its state", () => {
    const { store, nodePoseData, actions } = setup();

    const broadcastMsg = makeFrameMessage("/x", "");
    expect(actions.addSceneNode(broadcastMsg)).toBe("effective");
    nodePoseData["/x"] = {
      wxyz: [0, 0, 0, 1],
      position: [1, 2, 3],
      poseUpdateState: "updated",
    };

    const clientMsg = makeFrameMessage("/x", "7");
    expect(actions.addSceneNode(clientMsg)).toBe("effective");

    const node = store.get("/x")!;
    expect(node.message).toBe(clientMsg);
    // The broadcast variant is parked with its pose snapshot.
    expect(node.shadowed?.message).toBe(broadcastMsg);
    expect(node.shadowed?.position).toEqual([1, 2, 3]);
    // The fresh client variant starts from identity pose.
    expect(nodePoseData["/x"]!.position).toEqual([0, 0, 0]);
  });

  it("a virtual client anchor does not shadow a real broadcast node", () => {
    const { store, actions } = setup();

    const broadcastMsg = makeFrameMessage("/x", "");
    actions.addSceneNode(broadcastMsg);
    const anchorMsg = makeFrameMessage("/x", "7", true);
    expect(actions.addSceneNode(anchorMsg)).toBe("shadowed");

    const node = store.get("/x")!;
    expect(node.message).toBe(broadcastMsg); // Still effective.
    expect(node.shadowed?.message).toBe(anchorMsg); // Parked.
  });

  it("a real broadcast node arriving late does not displace a real client node", () => {
    const { store, actions } = setup();

    const clientMsg = makeFrameMessage("/x", "7");
    actions.addSceneNode(clientMsg);
    const broadcastMsg = makeFrameMessage("/x", "");
    actions.addSceneNode(broadcastMsg);

    const node = store.get("/x")!;
    expect(node.message).toBe(clientMsg);
    expect(node.shadowed?.message).toBe(broadcastMsg);
  });

  it("removing the effective variant promotes the shadowed one with accumulated state", () => {
    const { store, nodePoseData, actions } = setup();

    actions.addSceneNode(makeFrameMessage("/x", ""));
    actions.addSceneNode(makeFrameMessage("/x", "7")); // Shadows broadcast.

    // Broadcast keeps updating while shadowed; the router consumes the
    // update (returns true) instead of letting it hit the effective path.
    expect(actions.routeShadowedUpdate("/x", "", { position: [4, 5, 6] })).toBe(
      true,
    );
    // An update for the EFFECTIVE variant is not consumed.
    expect(
      actions.routeShadowedUpdate("/x", "7", { position: [0, 0, 9] }),
    ).toBe(false);

    expect(actions.removeSceneNodeVariant("/x", "7")).toBe("promoted");
    const node = store.get("/x")!;
    expect(node.message.owner).toBe("");
    expect(node.shadowed).toBeUndefined();
    // Promotion restores the broadcast variant's LATEST pose.
    expect(nodePoseData["/x"]!.position).toEqual([4, 5, 6]);
  });

  it("a promoted virtual anchor inherits the departing variant's pose", () => {
    const { store, nodePoseData, actions } = setup();

    actions.addSceneNode(makeFrameMessage("/a", "")); // Real broadcast parent.
    actions.addSceneNode(makeFrameMessage("/a", "7", true)); // Client anchor, parked.
    nodePoseData["/a"] = {
      wxyz: [1, 0, 0, 0],
      position: [9, 9, 9],
      poseUpdateState: "updated",
    };

    actions.removeSceneNodeVariant("/a", "");
    const node = store.get("/a")!;
    expect(node.message.virtual).toBe(true);
    // Frozen-pose inheritance: children of /a stay where they were.
    expect(nodePoseData["/a"]!.position).toEqual([9, 9, 9]);
  });

  it("variant removal is scope-local and non-recursive", () => {
    const { store, actions } = setup();

    actions.addSceneNode(makeFrameMessage("/a", ""));
    actions.addSceneNode(makeFrameMessage("/a/child", "7"));

    // Broadcast /a removed; the client child's entry must survive (its own
    // scope's anchor/removals are the only things that may touch it).
    actions.removeSceneNodeVariant("/a", "");
    expect(store.get("/a")).toBeUndefined();
    expect(store.get("/a/child")).toBeDefined();
  });

  it("removing a shadowed variant leaves the effective one untouched", () => {
    const { store, actions } = setup();

    const clientMsg = makeFrameMessage("/x", "7");
    actions.addSceneNode(makeFrameMessage("/x", ""));
    actions.addSceneNode(clientMsg);

    actions.removeSceneNodeVariant("/x", ""); // Drop the parked broadcast copy.
    const node = store.get("/x")!;
    expect(node.message).toBe(clientMsg);
    expect(node.shadowed).toBeUndefined();
  });

  it("same-scope supersede preserves the shadow slot", () => {
    const { store, actions } = setup();

    actions.addSceneNode(makeFrameMessage("/x", "7")); // Client, effective.
    actions.addSceneNode(makeFrameMessage("/x", "")); // Broadcast, parked.
    const newClientMsg = makeFrameMessage("/x", "7");
    actions.addSceneNode(newClientMsg); // Client supersede.

    const node = store.get("/x")!;
    expect(node.message).toBe(newClientMsg);
    expect(node.shadowed?.message.owner).toBe("");
  });
});
