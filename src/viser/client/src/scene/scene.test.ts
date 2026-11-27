import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  AutoInstancer,
  InstanceAppearance,
  MeshAppearance,
  SpatialBatch,
  InstanceBatch,
  InstanceSource,
  markRange,
  MeshBatch,
} from "./AutoInstancer";
import { GeometryAppearance, GeometryBatch } from "./GeometryBatch";
import { LineBatch } from "./LineBatch";
import { SceneNodeGraph, SceneNodeGroup } from "./SceneNodeGroup";
import { collectShadowCasters, installFastShadowPass } from "./shadowPass";
import { SceneNodeUpdates } from "../sceneNodeUpdates";

function makeSource(x: number, appearance: InstanceAppearance): InstanceSource {
  const source = new InstanceSource();
  source.matrixAutoUpdate = false;
  source.position.x = x;
  source.updateMatrix();
  source.appearance = appearance;
  source.displayed = true;
  source.updateMatrixWorld();
  return source;
}

/** Positions that a mesh batch draws, sorted. */
function drawnPositions(batch: MeshBatch): number[] {
  batch.flush();
  const mesh = batch.object.children[0] as THREE.InstancedMesh;
  const matrix = new THREE.Matrix4();
  const out = [];
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, matrix);
    out.push(matrix.elements[12]);
  }
  return out.sort((a, b) => a - b);
}

const meshAppearance = { color: 0xff0000, scale: [1, 2, 3], radius: 1 };
const makeMeshBatch = () =>
  new MeshBatch(
    new THREE.BoxGeometry(),
    new THREE.MeshBasicMaterial(),
    true,
    false,
  );

