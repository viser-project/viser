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
const tempBox = /* @__PURE__ */ new THREE.Box3();

/** Centers of bounding boxes, which are used for sorting. */
const centerFromPoints = new WeakMap<Float32Array, THREE.Vector3>();
function getCenter(points: Float32Array): THREE.Vector3 {
  let center = centerFromPoints.get(points);
  if (center === undefined) {
    center = tempBox.setFromArray(points).getCenter(new THREE.Vector3());
    centerFromPoints.set(points, center);
  }
  return center;
}

/** Sets of line segments, merged into a single object. The materials here should
 * match the ones in Line.tsx. */
export class LineBatch extends DenseBatch {
  readonly object = new THREE.Group();
  private readonly core: LinePass;
  /** Antialiasing skirts, for lines in world units. They're transparent, so they
   * have their own geometry which is sorted for each camera. */
  private readonly fringe: LinePass | null = null;
  private fringeOrder: InstanceSource[] = [];
  private needsFringeUpdate = true;

  constructor(
    private readonly numSegments: number,
    lineWidth: number,
    worldUnits: boolean,
  ) {
    super();
    const params = { linewidth: lineWidth, worldUnits };
    this.core = new LinePass({ ...params, transparent: false });
    if (worldUnits) {
      this.fringe = new LinePass({
        ...params,
        transparent: true,
        depthWrite: false,
      });
      this.fringe.material.defines.VISER_LINE_FRINGE = "";
    }
  }

  protected allocate(capacity: number): void {
    this.object.clear();
    this.object.add(this.core.allocate(capacity * this.numSegments));
    if (this.fringe !== null) {
      const line = this.fringe.allocate(capacity * this.numSegments);
      line.renderOrder = LINE_FRINGE_RENDER_ORDER;
      this.object.add(line);
    }
  }

  protected setCount(count: number): void {
    this.core.geometry!.instanceCount = count * this.numSegments;
    if (this.fringe !== null)
      this.fringe.geometry!.instanceCount = count * this.numSegments;
    this.needsFringeUpdate = true;
  }

  protected writeTransform(source: InstanceSource): void {
    const { points } = source.appearance as LineAppearance;
    const buffer = this.core.positions!;
    const start = source.batchIndex * points.length;
    matrixRelativeTo(source.matrixWorld, this.object.position, tempMatrix);
    for (let i = 0; i < points.length; i += 3) {
      tempVector
        .fromArray(points, i)
        .applyMatrix4(tempMatrix)
        .toArray(buffer.array, start + i);
    }
    markRange(buffer, start, points.length);
    this.needsFringeUpdate = true;
  }

  protected writeAppearance(source: InstanceSource): void {
    const { color, points } = source.appearance as LineAppearance;
    const buffer = this.core.colors!;
    const start = source.batchIndex * points.length;
    tempColor.setHex(color);
    for (let i = 0; i < points.length; i += 3) {
      tempColor.toArray(buffer.array, start + i);
    }
    markRange(buffer, start, points.length);
    this.needsFringeUpdate = true;
  }

  flush(camera: THREE.Camera): void {
    super.flush(camera);
    if (this.fringe !== null && this.core.geometry !== null)
      this.sortFringe(this.fringe, camera);
  }

  /** Sort skirts in the same way that three.js would if they were separate
   * transparent objects. */
  private sortFringe(fringe: LinePass, camera: THREE.Camera): void {
    tempMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    const e = tempMatrix.elements;
    const items: { source: InstanceSource; z: number }[] = [];
    this.members.forEach((source) => {
      if (source.batchIndex === -1) return;
      const { points } = source.appearance as LineAppearance;
      const { x, y, z } = tempVector
        .copy(getCenter(points))
        .applyMatrix4(source.matrixWorld);
      items.push({ source, z: e[2] * x + e[6] * y + e[10] * z + e[14] });
    });
    items.sort((a, b) => b.z - a.z || a.source.id - b.source.id);

    const order = this.fringeOrder;
    if (
      !this.needsFringeUpdate &&
      items.length === order.length &&
      items.every(({ source }, i) => source === order[i])
    )
      return;
    this.needsFringeUpdate = false;
    this.fringeOrder = items.map(({ source }) => source);
    const size = this.numSegments * 6;
    for (const [from, to] of [
      [this.core.positions!, fringe.positions!],
      [this.core.colors!, fringe.colors!],
    ]) {
      const array = from.array as Float32Array;
      items.forEach(({ source: { batchIndex } }, i) =>
        (to.array as Float32Array).set(
          array.subarray(batchIndex * size, (batchIndex + 1) * size),
          i * size,
        ),
      );
      markRange(to, 0, items.length * size);
    }
  }

  setViewportSize(width: number, height: number): void {
    this.core.material.resolution.set(width, height);
    this.fringe?.material.resolution.set(width, height);
  }

  dispose(): void {
    this.object.clear();
    this.core.dispose();
    this.fringe?.dispose();
  }
}

/** Geometry and material for line segments that are drawn together. */
class LinePass {
  readonly material: LineMaterial;
  geometry: LineSegmentsGeometry | null = null;
  positions: THREE.InstancedInterleavedBuffer | null = null;
  colors: THREE.InstancedInterleavedBuffer | null = null;

  constructor(params: LineMaterialParameters) {
    this.material = new LineMaterial({
      color: 0xffffff,
      vertexColors: true,
      dashed: false,
      ...params,
    });
    this.material.fog = true;
    this.material.worldUnits = params.worldUnits ?? false;
  }

  /** Returns an object to draw. Contents need to be written afterwards. */
  allocate(numSegments: number): LineSegments2 {
    this.geometry?.dispose();
    const geometry = new LineSegmentsGeometry();
    const attach = (startName: string, endName: string) => {
      const buffer = new THREE.InstancedInterleavedBuffer(
        new Float32Array(numSegments * 6),
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

    const line = new LineSegments2(geometry, this.material);
    line.frustumCulled = false;
    line.raycast = () => undefined;
    return line;
  }

  dispose(): void {
    this.geometry?.dispose();
    this.material.dispose();
  }
}
