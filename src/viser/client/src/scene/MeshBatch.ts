import * as THREE from "three";
import {
  DenseBatch,
  InstanceAppearance,
  InstanceSource,
  matrixRelativeTo,
} from "./AutoInstancer";
import { CulledInstances } from "./CulledInstances";

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

const tempMatrix = /* @__PURE__ */ new THREE.Matrix4();
const tempVector = /* @__PURE__ */ new THREE.Vector3();
const tempColor = /* @__PURE__ */ new THREE.Color();

/** Sources that only differ in their transform, scale, and color. */
export class MeshBatch extends DenseBatch {
  readonly object = new THREE.Group();
  private instances: CulledInstances | null = null;

  constructor(
    private readonly geometry: THREE.BufferGeometry,
    private readonly material: THREE.Material,
    private readonly castShadow: boolean,
    private readonly receiveShadow: boolean,
  ) {
    super();
  }

  protected allocate(capacity: number): void {
    this.object.clear();
    this.instances?.dispose();
    this.instances = new CulledInstances(
      this.geometry,
      this.material,
      capacity,
    );
    this.instances.castShadow = this.castShadow;
    this.instances.receiveShadow = this.receiveShadow;
    this.object.add(this.instances);
  }

  protected setCount(count: number): void {
    this.instances!.count = count;
    this.instances!.markAllDirty();
  }

  flush(camera: THREE.Camera): void {
    super.flush(camera);
    this.instances?.beginRender();
  }

  protected writeTransform(source: InstanceSource): void {
    const { matrices, spheres } = this.instances!;
    const { scale } = source.appearance as MeshAppearance;
    tempMatrix.copy(source.matrixWorld).scale(tempVector.fromArray(scale));
    const { elements } = tempMatrix;
    // Frobenius norm: an upper bound for the largest singular value, including
    // when matrices have shear.
    let scaleSq = 0;
    for (let i = 0; i < 11; i++)
      if (i % 4 !== 3) scaleSq += elements[i] * elements[i];
    const radius = Math.sqrt(scaleSq) * geometryRadius(this.geometry);
    spheres.set(
      // Margin for roundoff.
      [elements[12], elements[13], elements[14], radius * 1.001],
      source.batchIndex * 4,
    );
    matrixRelativeTo(tempMatrix, this.object.position, tempMatrix).toArray(
      matrices,
      source.batchIndex * 16,
    );
    this.instances!.markDirty(source.batchIndex);
  }

  protected writeAppearance(source: InstanceSource): void {
    tempColor
      .setHex((source.appearance as MeshAppearance).color)
      .toArray(this.instances!.colors, source.batchIndex * 3);
    this.instances!.markDirty(source.batchIndex);
  }

  dispose(): void {
    this.object.clear();
    this.instances?.dispose();
    this.material.dispose();
  }
}
