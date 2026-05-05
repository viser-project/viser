// @ts-nocheck
import { box3ToArray, BVH, BVHNode, HybridBuilder, onFrustumIntersectionCallback, onFrustumIntersectionLODCallback, onIntersectionCallback, onIntersectionRayCallback, vec3ToArray, WebGLCoordinateSystem } from 'bvh.js';
import { Box3, Matrix4, Raycaster, Sphere, Vector3 } from 'three';
import { LODLevel } from './feature/LOD.js';
import { InstancedMesh2 } from './InstancedMesh2.js';

// TODO getBoxFromSphere updated if change geometry (and create accessor)
// TODO accurateCulling in bvh.js?
// TODO use params in constructor
// TODO: intersectBox optional intersectCallback

/**
 * Parameters for configuring the BVH (Bounding Volume Hierarchy).
 */
export interface BVHParams {
  /**
   * Margin applied to accommodate animated or moving objects.
   * Improves BVH update performance but slows down frustum culling and raycasting.
   * For static objects, set to 0 to optimize culling and raycasting efficiency.
   * @default 0
   */
  margin?: number;
  /**
   * Uses the geometry bounding sphere to compute instance bounding boxes.
   * Otherwise it's calculated by applying the object's matrix to all 8 bounding box points.
   * This is faster but less precise. Useful for moving objects.
   * Only works if the geometry's bounding sphere is centered at the origin.
   * @default false
   */
  getBBoxFromBSphere?: boolean;
  /**
   * Enables accurate frustum culling by checking intersections without applying margin to the bounding box.
   * @default true
   */
  accurateCulling?: boolean;
}

interface SphereTarget {
  centerX: number;
  centerY: number;
  centerZ: number;
  maxScale: number;
}

/**
 * Class to manage BVH (Bounding Volume Hierarchy) for `InstancedMesh2`.
 * Provides methods for managing bounding volumes, frustum culling, raycasting, and bounding box computation.
 */
export class InstancedMeshBVH {
  /**
   * The target `InstancedMesh2` object that the BVH is managing.
   */
  public target: InstancedMesh2;
  /**
   * The geometry bounding box of the target.
   */
  public geoBoundingBox: Box3;
  /**
   * The BVH instance used to organize bounding volumes.
   */
  public bvh: BVH<{}, number>;
  /**
   * A map that stores the BVH nodes for each instance.
   */
  public nodesMap = new Map<number, BVHNode<{}, number>>();
  /**
   * Enables accurate frustum culling by checking intersections without applying margin to the bounding box.
   */
  public accurateCulling: boolean;
  protected LODsMap = new Map<LODLevel[], Float32Array>();
  protected _margin: number;
  protected _origin: Float32Array;
  protected _dir: Float32Array;
  protected _boxArray: Float32Array;
  protected _cameraPos: Float32Array;
  protected _getBoxFromSphere: boolean;
  protected _geoBoundingSphere: Sphere = null;
  protected _sphereTarget: SphereTarget = null;

  /**
   * @param target The target `InstancedMesh2`.
   * @param margin The margin applied for bounding box calculations (default is 0).
   * @param getBBoxFromBSphere Flag to determine if instance bounding boxes should be computed from the geometry bounding sphere. Faster but less precise (default is false).
   * @param accurateCulling Flag to enable accurate frustum culling without considering margin (default is true).
   */
  constructor(target: InstancedMesh2, margin = 0, getBBoxFromBSphere = false, accurateCulling = true) {
    this.target = target;
    this.accurateCulling = accurateCulling;
    this._margin = margin;

    const geometry = target._geometry;

    if (!geometry.boundingBox) geometry.computeBoundingBox();
    this.geoBoundingBox = geometry.boundingBox;

    if (getBBoxFromBSphere) {
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();

      const center = geometry.boundingSphere.center;
      if (center.x === 0 && center.y === 0 && center.z === 0) {
        this._geoBoundingSphere = geometry.boundingSphere;
        this._sphereTarget = { centerX: 0, centerY: 0, centerZ: 0, maxScale: 0 };
      } else {
        console.warn('"getBoxFromSphere" is ignored because geometry is not centered.');
        getBBoxFromBSphere = false;
      }
    }

    this.bvh = new BVH(new HybridBuilder(), WebGLCoordinateSystem);
    this._origin = new Float32Array(3);
    this._dir = new Float32Array(3);
    this._cameraPos = new Float32Array(3);
    this._getBoxFromSphere = getBBoxFromBSphere;
  }

