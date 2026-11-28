import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { SceneNodeGraph, SceneNodeGroup } from "./SceneNodeGroup";

describe("SceneNodeGraph", () => {
  function setup(names: string[]) {
    const graph = new SceneNodeGraph();
    const groups: { [name: string]: SceneNodeGroup } = {};
    for (const name of names) {
      groups[name] = new SceneNodeGroup();
      if (name !== "")
        groups[name.slice(0, name.lastIndexOf("/"))].add(groups[name]);
      graph.attachGroup(name, groups[name]);
    }
    groups[""].updateMatrixWorld();
    return { graph, groups };
  }

  it("hides subtrees without drawables", () => {
    const { graph, groups } = setup(["", "/a", "/a/b", "/c"]);
    expect(groups[""].visible).toBe(false);
    const remove = graph.addDrawable("/a/b");
    const remove2 = graph.addDrawable("/a/b");
    const visible = () =>
      Object.keys(groups).filter((name) => groups[name].visible);
    expect(visible()).toEqual(["", "/a", "/a/b"]);
    remove();
    expect(visible()).toEqual(["", "/a", "/a/b"]);
    remove2();
    expect(visible()).toEqual([]);
  });

  it("works when nodes are counted before they're attached", () => {
    const graph = new SceneNodeGraph();
    graph.addDrawable("/a/b");
    const group = new SceneNodeGroup();
    graph.attachGroup("/a", group);
    expect(group.visible).toBe(true);
  });

  it("doesn't detach successors", () => {
    const graph = new SceneNodeGraph();
    const [first, second] = [new SceneNodeGroup(), new SceneNodeGroup()];
    graph.attachGroup("/a", first);
    graph.attachGroup("/a", second);
    graph.detachGroup("/a", first);
    graph.addDrawable("/a");
    expect(second.visible).toBe(true);
  });

  it("doesn't leak", () => {
    const { graph, groups } = setup(["", "/a", "/a/b"]);
    const cleanup = [graph.addDrawable("/a/b"), graph.addDynamic("/a/b")];
    cleanup.forEach((fn) => fn());
    for (const name of Object.keys(groups))
      graph.detachGroup(name, groups[name]);
    // @ts-ignore Private.
    expect(graph.records.size).toBe(0);
  });

  it("skips static subtrees until they're marked dirty", () => {
    const { graph, groups } = setup(["", "/a", "/b"]);
    const [inA, inB] = [new THREE.Object3D(), new THREE.Object3D()];
    groups["/a"].add(inA);
    groups["/b"].add(inB);
    const removeDynamic = graph.addDynamic("/b");
    inA.position.x = 1;
    inB.position.x = 1;
    groups[""].updateMatrixWorld();
    expect(inA.matrixWorld.elements[12]).toBe(0);
    expect(inB.matrixWorld.elements[12]).toBe(1);

    graph.markTransformsDirty("/a");
    groups[""].updateMatrixWorld();
    expect(inA.matrixWorld.elements[12]).toBe(1);

    removeDynamic();
    inA.position.x = 2;
    groups[""].updateMatrixWorld();
    expect(inA.matrixWorld.elements[12]).toBe(1);
    groups[""].updateMatrixWorld(true);
    expect(inA.matrixWorld.elements[12]).toBe(2);
  });

  it("gives new groups a world matrix", () => {
    const root = new THREE.Group();
    root.position.x = 5;
    root.updateMatrixWorld();
    root.matrixAutoUpdate = false;
    const group = new SceneNodeGroup();
    root.add(group);
    root.updateMatrixWorld();
    expect(group.matrixWorld.elements[12]).toBe(5);
  });
});

describe("Object3D.updateWorldMatrix", () => {
  it("doesn't prevent siblings from being updated", () => {
    // Reproduces what happens when something calls getWorldPosition() in
    // between a pose update and a render.
    const parent = new THREE.Group();
    const [a, b] = [new THREE.Group(), new THREE.Group()];
    parent.add(a, b);
    parent.updateMatrixWorld();
    for (const object of [parent, a, b]) object.matrixAutoUpdate = false;

    parent.position.x = 1;
    parent.updateMatrix();
    expect(a.getWorldPosition(new THREE.Vector3()).x).toBe(1);
    parent.updateMatrixWorld();
    expect(b.matrixWorld.elements[12]).toBe(1);
  });

  it("doesn't cause updates when nothing has changed", () => {
    const parent = new THREE.Group();
    const child = new THREE.Group();
    parent.add(child);
    parent.updateMatrixWorld();
    parent.matrixAutoUpdate = child.matrixAutoUpdate = false;
    child.getWorldPosition(new THREE.Vector3());
    expect(parent.matrixWorldNeedsUpdate).toBe(false);
    expect(child.matrixWorldNeedsUpdate).toBe(false);
  });

  it("updates descendants", () => {
    const [parent, child, grandchild] = [
      new THREE.Group(),
      new THREE.Group(),
      new THREE.Group(),
    ];
    parent.add(child);
    child.add(grandchild);
    for (const object of [parent, child, grandchild])
      object.matrixAutoUpdate = false;
    parent.position.x = 1;
    parent.updateMatrix();
    child.updateWorldMatrix(true, true);
    expect(grandchild.matrixWorld.elements[12]).toBe(1);
  });
});
