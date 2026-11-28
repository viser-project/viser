import * as THREE from "three";
import {
  DenseBatch,
  InstanceAppearance,
  InstanceSource,
  markRange,
  matrixRelativeTo,
} from "./AutoInstancer";

export type MeshAppearance = InstanceAppearance & {
  color: number;
  scale: [number, number, number];
};

/** Distance of the furthest point from a geometry's origin. */
export function geometryRadius(geometry: THREE.BufferGeometry): number {
  if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
  const { center, radius } = geometry.boundingSphere!;
  return center.length() + radius;
}

const tempBox = /* @__PURE__ */ new THREE.Box3();
const tempMatrix = /* @__PURE__ */ new THREE.Matrix4();
const tempVector = /* @__PURE__ */ new THREE.Vector3();
const tempColor = /* @__PURE__ */ new THREE.Color();

/** Sources that only differ in their transform, scale, and color. */
export class MeshBatch extends DenseBatch {
  readonly object = new THREE.Group();
  private mesh: THREE.InstancedMesh | null = null;
  private needsBounds = true;

  constructor(
    private readonly geometry: THREE.BufferGeometry,
    private readonly material: THREE.Material,
    private readonly castShadow: boolean,
    private readonly receiveShadow: boolean,
  ) {
    super();
  }

  protected allocate(capacity: number): void {
    this.disposeMesh();
    const mesh = new THREE.InstancedMesh(
      this.geometry,
      this.material,
      capacity,
    );
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3),
      3,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = this.castShadow;
    mesh.receiveShadow = this.receiveShadow;
    // Set by updateBounds().
    mesh.frustumCulled = false;
    mesh.boundingSphere = new THREE.Sphere();
    this.needsBounds = true;
    mesh.raycast = () => undefined;
    this.mesh = mesh;
    this.object.add(mesh);
  }

  protected setCount(count: number): void {
    this.mesh!.count = count;
    this.needsBounds = true;
  }

  flush(camera: THREE.Camera): void {
    super.flush(camera);
    if (this.needsBounds) {
      this.needsBounds = false;
      this.updateBounds();
    }
  }

  /** Cull the entire batch when it's out of view. Batches that are cheap to draw
   * aren't worth computing bounds for. */
  private updateBounds(): void {
    const { mesh, geometry } = this;
    if (mesh === null) return;
    const numVertices =
      geometry.index?.count ?? geometry.attributes.position.count;
    mesh.frustumCulled = mesh.count * numVertices > 50_000;
    if (!mesh.frustumCulled) return;

    const radius = geometryRadius(geometry);
    const array = mesh.instanceMatrix.array;
    tempBox.makeEmpty();
    for (let i = 0; i < mesh.count * 16; i += 16) {
      // Frobenius norm: an upper bound for the largest singular value, including
      // when matrices have shear.
      let scaleSq = 0;
      for (let j = 0; j < 11; j++)
        if (j % 4 !== 3) scaleSq += array[i + j] * array[i + j];
      const r = Math.sqrt(scaleSq) * radius;
      const [x, y, z] = [array[i + 12], array[i + 13], array[i + 14]];
      if (!Number.isFinite(x + y + z + r)) {
        mesh.frustumCulled = false;
        return;
      }
      tempBox.expandByPoint(tempVector.set(x - r, y - r, z - r));
      tempBox.expandByPoint(tempVector.set(x + r, y + r, z + r));
    }
    tempBox.getBoundingSphere(mesh.boundingSphere!);
    mesh.boundingSphere!.radius *= 1.0 + 1e-5; // Roundoff.
  }

  protected writeTransform(source: InstanceSource): void {
    this.needsBounds = true;
    const attribute = this.mesh!.instanceMatrix;
    const { scale } = source.appearance as MeshAppearance;
    matrixRelativeTo(source.matrixWorld, this.object.position, tempMatrix)
      .scale(tempVector.fromArray(scale))
      .toArray(attribute.array, source.batchIndex * 16);
    markRange(attribute, source.batchIndex * 16, 16);
  }

  protected writeAppearance(source: InstanceSource): void {
    const attribute = this.mesh!.instanceColor!;
    tempColor
      .setHex((source.appearance as MeshAppearance).color)
      .toArray(attribute.array, source.batchIndex * 3);
    markRange(attribute, source.batchIndex * 3, 3);
  }

  private disposeMesh(): void {
    if (this.mesh === null) return;
    this.object.remove(this.mesh);
    // Frees the instance buffers, but not the geometry or material.
    this.mesh.dispose();
  }

  dispose(): void {
    this.disposeMesh();
    this.material.dispose();
  }
}
