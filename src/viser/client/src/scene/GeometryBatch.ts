import * as THREE from "three";
import {
  computeBoundingSphere,
  computeVertexNormals,
} from "../utils/meshGeometry";
import { InstanceBatch, InstanceSource } from "./AutoInstancer";

export type GeometryAppearance = {
  vertices: Float32Array;
  faces: Uint32Array;
  color: number;
  scale: [number, number, number];
};

/** Vertices that are drawn together. Bounds the cost of growing buffers. */
const MAX_SHARD_VERTICES = 1 << 20;
const INITIAL_SHARD_VERTICES = 1 << 15;
const INITIAL_INSTANCES = 128;

const tempMatrix = /* @__PURE__ */ new THREE.Matrix4();
const tempScale = /* @__PURE__ */ new THREE.Vector3();
const tempColor = /* @__PURE__ */ new THREE.Color();

type Member = { shard: Shard; geometryId: number; instanceId: number };

class Shard {
  readonly mesh: THREE.BatchedMesh;
  numMembers = 0;
  /** Space taken up by geometries that haven't been deleted. */
  private liveVertices = 0;
  private liveIndices = 0;
  /** End of the space that geometries have been allocated from. */
  private endVertices = 0;
  private endIndices = 0;
  private maxVertices: number;
  private maxIndices: number;

  constructor(
    material: THREE.Material,
    castShadow: boolean,
    receiveShadow: boolean,
    numVertices: number,
    numIndices: number,
  ) {
    this.maxVertices = Math.max(INITIAL_SHARD_VERTICES, numVertices);
    this.maxIndices = Math.max(INITIAL_SHARD_VERTICES * 3, numIndices);
    const mesh = new THREE.BatchedMesh(
      INITIAL_INSTANCES,
      this.maxVertices,
      this.maxIndices,
      material,
    );
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    // Individual geometries are culled, but there's no need to keep track of
    // bounds for the batch.
    mesh.frustumCulled = false;
    mesh.boundingSphere = new THREE.Sphere();
    mesh.sortObjects = false;
    mesh.raycast = () => undefined;
    this.mesh = mesh;
  }

  /** Make space for a geometry. Returns false if there isn't any. */
  reserve(numVertices: number, numIndices: number): boolean {
    const fits = () =>
      this.endVertices + numVertices <= this.maxVertices &&
      this.endIndices + numIndices <= this.maxIndices;
    if (!fits()) {
      // Grow, unless compacting would free up a substantial amount of space.
      let maxVertices = this.maxVertices;
      let maxIndices = this.maxIndices;
      while (this.liveVertices + numVertices > 0.75 * maxVertices)
        maxVertices *= 2;
      while (this.liveIndices + numIndices > 0.75 * maxIndices) maxIndices *= 2;
      if (maxVertices > MAX_SHARD_VERTICES && this.numMembers > 0) return false;

      this.mesh.optimize();
      this.endVertices = this.liveVertices;
      this.endIndices = this.liveIndices;
      if (maxVertices !== this.maxVertices || maxIndices !== this.maxIndices) {
        this.mesh.setGeometrySize(maxVertices, maxIndices);
        this.maxVertices = maxVertices;
        this.maxIndices = maxIndices;
      }
    }
    if (this.numMembers === this.mesh.maxInstanceCount) {
      this.mesh.setInstanceCount(2 * this.mesh.maxInstanceCount);
    }
    return true;
  }

  add(geometry: THREE.BufferGeometry): Member {
    this.reserve(geometry.attributes.position.count, geometry.index!.count);
    const geometryId = this.mesh.addGeometry(geometry);
    const instanceId = this.mesh.addInstance(geometryId);
    const range = this.mesh.getGeometryRangeAt(geometryId)!;
    this.endVertices = range.vertexStart + range.reservedVertexCount;
    this.endIndices = range.indexStart + range.reservedIndexCount;
    this.liveVertices += range.reservedVertexCount;
    this.liveIndices += range.reservedIndexCount;
    this.numMembers += 1;
    return { shard: this, geometryId, instanceId };
  }

  remove(member: Member): void {
    const range = this.mesh.getGeometryRangeAt(member.geometryId)!;
    this.liveVertices -= range.reservedVertexCount;
    this.liveIndices -= range.reservedIndexCount;
    this.numMembers -= 1;
    this.mesh.deleteGeometry(member.geometryId); // Includes its instance.
  }
}

/** Meshes with different geometries, but otherwise similar materials. */
export class GeometryBatch implements InstanceBatch {
  readonly object = new THREE.Group();
  private readonly shards = new Set<Shard>();
  private readonly members = new Map<InstanceSource, Member>();

  constructor(
    private readonly material: THREE.Material,
    private readonly castShadow: boolean,
    private readonly receiveShadow: boolean,
  ) {}

  add(source: InstanceSource): void {
    source.batch = this;
    const { vertices, faces } = source.appearance as GeometryAppearance;
    let shard: Shard | null = null;
    for (const candidate of this.shards) {
      if (candidate.reserve(vertices.length / 3, faces.length)) {
        shard = candidate;
        break;
      }
    }
    if (shard === null) {
      shard = new Shard(
        this.material,
        this.castShadow,
        this.receiveShadow,
        vertices.length / 3,
        faces.length,
      );
      this.shards.add(shard);
      this.object.add(shard.mesh);
    }

    // Temporary: contents are copied into the batch.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(computeVertexNormals(vertices, faces), 3),
    );
    geometry.setIndex(new THREE.BufferAttribute(faces, 1));
    geometry.boundingSphere = computeBoundingSphere(vertices);

    const member = shard.add(geometry);
    this.members.set(source, member);
    this.writeColor(source, member);
    this.updateTransform(source);
  }

  remove(source: InstanceSource): void {
    source.batch = null;
    const member = this.members.get(source);
    if (member === undefined) return;
    this.members.delete(source);
    const { shard } = member;
    shard.remove(member);
    if (shard.numMembers === 0) {
      this.shards.delete(shard);
      this.object.remove(shard.mesh);
      shard.mesh.dispose();
    }
  }

  updateTransform(source: InstanceSource): void {
    const member = this.members.get(source)!;
    const { mesh } = member.shard;
    const visible = source.displayed;
    if (mesh.getVisibleAt(member.instanceId) !== visible)
      mesh.setVisibleAt(member.instanceId, visible);
    if (!visible) return;
    const { scale } = source.appearance as GeometryAppearance;
    mesh.setMatrixAt(
      member.instanceId,
      tempMatrix
        .copy(source.matrixWorld)
        .scale(tempScale.set(scale[0], scale[1], scale[2])),
    );
  }

  private writeColor(source: InstanceSource, member: Member): void {
    const { color } = source.appearance as GeometryAppearance;
    member.shard.mesh.setColorAt(member.instanceId, tempColor.setHex(color));
  }

  updateAppearance(source: InstanceSource): void {
    // Meshes whose geometry changes shouldn't be batched; see BasicMesh.
    this.writeColor(source, this.members.get(source)!);
    this.updateTransform(source);
  }

  setViewportSize(): void {}

  dispose(): void {
    this.shards.forEach((shard) => shard.mesh.dispose());
    this.material.dispose();
  }
}