  /**
   * Builds the BVH from the target mesh's instances using a top-down construction method.
   * This approach is more efficient and accurate compared to incremental methods, which add one instance at a time.
   */
  public create(): void {
    const count = this.target._instancesCount;
    const instancesArrayCount = this.target._instancesArrayCount;
    const boxes: Float32Array[] = new Array(count); // test if single array and recreation inside node creation is faster due to memory location
    const objects = new Uint32Array(count);
    let index = 0;

    this.clear();

    for (let i = 0; i < instancesArrayCount; i++) {
      if (!this.target.getActiveAt(i)) continue;
      boxes[index] = this.getBox(i, new Float32Array(6));
      objects[index] = i;
      index++;
    }

    this.bvh.createFromArray(objects as unknown as number[], boxes, (node) => {
      this.nodesMap.set(node.object, node);
    }, this._margin);
  }

  /**
   * Inserts an instance into the BVH.
   * @param id The id of the instance to insert.
   */
  public insert(id: number): void {
    const node = this.bvh.insert(id, this.getBox(id, new Float32Array(6)), this._margin);
    this.nodesMap.set(id, node);
  }

  /**
   * Inserts a range of instances into the BVH.
   * @param ids An array of ids to insert.
   */
  public insertRange(ids: number[]): void {
    const count = ids.length;
    const boxes: Float32Array[] = new Array(count);

    for (let i = 0; i < count; i++) {
      boxes[i] = this.getBox(ids[i], new Float32Array(6));
    }

    this.bvh.insertRange(ids, boxes, this._margin, (node) => {
      this.nodesMap.set(node.object, node);
    });
  }

  /**
   * Moves an instance within the BVH.
   * @param id The id of the instance to move.
   */
  public move(id: number): void {
    const node = this.nodesMap.get(id);
    if (!node) return;
    this.getBox(id, node.box as Float32Array); // this also updates box
    this.bvh.move(node, this._margin);
  }

  /**
   * Deletes an instance from the BVH.
   * @param id The id of the instance to delete.
   */
  public delete(id: number): void {
    const node = this.nodesMap.get(id);
    if (!node) return;
    this.bvh.delete(node);
    this.nodesMap.delete(id);
  }

  /**
   * Clears the BVH.
   */
  public clear(): void {
    this.bvh.clear();
    this.nodesMap.clear();
  }

  /**
   * Performs frustum culling to determine which instances are visible based on the provided projection matrix.
   * @param projScreenMatrix The projection screen matrix for frustum culling.
   * @param onFrustumIntersection Callback function invoked when an instance intersects the frustum.
   * @param reversedDepth Whether the renderer uses a reversed depth buffer.
   */
  public frustumCulling(projScreenMatrix: Matrix4, onFrustumIntersection: onFrustumIntersectionCallback<{}, number>, reversedDepth = false): void {
    if (reversedDepth) {
      this._enableReversedDepthFrustum(projScreenMatrix);
    }

    if (this._margin > 0 && this.accurateCulling) {
      this.bvh.frustumCulling(projScreenMatrix.elements, (node, frustum, mask) => {
        if (frustum.isIntersectedMargin(node.box, mask, this._margin)) {
          onFrustumIntersection(node);
        }
      });
    } else {
      this.bvh.frustumCulling(projScreenMatrix.elements, onFrustumIntersection);
    }

    if (reversedDepth) {
      this._disableReversedDepthFrustum();
    }
  }

  /**
   * Performs frustum culling with Level of Detail (LOD) consideration.
   * @param projScreenMatrix The projection screen matrix for frustum culling.
   * @param cameraPosition The camera's position used for LOD calculations.
   * @param levels An array of LOD levels.
   * @param onFrustumIntersection Callback function invoked when an instance intersects the frustum.
   * @param reversedDepth Whether the renderer uses a reversed depth buffer.
   */
  public frustumCullingLOD(projScreenMatrix: Matrix4, cameraPosition: Vector3, levels: LODLevel[], onFrustumIntersection: onFrustumIntersectionLODCallback<{}, number>, reversedDepth = false): void {
    if (!this.LODsMap.has(levels)) {
      this.LODsMap.set(levels, new Float32Array(levels.length));
    }

    const levelsArray = this.LODsMap.get(levels);
    for (let i = 0; i < levels.length; i++) {
      levelsArray[i] = levels[i].distance;
    }

    const camera = this._cameraPos;
    camera[0] = cameraPosition.x;
    camera[1] = cameraPosition.y;
    camera[2] = cameraPosition.z;

    if (reversedDepth) {
      this._enableReversedDepthFrustum(projScreenMatrix);
    }

    if (this._margin > 0 && this.accurateCulling) {
      this.bvh.frustumCullingLOD(projScreenMatrix.elements, camera, levelsArray, (node, level, frustum, mask) => {
        if (frustum.isIntersectedMargin(node.box, mask, this._margin)) {
          onFrustumIntersection(node, level);
        }
      });
    } else {
      this.bvh.frustumCullingLOD(projScreenMatrix.elements, camera, levelsArray, onFrustumIntersection);
    }

    if (reversedDepth) {
      this._disableReversedDepthFrustum();
    }
  }

