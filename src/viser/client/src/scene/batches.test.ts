import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { LineSegments2, LineSegmentsGeometry } from "three-stdlib";
import {
  AutoInstancer,
  InstanceAppearance,
  SpatialBatch,
  InstanceBatch,
  InstanceSource,
  markRange,
} from "./AutoInstancer";
import { CulledInstances } from "./CulledInstances";
import { geometryRadius, MeshAppearance, MeshBatch } from "./MeshBatch";
import { GeometryAppearance, GeometryBatch } from "./GeometryBatch";
import { LineBatch } from "./LineBatch";

const camera = new THREE.PerspectiveCamera();

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

/** Contains everything. */
const everything = new THREE.Frustum();
everything.planes.forEach((plane) => plane.set(new THREE.Vector3(), Infinity));

/** What three.js would draw. */
function drawnMeshes(
  object: THREE.Object3D,
  frustum = everything,
): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  const project = (child: THREE.Object3D) => {
    if (child instanceof CulledInstances)
      expect(child.intersectsFrustum(frustum)).toBe(false);
    if (child instanceof THREE.InstancedMesh) out.push(child);
    child.children.forEach(project);
  };
  project(object);
  return out;
}

/** Positions that a mesh batch draws, sorted. */
function drawnPositions(batch: MeshBatch): number[] {
  batch.flush(camera);
  const matrix = new THREE.Matrix4();
  const out: number[] = [];
  drawnMeshes(batch.object).forEach((mesh) => {
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      out.push(matrix.elements[12]);
    }
  });
  return out.sort((a, b) => a - b);
}

const meshAppearance: MeshAppearance = {
  color: 0xff0000,
  scale: [1, 2, 3],
  radius: 1,
};
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

  it("stops batching sources that are too spread out", () => {
    vi.useFakeTimers();
    const instancer = new AutoInstancer();
    const entry = instancer.getEntry("key", makeMeshBatch);
    const sources = Array.from({ length: 100 }, (_, i) =>
      makeSource(i, meshAppearance),
    );
    sources.forEach((source) => entry.add(source));
    instancer.flush(camera);
    expect(entry.isActive()).toBe(true);

    sources.forEach((source, i) => {
      source.position.x = i * 1e6;
      source.updateMatrix();
      source.updateMatrixWorld();
    });
    const listener = vi.fn();
    entry.subscribe(listener);
    instancer.flush(camera);
    // Drawn by the batch until members had time to draw themselves.
    expect(entry.isActive()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(instancer.group.children.length).toBe(1);
    sources[0].setDisplayed(false);
    entry.remove(sources[1]);
    instancer.flush(camera);
    expect(instancer.group.children.length).toBe(1);
    vi.runAllTimers();
    vi.useRealTimers();
    instancer.flush(camera);
    expect(instancer.group.children.length).toBe(0);
    expect(sources[2].batch).toBe(null);

    entry.add(sources[1]);
    instancer.flush(camera);
    expect(entry.isActive()).toBe(false);

    // Tried again when there are a lot more.
    const more = Array.from({ length: 100 }, (_, i) =>
      makeSource(i, meshAppearance),
    );
    more.forEach((source) => entry.add(source));
    expect(entry.isActive()).toBe(true);
    more.forEach((source) => entry.remove(source));
    sources.forEach((source) => entry.remove(source));
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
    batch.flush(camera);
    const [mesh] = drawnMeshes(batch.object);
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
    batch.flush(camera);
    expect(drawnMeshes(batch.object)).toEqual([mesh]);
    mesh.getColorAt(0, color);
    expect(color.getHex()).toBe(0x00ff00);
  });
});