describe("AutoInstancer", () => {
  it("only batches large groups, with hysteresis", () => {
    const instancer = new AutoInstancer();
    const entry = instancer.getEntry("key", makeMeshBatch);
    const listener = vi.fn();
    entry.subscribe(listener);
    const sources = Array.from({ length: 64 }, (_, i) =>
      makeSource(i, meshAppearance),
    );

    sources.slice(0, 63).forEach((source) => entry.add(source));
    expect(entry.isActive()).toBe(false);
    expect(instancer.group.children.length).toBe(0);

    entry.add(sources[63]);
    expect(entry.isActive()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(instancer.group.children.length).toBe(1);

    sources.slice(0, 32).forEach((source) => entry.remove(source));
    expect(entry.isActive()).toBe(true);
    entry.remove(sources[32]);
    expect(entry.isActive()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(instancer.group.children.length).toBe(0);
    expect(sources[40].batch).toBe(null);

    // Entries are forgotten when they're empty.
    sources.slice(33).forEach((source) => entry.remove(source));
    expect(instancer.getEntry("key", makeMeshBatch)).not.toBe(entry);
  });

  it("tells new batches about the viewport", () => {
    const instancer = new AutoInstancer();
    instancer.setViewportSize(3, 4);
    const setViewportSize = vi.fn();
    const entry = instancer.getEntry("key", () => {
      const batch: InstanceBatch = makeMeshBatch();
      batch.setViewportSize = setViewportSize;
      return batch;
    });
    for (let i = 0; i < 64; i++) entry.add(makeSource(i, meshAppearance));
    expect(setViewportSize).toHaveBeenLastCalledWith(3, 4);
    instancer.setViewportSize(5, 6);
    expect(setViewportSize).toHaveBeenLastCalledWith(5, 6);
  });
});

describe("MeshBatch", () => {
  it("tracks displayed sources through growth, hiding, and removal", () => {
    const batch = makeMeshBatch();
    const sources = Array.from({ length: 300 }, (_, i) =>
      makeSource(i, meshAppearance),
    );
    sources.forEach((source) => batch.add(source));
    const all = sources.map((_, i) => i);
    expect(drawnPositions(batch)).toEqual(all);

    sources.filter((_, i) => i % 3 === 0).forEach((s) => s.setDisplayed(false));
    expect(drawnPositions(batch)).toEqual(all.filter((i) => i % 3 !== 0));

    sources.filter((_, i) => i % 5 === 0).forEach((s) => batch.remove(s));
    expect(drawnPositions(batch)).toEqual(
      all.filter((i) => i % 3 !== 0 && i % 5 !== 0),
    );

    sources.filter((_, i) => i % 3 === 0).forEach((s) => s.setDisplayed(true));
    expect(drawnPositions(batch)).toEqual(all.filter((i) => i % 5 !== 0));
  });

  it("follows transforms of sources and their parents", () => {
    const batch = makeMeshBatch();
    const parent = new THREE.Group();
    const source = makeSource(1, meshAppearance);
    parent.add(source);
    batch.add(source);
    parent.position.x = 10;
    parent.updateMatrixWorld();
    expect(drawnPositions(batch)).toEqual([11]);

    source.position.x = 2;
    source.updateMatrix();
    parent.updateMatrixWorld();
    expect(drawnPositions(batch)).toEqual([12]);

    // Moving while hidden.
    source.setDisplayed(false);
    source.position.x = 3;
    source.updateMatrix();
    parent.updateMatrixWorld();
    expect(drawnPositions(batch)).toEqual([]);
    source.setDisplayed(true);
    expect(drawnPositions(batch)).toEqual([13]);
  });

  it("applies scale and color", () => {
    const batch = makeMeshBatch();
    const source = makeSource(0, meshAppearance);
    batch.add(source);
    batch.flush();
    const mesh = batch.object.children[0] as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    mesh.getMatrixAt(0, matrix);
    mesh.getColorAt(0, color);
    expect(new THREE.Vector3().setFromMatrixScale(matrix).toArray()).toEqual([
      1, 2, 3,
    ]);
    expect(color.getHex()).toBe(0xff0000);

    source.appearance = {
      color: 0x00ff00,
      scale: [1, 1, 1],
      radius: 1,
    } as MeshAppearance;
    batch.updateAppearance(source);
    mesh.getColorAt(0, color);
    expect(color.getHex()).toBe(0x00ff00);
  });
});

describe("draw order", () => {
  it("is unaffected by hiding, showing, and removing", () => {
    const batch = makeMeshBatch();
    const sources = Array.from({ length: 20 }, (_, i) =>
      makeSource(i, meshAppearance),
    );
    sources.forEach((source) => batch.add(source));
    const order = () => {
      batch.flush();
      return sources
        .filter((s) => s.batchIndex !== -1)
        .sort((a, b) => a.batchIndex - b.batchIndex)
        .map((s) => s.position.x);
    };
    sources.slice(0, 10).forEach((s) => s.setDisplayed(false));
    expect(order()).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    sources.slice(0, 10).forEach((s) => s.setDisplayed(true));
    batch.remove(sources[5]);
    expect(order()).toEqual(sources.map((_, i) => i).filter((i) => i !== 5));
  });
});

describe("SpatialBatch", () => {
  const FAR = 4_100_000.3;

  /** Errors that are introduced by single precision, for each source. */
  function maxError(batch: SpatialBatch, sources: InstanceSource[]): number {
    batch.flush();
    batch.object.updateMatrixWorld();
    const drawn: number[] = [];
    batch.object.traverse((object) => {
      const mesh = object as THREE.InstancedMesh;
      if (!mesh.isInstancedMesh) return;
      const matrix = new THREE.Matrix4();
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix);
        drawn.push(mesh.matrixWorld.elements[12] + matrix.elements[12]);
      }
    });
    const expected = sources.map((s) => s.matrixWorld.elements[12]);
    drawn.sort((a, b) => a - b);
    expected.sort((a, b) => a - b);
    expect(drawn.length).toBe(expected.length);
    return Math.max(...drawn.map((v, i) => Math.abs(v - expected[i])));
  }

  it("is precise far from the origin", () => {
    const batch = new SpatialBatch(makeMeshBatch);
    const sources = Array.from({ length: 100 }, (_, i) =>
      makeSource(FAR + i * 0.37, meshAppearance),
    );
    sources.forEach((source) => batch.add(source));
    expect(maxError(batch, sources)).toBeLessThan(1e-3);
    expect(batch.object.children.length).toBe(1);
  });

  it("follows sources between cells, and cleans up", () => {
    const batch = new SpatialBatch(makeMeshBatch);
    const sources = Array.from({ length: 10 }, (_, i) =>
      makeSource(i, meshAppearance),
    );
    sources.forEach((source) => batch.add(source));
    for (const offset of [FAR, 0, 1e9, 3000, NaN, 5]) {
      sources.forEach((source, i) => {
        source.position.x = offset + i * 0.1;
        source.updateMatrix();
        source.updateMatrixWorld();
        expect(source.batch).toBe(batch);
      });
      if (Number.isFinite(offset) && offset < 1e8)
        expect(maxError(batch, sources)).toBeLessThan(1e-3);
    }
    sources.forEach((source) => batch.remove(source));
    expect(batch.object.children.length).toBe(0);
    expect(sources[0].batch).toBe(null);
  });

  it("sizes cells relative to objects", () => {
    const batch = new SpatialBatch(makeMeshBatch);
    // Large objects that are far apart, in millimeters for example.
    for (let i = 0; i < 100; i++)
      batch.add(
        makeSource(i * 1000, { ...meshAppearance, radius: 500 } as any),
      );
    expect(batch.object.children.length).toBe(1);
    // Small objects that are far apart.
    const small = new SpatialBatch(makeMeshBatch);
    for (let i = 0; i < 10; i++)
      small.add(
        makeSource(i * 1000, { ...meshAppearance, radius: 0.01 } as any),
      );
    expect(small.object.children.length).toBe(10);
  });

  it("moves sources when they're resized", () => {
    const batch = new SpatialBatch(makeMeshBatch);
    const source = makeSource(100, meshAppearance);
    batch.add(source);
    source.appearance = { ...meshAppearance, radius: 1000 } as any;
    batch.updateAppearance(source);
    expect(maxError(batch, [source])).toBeLessThan(1e-3);
    expect(batch.object.children.length).toBe(1);
  });
});