  /**
   * Performs raycasting to check if a ray intersects any instances.
   * @param raycaster The raycaster used for raycasting.
   * @param onIntersection Callback function invoked when a ray intersects an instance.
   */
  public raycast(raycaster: Raycaster, onIntersection: onIntersectionRayCallback<number>): void {
    const ray = raycaster.ray;
    const origin = this._origin;
    const dir = this._dir;

    vec3ToArray(ray.origin, origin);
    vec3ToArray(ray.direction, dir);

    // TODO should we add margin check? maybe is not worth it
    this.bvh.rayIntersections(dir, origin, onIntersection, raycaster.near, raycaster.far);
  }

  /**
   * Checks if a given box intersects with any instance bounding box.
   * @param target The target bounding box.
   * @param onIntersection Callback function invoked when an intersection occurs.
   * @returns `True` if there is an intersection, otherwise `false`.
   */
  public intersectBox(target: Box3, onIntersection: onIntersectionCallback<number>): boolean {
    if (!this._boxArray) this._boxArray = new Float32Array(6);
    const array = this._boxArray;
    box3ToArray(target, array);
    return this.bvh.intersectsBox(array, onIntersection);
  }

  protected getBox(id: number, array: Float32Array): Float32Array {
    if (this._getBoxFromSphere) {
      const matrixArray = this.target.matricesTexture._data as Float32Array;
      const { centerX, centerY, centerZ, maxScale } = this.getSphereFromMatrix_centeredGeometry(id, matrixArray, this._sphereTarget);
      const radius = this._geoBoundingSphere.radius * maxScale;
      array[0] = centerX - radius;
      array[1] = centerX + radius;
      array[2] = centerY - radius;
      array[3] = centerY + radius;
      array[4] = centerZ - radius;
      array[5] = centerZ + radius;
    } else {
      _box3.copy(this.geoBoundingBox).applyMatrix4(this.target.getMatrixAt(id));
      box3ToArray(_box3, array);
    }

    return array;
  }

  protected getSphereFromMatrix_centeredGeometry(id: number, array: Float32Array, target: SphereTarget): SphereTarget {
    const offset = id * 16;

    const m0 = array[offset + 0];
    const m1 = array[offset + 1];
    const m2 = array[offset + 2];
    const m4 = array[offset + 4];
    const m5 = array[offset + 5];
    const m6 = array[offset + 6];
    const m8 = array[offset + 8];
    const m9 = array[offset + 9];
    const m10 = array[offset + 10];

    const scaleXSq = m0 * m0 + m1 * m1 + m2 * m2;
    const scaleYSq = m4 * m4 + m5 * m5 + m6 * m6;
    const scaleZSq = m8 * m8 + m9 * m9 + m10 * m10;

    target.maxScale = Math.sqrt(Math.max(scaleXSq, scaleYSq, scaleZSq));

    target.centerX = array[offset + 12];
    target.centerY = array[offset + 13];
    target.centerZ = array[offset + 14];

    return target;
  }

  /**
   * Monkey-patch bvh.js frustum's setFromProjectionMatrix to fix near/far
   * planes for reversed depth buffers. Called before bvh.frustumCulling so the
   * internal call to setFromProjectionMatrix produces correct planes.
   */
  private _origSetFromProjectionMatrix: ((mat: ArrayLike<number>) => any) | null = null;

  protected _enableReversedDepthFrustum(_projScreenMatrix: Matrix4): void {
    const frustum = this.bvh.frustum;
    this._origSetFromProjectionMatrix = frustum.setFromProjectionMatrix.bind(frustum);

    frustum.setFromProjectionMatrix = (mat: ArrayLike<number>) => {
      // Let bvh.js do its standard plane extraction for planes 0-3 first.
      this._origSetFromProjectionMatrix!(mat);
      const arr = frustum.array;

      // Recompute plane 4 (far) for reversed depth: (mat[2], mat[6], mat[10], mat[14])
      let x = mat[2], y = mat[6], z = mat[10], w = mat[14];
      let len = Math.sqrt(x * x + y * y + z * z);
      arr[16] = x / len; arr[17] = y / len; arr[18] = z / len; arr[19] = w / len;

      // Recompute plane 5 (near) for reversed depth: (mat[3]-mat[2], mat[7]-mat[6], mat[11]-mat[10], mat[15]-mat[14])
      x = mat[3] - mat[2]; y = mat[7] - mat[6]; z = mat[11] - mat[10]; w = mat[15] - mat[14];
      len = Math.sqrt(x * x + y * y + z * z);
      arr[20] = x / len; arr[21] = y / len; arr[22] = z / len; arr[23] = w / len;

      return frustum;
    };
  }

  protected _disableReversedDepthFrustum(): void {
    if (this._origSetFromProjectionMatrix) {
      this.bvh.frustum.setFromProjectionMatrix = this._origSetFromProjectionMatrix;
      this._origSetFromProjectionMatrix = null;
    }
  }
}

const _box3 = new Box3();