describe("culling", () => {
  it("matches a reference, across cameras and changes", () => {
    let seed = 1;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const randomPosition = (out: THREE.Vector3) =>
      out.set(random(), random(), random()).multiplyScalar(20).subScalar(10);
    const geometry = new THREE.IcosahedronGeometry(1, 3);
    const batch = new MeshBatch(
      geometry,
      new THREE.MeshBasicMaterial(),
      true,
      false,
    );
    batch.object.position.set(1, 2, 3);
    batch.object.updateMatrixWorld();
    const parent = new THREE.Group();
    parent.scale.set(1, 0.5, 2);
    parent.rotation.set(1, 2, 3);
    parent.updateMatrix();
    parent.updateMatrixWorld();
    const sources = Array.from({ length: 200 }, (_, i) => {
      const source = makeSource(i, meshAppearance);
      parent.add(source);
      randomPosition(source.position);
      source.updateMatrix();
      source.updateMatrixWorld();
      batch.add(source);
      return source;
    });
    const makeFrustum = () => {
      const camera = new THREE.PerspectiveCamera(40);
      randomPosition(camera.position);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      return new THREE.Frustum().setFromProjectionMatrix(
        camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse),
      );
    };
    const frustums = [makeFrustum(), makeFrustum(), makeFrustum()];

    // What's on the GPU, for each attribute.
    const uploaded = new Map<THREE.BufferAttribute, Float32Array>();
    const upload = (attribute: THREE.BufferAttribute) => {
      const array = attribute.array as Float32Array;
      const buffer = uploaded.get(attribute);
      if (buffer === undefined) {
        uploaded.set(attribute, array.slice());
      } else {
        attribute.updateRanges.forEach(({ start, count }) =>
          buffer.set(array.subarray(start, start + count), start),
        );
      }
      attribute.clearUpdateRanges();
    };

    const reference = new THREE.Mesh(geometry);
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    let numCulled = 0;
    for (let step = 0; step < 200; step++) {
      for (let i = 0; i < Math.floor(random() * 4); i++) {
        const source = sources[Math.floor(random() * 200)];
        const action = Math.floor(random() * 5);
        if (action === 0) {
          source.setDisplayed(!source.displayed);
        } else if (action === 1) {
          source.appearance = {
            color: Math.floor(random() * 0xffffff),
            scale: [random(), random(), random()],
            radius: 1,
          } as MeshAppearance;
          batch.updateAppearance(source);
        } else {
          randomPosition(source.position);
          source.updateMatrix();
          source.updateMatrixWorld();
        }
      }
      if (step % 10 === 0) frustums[step % 3] = makeFrustum();
      batch.flush(camera);
      frustums.forEach((frustum) => {
        const [mesh] = drawnMeshes(batch.object, frustum);
        upload(mesh.instanceMatrix);
        upload(mesh.instanceColor!);
        const matrices = uploaded.get(mesh.instanceMatrix)!;
        const colors = uploaded.get(mesh.instanceColor!)!;
        let slot = 0;
        sources.forEach((source) => {
          const { scale, color: hex } = source.appearance as MeshAppearance;
          reference.matrixWorld
            .copy(source.matrixWorld)
            .scale(new THREE.Vector3(...scale));
          const drawn =
            slot < mesh.count &&
            matrix
              .fromArray(matrices, slot * 16)
              .premultiply(batch.object.matrixWorld)
              .elements.every(
                (v, i) =>
                  Math.abs(v - reference.matrixWorld.elements[i]) < 1e-5,
              );
          if (!source.displayed) expect(drawn).toBe(false);
          else if (frustum.intersectsObject(reference))
            expect(drawn).toBe(true);
          else if (!drawn) numCulled += 1;
          if (!drawn) return;
          color.fromArray(colors, slot * 3);
          expect(color.getHex()).toBe(hex);
          slot += 1;
        });
        expect(mesh.count).toBe(slot);
      });
    }
    expect(numCulled / (200 * 3 * 200)).toBeGreaterThan(0.3);
  });

  it("doesn't cull when bounds are unknown", () => {
    const batch = new MeshBatch(
      new THREE.IcosahedronGeometry(1, 3),
      new THREE.MeshBasicMaterial(),
      true,
      false,
    );
    const sources = Array.from({ length: 100 }, (_, i) =>
      makeSource(i === 5 ? NaN : i, meshAppearance),
    );
    sources.forEach((source) => batch.add(source));
    const frustum = new THREE.Frustum();
    frustum.planes.forEach((plane) =>
      plane.set(new THREE.Vector3(1, 0, 0), -90),
    );
    batch.flush(camera);
    const [mesh] = drawnMeshes(batch.object, frustum);
    // In addition to the ones at x >= 90 - radius.
    const radius = 1.001 * Math.sqrt(1 + 4 + 9) * geometryRadius(mesh.geometry);
    expect(mesh.count).toBe(1 + 10 + Math.floor(radius));
  });

  it("isn't used when drawing is cheap", () => {
    const batch = makeMeshBatch();
    for (let i = 0; i < 100; i++) batch.add(makeSource(i, meshAppearance));
    const nothing = new THREE.Frustum();
    nothing.planes.forEach((plane) =>
      plane.set(new THREE.Vector3(), -Infinity),
    );
    batch.flush(camera);
    expect(drawnMeshes(batch.object, nothing)[0].count).toBe(100);
  });

  it("has separate buffers for each camera, and frees them", () => {
    const batch = makeMeshBatch();
    batch.add(makeSource(0, meshAppearance));
    batch.flush(camera);
    const meshes = [0, 1, 2].map(() => drawnMeshes(batch.object)[0]);
    expect(new Set(meshes).size).toBe(3);
    const onDispose = vi.fn();
    meshes.forEach((mesh) => mesh.addEventListener("dispose", onDispose));
    batch.flush(camera);
    expect(drawnMeshes(batch.object)).toEqual([meshes[0]]);
    expect(onDispose).toHaveBeenCalledTimes(0);
    batch.flush(camera);
    expect(onDispose).toHaveBeenCalledTimes(2);
    batch.flush(camera); // Hidden.
    batch.flush(camera);
    expect(onDispose).toHaveBeenCalledTimes(2);
    batch.dispose();
    expect(onDispose).toHaveBeenCalledTimes(3);
  });

  it("doesn't accumulate changes when there are no renders", () => {
    const batch = makeMeshBatch();
    const source = makeSource(0, meshAppearance);
    batch.add(source);
    batch.flush(camera);
    const [mesh] = drawnMeshes(batch.object);
    mesh.instanceColor!.clearUpdateRanges();
    for (let i = 1; i <= 1000; i++) {
      source.appearance = { ...meshAppearance, color: i } as MeshAppearance;
      batch.updateAppearance(source);
    }
    batch.flush(camera);
    drawnMeshes(batch.object);
    const color = new THREE.Color();
    mesh.getColorAt(0, color);
    expect(color.getHex()).toBe(1000);
    expect(mesh.instanceColor!.updateRanges.length).toBe(1);
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
      batch.flush(camera);
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
    batch.flush(camera);
    batch.object.updateMatrixWorld();
    const drawn: number[] = [];
    drawnMeshes(batch.object).forEach((mesh) => {
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
      batch.add(makeSource(i * 1000, { ...meshAppearance, radius: 500 }));
    expect(batch.object.children.length).toBe(1);
    // Small objects that are far apart.
    const small = new SpatialBatch(makeMeshBatch);
    for (let i = 0; i < 10; i++)
      small.add(makeSource(i * 10_000, { ...meshAppearance, radius: 0.01 }));
    expect(small.object.children.length).toBe(10);
  });

  it("accounts for scales of parents", () => {
    const batch = new SpatialBatch(makeMeshBatch);
    const parent = new THREE.Group();
    parent.scale.setScalar(0.001);
    parent.position.x = 900.3337;
    const sources = Array.from({ length: 100 }, (_, i) =>
      makeSource(i * 0.37, meshAppearance),
    );
    sources.forEach((source) => {
      parent.add(source);
      batch.add(source);
    });
    parent.updateMatrixWorld(true);
    expect(maxError(batch, sources)).toBeLessThan(1e-3 * 0.001);

    // Cells are coarser for larger objects, and the other way around.
    parent.scale.setScalar(1);
    parent.position.x = 4e6;
    parent.updateMatrixWorld(true);
    expect(maxError(batch, sources)).toBeLessThan(1e-3);
    expect(batch.object.children.length).toBe(1);
  });

  it("doesn't split up small objects that are sparse", () => {
    const batch = new SpatialBatch(makeMeshBatch);
    for (let i = 0; i < 1000; i++) {
      const source = makeSource(5 * (i % 10), {
        ...meshAppearance,
        radius: 0.005,
      });
      source.position.y = 5 * (Math.floor(i / 10) % 10);
      source.position.z = 5 * Math.floor(i / 100);
      source.updateMatrix();
      source.updateMatrixWorld();
      batch.add(source);
    }
    expect(batch.object.children.length).toBeLessThanOrEqual(8);
  });

  it("doesn't move sources without a size unnecessarily", () => {
    const batch = new SpatialBatch(makeMeshBatch);
    const source = makeSource(0, { ...meshAppearance, radius: 0 });
    batch.add(source);
    const cell = batch.object.children[0];
    source.position.x = 10;
    source.updateMatrix();
    source.updateMatrixWorld();
    expect(batch.object.children).toEqual([cell]);
  });

  it("preserves draw order between sources of different sizes", () => {
    const batch = new SpatialBatch(makeMeshBatch);
    const sources = [100, 0.01, 10, 0.1, 1].map((radius) =>
      makeSource(5, { ...meshAppearance, radius }),
    );
    sources.forEach((source) => batch.add(source));
    batch.flush(camera);
    expect(batch.object.children.length).toBe(1);
    expect(sources.map((source) => source.batchIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it("preserves draw order when sources leave a cell and return", () => {
    const batch = new SpatialBatch(makeMeshBatch);
    const sources = Array.from({ length: 5 }, () =>
      makeSource(0, meshAppearance),
    );
    sources.forEach((source) => batch.add(source));
    for (const x of [1e7, 0]) {
      sources[1].position.x = x;
      sources[1].updateMatrix();
      sources[1].updateMatrixWorld();
      batch.flush(camera);
    }
    expect(sources.map((source) => source.batchIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it("moves sources when they're resized", () => {
    const batch = new SpatialBatch(makeMeshBatch);
    const source = makeSource(100, meshAppearance);
    batch.add(source);
    source.appearance = { ...meshAppearance, radius: 1000 };
    batch.updateAppearance(source);
    expect(maxError(batch, [source])).toBeLessThan(1e-3);
    expect(batch.object.children.length).toBe(1);
  });
});

describe("LineBatch", () => {
  it("draws segments in world space", () => {
    const batch = new LineBatch(1, true);
    const appearance = {
      color: 0xffffff,
      thickness: 0.1,
      points: Float32Array.of(0, 0, 0, 1, 1, 1),
      radius: 2,
    };
    const sources = [makeSource(10, appearance), makeSource(20, appearance)];
    sources.forEach((source) => batch.add(source));
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(15, 0, 50);
    camera.updateMatrixWorld();
    batch.flush(camera);
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
    batch.flush(camera);
    expect(geometry.instanceCount).toBe(1);
    expect([...positions.slice(0, 6)]).toEqual([20, 0, 0, 21, 1, 1]);
  });

  it("culls the same lines as three.js", () => {
    const points = Float32Array.of(0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 0, 0);
    const batch = new LineBatch(2, true);
    const sources = Array.from({ length: 200 }, (_, i) =>
      makeSource(i - 100, {
        color: 0xffffff,
        thickness: 0.1,
        points,
        radius: 2,
      } as InstanceAppearance),
    );
    sources.forEach((source) => batch.add(source));
    const line = new LineSegments2(new LineSegmentsGeometry());
    line.geometry.setPositions(points);
    const camera = new THREE.PerspectiveCamera();
    const frustum = new THREE.Frustum();
    for (let i = 0; i < 20; i++) {
      camera.position.set(9.7 * i - 100, i % 3, 5);
      camera.rotation.y = i;
      camera.updateMatrixWorld();
      frustum.setFromProjectionMatrix(
        camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse),
      );
      batch.flush(camera);
      const expected = sources.filter(({ matrixWorld }) => {
        line.matrixWorld.copy(matrixWorld);
        return frustum.intersectsObject(line);
      });
      const [core, fringe] = batch.object.children.map(
        (child) =>
          (child as THREE.Mesh).geometry as THREE.InstancedBufferGeometry,
      );
      expect(core.instanceCount).toBe(2 * expected.length);
      expect(fringe.instanceCount).toBe(2 * expected.length);
      const positions = (
        core.attributes.instanceStart as THREE.InterleavedBufferAttribute
      ).data.array;
      expect(expected.map((_, j) => positions[j * 12])).toEqual(
        expected.map((source) => source.position.x),
      );
    }
  });
});

describe("LineBatch sorting", () => {
  it("orders skirts like three.js orders transparent objects", () => {
    const batch = new LineBatch(1, true);
    const appearance = {
      color: 0xffffff,
      thickness: 0.1,
      points: Float32Array.of(0, 0, 0, 1, 1, 1),
      radius: 2,
    };
    const sources = [0, 1, 2, 3].map((z) => {
      const source = makeSource(0, appearance);
      source.position.z = [5, -5, 0, 0][z];
      source.updateMatrix();
      source.updateMatrixWorld();
      batch.add(source);
      return source;
    });
    const camera = new THREE.PerspectiveCamera();
    const check = () => {
      camera.updateMatrixWorld();
      batch.flush(camera);
      const [core, fringe] = batch.object.children as THREE.Mesh[];
      const drawn = (line: THREE.Mesh) => {
        const positions = (
          line.geometry.attributes
            .instanceStart as THREE.InterleavedBufferAttribute
        ).data.array;
        return [0, 1, 2, 3].map((i) => positions[i * 6 + 2]);
      };
      expect(drawn(core)).toEqual(sources.map((s) => s.position.z));

      // What three.js does, see WebGLRenderer.projectObject().
      const projection = new THREE.Matrix4().multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      );
      const expected = sources
        .map((source) => ({
          z: source.position.z,
          key:
            new THREE.Vector4(0.5, 0.5, 0.5, 1.0)
              .applyMatrix4(source.matrixWorld)
              .applyMatrix4(projection).z * (camera.reversedDepth ? -1 : 1),
        }))
        .sort((a, b) => b.key - a.key);
      expect(drawn(fringe)).toEqual(expected.map(({ z }) => z));
    };
    camera.position.z = 20;
    check();
    // What three.js does when rendering with a reversed depth buffer.
    // @ts-ignore Private.
    camera._reversedDepth = true;
    camera.updateProjectionMatrix();
    expect(camera.reversedDepth).toBe(true);
    check();
    camera.position.z = -20;
    camera.rotation.y = Math.PI;
    check();
    sources[2].position.z = 7;
    sources[2].updateMatrix();
    sources[2].updateMatrixWorld();
    check();
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

  it("draws in order of creation", () => {
    const batch = new GeometryBatch(
      new THREE.MeshBasicMaterial(),
      false,
      false,
    );
    const sources = [0, 0, 0, 0].map((x) => makeSource(x, makeAppearance(3)));
    sources.forEach((source) => batch.add(source));
    // Instance ids are reused, so they don't determine the order.
    batch.remove(sources[0]);
    batch.remove(sources[2]);
    batch.add(sources[2]);
    batch.add(sources[0]);
    // @ts-ignore Private.
    const members = batch.members;
    const mesh = batch.object.children[0] as THREE.BatchedMesh;
    const list = sources.map((source, i) => ({
      z: (i * 7) % 4,
      index: members.get(source)!.instanceId,
    }));
    list.reverse();
    // @ts-ignore Only for tests.
    mesh.customSort(list);
    expect(list.map(({ index }) => index)).toEqual(
      sources.map((source) => members.get(source)!.instanceId),
    );
    expect(mesh.sortObjects).toBe(true);
  });

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