describe("LineBatch", () => {
  it("draws segments in world space", () => {
    const batch = new LineBatch(1, 0.1, true);
    const appearance = {
      color: 0xffffff,
      points: Float32Array.of(0, 0, 0, 1, 1, 1),
      radius: 2,
    };
    const sources = [makeSource(10, appearance), makeSource(20, appearance)];
    sources.forEach((source) => batch.add(source));
    batch.flush();
    // Core and antialiasing passes.
    expect(batch.object.children.length).toBe(2);
    const geometry = (batch.object.children[0] as THREE.Mesh)
      .geometry as THREE.InstancedBufferGeometry;
    expect(geometry.instanceCount).toBe(2);
    const positions = (
      geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute
    ).data.array;
    expect([...positions.slice(0, 12)]).toEqual([
      10, 0, 0, 11, 1, 1, 20, 0, 0, 21, 1, 1,
    ]);
    sources[0].setDisplayed(false);
    batch.flush();
    expect(geometry.instanceCount).toBe(1);
    expect([...positions.slice(0, 6)]).toEqual([20, 0, 0, 21, 1, 1]);
  });
});

describe("GeometryBatch", () => {
  function makeAppearance(size: number): GeometryAppearance {
    return {
      vertices: new Float32Array(size * 3).map((_, i) => size * 1000 + i),
      faces: new Uint32Array(size * 3).map((_, i) => i % size),
      color: 0xffffff,
      scale: [1, 1, 1],
      radius: 1,
    };
  }

  /** Check that everything in a batch is intact. */
  function check(batch: GeometryBatch, sources: Set<InstanceSource>) {
    let numInstances = 0;
    for (const object of batch.object.children) {
      const mesh = object as THREE.BatchedMesh;
      numInstances += mesh.instanceCount;
    }
    expect(numInstances).toBe(sources.size);
    // @ts-ignore Private.
    expect(batch.members.size).toBe(sources.size);
    sources.forEach((source) => {
      // @ts-ignore Private.
      const { shard, geometryId, instanceId } = batch.members.get(source)!;
      const mesh = shard.mesh;
      const { vertices, faces } = source.appearance as GeometryAppearance;
      const range = mesh.getGeometryRangeAt(geometryId)!;
      expect(range.indexCount).toBe(faces.length);
      const position = mesh.geometry.attributes.position;
      const index = mesh.geometry.index!;
      // Spot check.
      for (const i of [0, faces.length >> 1, faces.length - 1]) {
        const vertex = index.getX(range.indexStart + i);
        expect(position.getY(vertex)).toBe(vertices[faces[i] * 3 + 1]);
      }
      expect(mesh.getVisibleAt(instanceId)).toBe(source.displayed);
      const matrix = new THREE.Matrix4();
      mesh.getMatrixAt(instanceId, matrix);
      if (source.displayed) expect(matrix.elements[12]).toBe(source.position.x);
    });
  }

  it("survives churn", () => {
    const batch = new GeometryBatch(
      new THREE.MeshBasicMaterial(),
      false,
      false,
    );
    let state = 1;
    const random = (n: number) => (state = (state * 16807) % 2147483647) % n;
    const alive = new Set<InstanceSource>();
    for (let step = 0; step < 1500; step++) {
      if (random(3) > 0 || alive.size === 0) {
        const source = makeSource(step, makeAppearance(3 + random(400)));
        source.displayed = random(4) > 0;
        batch.add(source);
        alive.add(source);
      } else {
        const source = [...alive][random(alive.size)];
        if (random(2) === 0) {
          batch.remove(source);
          alive.delete(source);
        } else {
          source.setDisplayed(!source.displayed);
        }
      }
      if (step % 250 === 0) check(batch, alive);
    }
    check(batch, alive);
    alive.forEach((source) => batch.remove(source));
    expect(batch.object.children.length).toBe(0);
  });

  it("splits large batches", () => {
    const batch = new GeometryBatch(
      new THREE.MeshBasicMaterial(),
      false,
      false,
    );
    const alive = new Set<InstanceSource>();
    const appearance = makeAppearance(4096);
    for (let i = 0; i < 400; i++) {
      const source = makeSource(i, appearance);
      batch.add(source);
      alive.add(source);
    }
    expect(batch.object.children.length).toBeGreaterThan(1);
    check(batch, alive);
  });
});

