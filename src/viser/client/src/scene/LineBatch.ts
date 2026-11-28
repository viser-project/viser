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
  thickness: number;
  /** Endpoints of line segments, in the source's frame. The number of segments
   * needs to be the same for all members of a batch. */
  points: Float32Array;
};

const tempColor = /* @__PURE__ */ new THREE.Color();
const tempMatrix = /* @__PURE__ */ new THREE.Matrix4();
const tempVector = /* @__PURE__ */ new THREE.Vector3();
const tempBox = /* @__PURE__ */ new THREE.Box3();
const tempSphere = /* @__PURE__ */ new THREE.Sphere();
const tempFrustum = /* @__PURE__ */ new THREE.Frustum();

/** Bounding spheres, computed like LineSegmentsGeometry.computeBoundingSphere(). */
const boundsFromPoints = new WeakMap<Float32Array, THREE.Sphere>();
function getBounds(points: Float32Array): THREE.Sphere {
  let bounds = boundsFromPoints.get(points);
  if (bounds === undefined) {
    const center = tempBox.setFromArray(points).getCenter(new THREE.Vector3());
    let radiusSq = 0;
    for (let i = 0; i < points.length; i += 3) {
      tempVector.fromArray(points, i);
      radiusSq = Math.max(radiusSq, center.distanceToSquared(tempVector));
    }
    bounds = new THREE.Sphere(center, Math.sqrt(radiusSq));
    boundsFromPoints.set(points, bounds);
  }
  return bounds;
}

/** Sets of line segments, merged into a single object. This includes ones with
 * different widths, because skirts are only sorted within a batch. The materials here should
 * match the ones in Line.tsx. */
export class LineBatch extends DenseBatch {
  readonly object = new THREE.Group();
  private readonly core: LinePass;
  /** Antialiasing skirts. They're transparent, so they have their own geometry
   * which is sorted for each camera. */
  private readonly fringe: LinePass | null = null;
  private positions = new Float32Array(0);
  private colors = new Float32Array(0);
  private widths = new Float32Array(0);

  constructor(
    private readonly numSegments: number,
    worldUnits: boolean,
    /** Whether to draw antialiasing skirts. Only for world units. */
    skirts: boolean,
  ) {
    super();
    const params = { worldUnits };
    this.core = new LinePass({ ...params, transparent: false });
    if (skirts) {
      this.fringe = new LinePass({
        ...params,
        transparent: true,
        depthWrite: false,
      });
      this.fringe.material.defines.VISER_LINE_FRINGE = "";
    }
  }

  protected allocate(capacity: number): void {
    const numSegments = capacity * this.numSegments;
    this.positions = new Float32Array(numSegments * 6);
    this.colors = new Float32Array(numSegments * 6);
    this.widths = new Float32Array(numSegments);
    this.object.clear();
    this.object.add(this.core.allocate(numSegments));
    if (this.fringe !== null) {
      const line = this.fringe.allocate(numSegments);
      line.renderOrder = LINE_FRINGE_RENDER_ORDER;
      this.object.add(line);
    }
  }

  private markDirty(): void {
    this.core.needsUpdate = true;
    if (this.fringe !== null) this.fringe.needsUpdate = true;
  }

  protected setCount(): void {
    this.markDirty();
  }

  protected writeTransform(source: InstanceSource): void {
    const { points } = source.appearance as LineAppearance;
    const start = source.batchIndex * points.length;
    matrixRelativeTo(source.matrixWorld, this.object.position, tempMatrix);
    for (let i = 0; i < points.length; i += 3) {
      tempVector
        .fromArray(points, i)
        .applyMatrix4(tempMatrix)
        .toArray(this.positions, start + i);
    }
    this.markDirty();
  }

  protected writeAppearance(source: InstanceSource): void {
    const { color, points, thickness } = source.appearance as LineAppearance;
    const firstSegment = source.batchIndex * this.numSegments;
    this.widths.fill(thickness, firstSegment, firstSegment + this.numSegments);
    const start = source.batchIndex * points.length;
    tempColor.setHex(color);
    for (let i = 0; i < points.length; i += 3) {
      tempColor.toArray(this.colors, start + i);
    }
    this.markDirty();
  }

  flush(camera: THREE.Camera): void {
    super.flush(camera);
    if (this.core.geometry === null) return;

    // Cull lines, and sort skirts, in the same way that three.js would if they
    // were separate objects.
    tempMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    tempFrustum.setFromProjectionMatrix(
      tempMatrix,
      THREE.WebGLCoordinateSystem,
      camera.reversedDepth,
    );
    const e = tempMatrix.elements;
    const items: { source: InstanceSource; z: number }[] = [];
    this.members.forEach((source) => {
      if (source.batchIndex === -1) return;
      const { points } = source.appearance as LineAppearance;
      const bounds = tempSphere
        .copy(getBounds(points))
        .applyMatrix4(source.matrixWorld);
      if (!tempFrustum.intersectsSphere(bounds)) return;
      const { x, y, z } = bounds.center;
      const depth = e[2] * x + e[6] * y + e[10] * z + e[14];
      items.push({ source, z: camera.reversedDepth ? -depth : depth });
    });
    this.updatePass(this.core, items);
    if (this.fringe === null) return;
    items.sort((a, b) => b.z - a.z || a.source.id - b.source.id);
    this.updatePass(this.fringe, items);
  }

  private updatePass(
    pass: LinePass,
    items: { source: InstanceSource }[],
  ): void {
    const { order } = pass;
    pass.geometry!.instanceCount = items.length * this.numSegments;
    if (
      !pass.needsUpdate &&
      items.length === order.length &&
      items.every(({ source }, i) => source === order[i])
    )
      return;
    pass.needsUpdate = false;
    pass.order = items.map(({ source }) => source);
    for (const [from, to, size] of [
      [this.positions, pass.positions!, this.numSegments * 6],
      [this.colors, pass.colors!, this.numSegments * 6],
      [this.widths, pass.widths!, this.numSegments],
    ] as const) {
      items.forEach(({ source: { batchIndex } }, i) =>
        (to.array as Float32Array).set(
          from.subarray(batchIndex * size, (batchIndex + 1) * size),
          i * size,
        ),
      );
      if (items.length > 0) markRange(to, 0, items.length * size);
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
  /** Sources that are drawn, in order. */
  order: InstanceSource[] = [];
  needsUpdate = true;
  geometry: LineSegmentsGeometry | null = null;
  positions: THREE.InstancedInterleavedBuffer | null = null;
  colors: THREE.InstancedInterleavedBuffer | null = null;
  widths: THREE.InstancedBufferAttribute | null = null;

  constructor(params: LineMaterialParameters) {
    this.material = new LineMaterial({
      color: 0xffffff,
      vertexColors: true,
      dashed: false,
      ...params,
    });
    this.material.fog = true;
    this.material.worldUnits = params.worldUnits ?? false;
    // Each instance has its own width.
    this.material.vertexShader = this.material.vertexShader
      .replace(
        "uniform float linewidth;",
        `attribute float instanceWidth;
        flat varying float vInstanceWidth;
        #define linewidth instanceWidth`,
      )
      .replace(
        "void main() {",
        "void main() {\n vInstanceWidth = instanceWidth;\n",
      );
    this.material.fragmentShader = this.material.fragmentShader.replace(
      "uniform float linewidth;",
      `flat varying float vInstanceWidth;
      #define linewidth vInstanceWidth`,
    );
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
    this.widths = new THREE.InstancedBufferAttribute(
      new Float32Array(numSegments),
      1,
    );
    this.widths.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("instanceWidth", this.widths);
    // Only used for sorting.
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
