import "../patchLineMaterial";
import { LINE_FRINGE_RENDER_ORDER } from "../renderOrders";
import * as THREE from "three";
import {
  LineMaterial,
  LineMaterialParameters,
  LineSegments2,
  LineSegmentsGeometry,
} from "three-stdlib";
import {
  DenseBatch,
  InstanceAppearance,
  InstanceSource,
  markRange,
  matrixRelativeTo,
} from "./AutoInstancer";

export type LineAppearance = InstanceAppearance & {
  color: number;
  /** Endpoints of line segments, in the source's frame. The number of segments
   * needs to be the same for all members of a batch. */
  points: Float32Array;
};

const tempColor = /* @__PURE__ */ new THREE.Color();
const tempMatrix = /* @__PURE__ */ new THREE.Matrix4();
const tempVector = /* @__PURE__ */ new THREE.Vector3();

/** Sets of line segments, merged into a single object. The materials here should
 * match the ones in Line.tsx. */
export class LineBatch extends DenseBatch {
  readonly object = new THREE.Group();
  private geometry: LineSegmentsGeometry | null = null;
  private positions: THREE.InstancedInterleavedBuffer | null = null;
  private colors: THREE.InstancedInterleavedBuffer | null = null;
  private readonly materials: LineMaterial[] = [];

  constructor(
    private readonly numSegments: number,
    lineWidth: number,
    worldUnits: boolean,
  ) {
    super();
    const makeMaterial = (params: LineMaterialParameters) => {
      const material = new LineMaterial({
        color: 0xffffff,
        vertexColors: true,
        linewidth: lineWidth,
        dashed: false,
        ...params,
      });
      material.fog = true;
      material.worldUnits = worldUnits;
      this.materials.push(material);
      return material;
    };
    makeMaterial({ transparent: false });
    if (worldUnits) {
      const fringe = makeMaterial({ transparent: true, depthWrite: false });
      fringe.defines.VISER_LINE_FRINGE = "";
    }
  }

  protected allocate(capacity: number): void {
    this.disposeGeometry();
    const numInstances = capacity * this.numSegments;
    const geometry = new LineSegmentsGeometry();
    const attach = (startName: string, endName: string) => {
      const buffer = new THREE.InstancedInterleavedBuffer(
        new Float32Array(numInstances * 6),
        6,
        1,
      );
      buffer.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(
        startName,
        new THREE.InterleavedBufferAttribute(buffer, 3, 0),
      );
      geometry.setAttribute(
        endName,
        new THREE.InterleavedBufferAttribute(buffer, 3, 3),
      );
      return buffer;
    };
    this.positions = attach("instanceStart", "instanceEnd");
    this.colors = attach("instanceColorStart", "instanceColorEnd");
    // Not culled; only used for sorting.
    geometry.boundingSphere = new THREE.Sphere();
    this.geometry = geometry;
    for (const material of this.materials) {
      const line = new LineSegments2(geometry, material);
      line.frustumCulled = false;
      line.raycast = () => undefined;
      if (material.transparent) line.renderOrder = LINE_FRINGE_RENDER_ORDER;
      this.object.add(line);
    }
  }

  protected setCount(count: number): void {
    this.geometry!.instanceCount = count * this.numSegments;
  }

  protected writeTransform(source: InstanceSource): void {
    const { points } = source.appearance as LineAppearance;
    const buffer = this.positions!;
    const array = buffer.array as Float32Array;
    const start = source.batchIndex * points.length;
    matrixRelativeTo(source.matrixWorld, this.object.position, tempMatrix);
    for (let i = 0; i < points.length; i += 3) {
      tempVector
        .fromArray(points, i)
        .applyMatrix4(tempMatrix)
        .toArray(array, start + i);
    }
    markRange(buffer, start, points.length);
  }

  protected writeAppearance(source: InstanceSource): void {
    const { color, points } = source.appearance as LineAppearance;
    const buffer = this.colors!;
    const array = buffer.array as Float32Array;
    const start = source.batchIndex * points.length;
    tempColor.setHex(color);
    for (let i = 0; i < points.length; i += 3) {
      tempColor.toArray(array, start + i);
    }
    markRange(buffer, start, points.length);
  }

  setViewportSize(width: number, height: number): void {
    for (const material of this.materials) {
      material.resolution.set(width, height);
    }
  }

  private disposeGeometry(): void {
    this.object.clear();
    this.geometry?.dispose();
  }

  dispose(): void {
    this.disposeGeometry();
    this.materials.forEach((material) => material.dispose());
  }
}