describe("markRange", () => {
  it("bounds the number of ranges without losing coverage", () => {
    const attribute = new THREE.BufferAttribute(new Float32Array(10_000), 1);
    for (let i = 0; i < 5000; i++) markRange(attribute, i * 2, 1);
    expect(attribute.updateRanges.length).toBeLessThanOrEqual(256);
    const covered = new Set<number>();
    for (const { start, count } of attribute.updateRanges)
      for (let i = start; i < start + count; i++) covered.add(i);
    for (let i = 0; i < 5000; i++) expect(covered.has(i * 2)).toBe(true);
  });

  it("merges adjacent ranges", () => {
    const attribute = new THREE.BufferAttribute(new Float32Array(100), 1);
    markRange(attribute, 0, 10);
    markRange(attribute, 10, 10);
    expect(attribute.updateRanges).toEqual([{ start: 0, count: 20 }]);
  });
});

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

describe("shadow pass", () => {
  it("collects the topmost visible casters", () => {
    const scene = new THREE.Scene();
    const hidden = new THREE.Group();
    hidden.visible = false;
    const [a, b, nested, light] = [
      new THREE.Mesh(),
      new THREE.Mesh(),
      new THREE.Mesh(),
      new THREE.DirectionalLight(),
    ];
    a.castShadow = b.castShadow = nested.castShadow = light.castShadow = true;
    a.add(nested);
    hidden.add(b);
    scene.add(a, hidden, light, new THREE.Mesh());
    const out: THREE.Object3D[] = [];
    collectShadowCasters(scene, out);
    expect(out).toEqual([a]);
  });

  it("is skipped when there's nothing to draw or clear", () => {
    const render = vi.fn();
    const shadowMap = {
      enabled: true,
      type: THREE.PCFShadowMap,
      render,
    };
    installFastShadowPass({ shadowMap } as any);
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh();
    mesh.castShadow = true;
    const lights = [{ shadow: { map: {} } }];
    const run = () => {
      render.mockClear();
      (shadowMap.render as any)(lights, scene, new THREE.Camera());
      return render.mock.calls.length;
    };
    expect(run()).toBe(1); // Clears.
    expect(run()).toBe(0);
    scene.add(mesh);
    expect(run()).toBe(1);
    expect(run()).toBe(1);
    scene.remove(mesh);
    expect(run()).toBe(1); // Clears.
    expect(run()).toBe(0);
    lights.push({ shadow: { map: {} } });
    expect(run()).toBe(1);
    expect(run()).toBe(0);
    lights[0] = { shadow: { map: null as any } }; // Not allocated yet.
    expect(run()).toBe(1);
    expect(run()).toBe(1);
  });
});

describe("SceneNodeUpdates", () => {
  it("runs handlers of dirty nodes once", () => {
    const updates = new SceneNodeUpdates();
    const handler = vi.fn();
    updates.register("/a", handler);
    updates.markDirty("/a");
    updates.markDirty("/not-mounted");
    updates.flush();
    updates.flush();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("defers nodes that are marked dirty by handlers", () => {
    const updates = new SceneNodeUpdates();
    let count = 0;
    updates.register("/a", () => {
      if (++count < 3) updates.markDirty("/a");
    });
    updates.flush();
    expect(count).toBe(1);
    updates.flush();
    updates.flush();
    updates.flush();
    expect(count).toBe(3);
  });

  it("doesn't unregister successors", () => {
    const updates = new SceneNodeUpdates();
    const successor = vi.fn();
    const unregister = updates.register("/a", () => {});
    updates.register("/a", successor);
    unregister();
    updates.flush();
    expect(successor).toHaveBeenCalledTimes(1);
  });

  it("continues after a handler throws", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const updates = new SceneNodeUpdates();
    const handler = vi.fn();
    updates.register("/a", () => {
      throw new Error("test");
    });
    updates.register("/b", handler);
    updates.flush();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
